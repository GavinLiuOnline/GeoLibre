/**
 * 场景包发布（multipart 一站式）：POST /api/scenes/publish-package
 *
 * 与 publishScene 的核心区别：
 * - publishScene 是「引用型发布」：场景文档里的 source.kind='assetId'，
 *   复用服务端已上传的资产（glb/zip/tiles...），不携带 zip；
 * - publishScenePackage 是「托管型发布」：编辑器把本地缓存 zip（XYZ 瓦片树 /
 *   3D Tiles 数据集）和零散资产（glb/geojson...）连同场景文档一次性 POST 上来，
 *   服务端解包到 /published/<slug>/...，并把场景里 source.kind='url' 的本地缓存
 *   图层（tiles / 3dtiles）改写为服务端 URL，写入 /published/<slug>/scene.json。
 *
 * 产物：
 * - /published/<slug>/scene.json          托管版 SceneDocument（source 已改写）
 * - /published/<slug>/tiles/{z}/{x}/{y}.ext   XYZ 瓦片（每个 xyz bundle 一份）
 * - /published/<slug>/tileset.json        3D Tiles tileset（每个 3dtiles bundle 一份或合并）
 * - /published/<slug>/models/<file>       零散资产
 * - /published/<slug>/manifest.json       PublishManifest
 *
 * 鉴权：当 AUTH_TOKEN 设置时校验 Bearer；场景/服务 createdBy 取 AUTH_USER（默认 anonymous）。
 */

import fs from 'node:fs';
import path from 'node:path';

import AdmZip from 'adm-zip';
import type {
  PublishArtifact,
  PublishArtifactKind,
  PublishManifest,
  SceneDocument,
  SceneLayer,
  SceneLayerSource,
} from '@geolibre/gis-shared';

import { PUBLISHED_DIR, assertSafeSlug, ensureDataDirs } from './storage.js';
import { entryFromManifest, upsertService } from './registry.js';
import { HttpError } from '../util/http.js';

interface BundleEntry {
  /** FormData 字段名，例如 bundles[<layerId>] */
  field: string;
  /** 原始文件名 */
  filename: string;
  /** 落盘到 TMP_DIR 的临时文件路径 */
  tmpPath: string;
  /** 解析后的 {layerId, kind} */
  meta: { layerId: string; kind: 'xyz' | '3dtiles' };
}

interface AssetEntry {
  field: string;
  filename: string;
  tmpPath: string;
}

export interface PublishPackageInput {
  scene: SceneDocument;
  bundles: BundleEntry[];
  assets: AssetEntry[];
}

export interface PublishPackageOutcome {
  manifest: PublishManifest;
  hostedScene: SceneDocument;
  hostedSceneUrl: string;
}

// ---------------------------------------------------------------------------
// zip 安全/工具（与 publish.ts 共用语义，独立实现避免循环依赖）
// ---------------------------------------------------------------------------

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\3\4

/**
 * 文件条目路径安全校验（zip-slip：绝对路径 / 盘符 / '..' 段 / 空段）。
 *
 * 注意：本函数只应作用于「文件条目」——目录条目（entryName 以 '/' 结尾）由调用方
 * 先行跳过（t15 回归）：JSZip / 系统压缩工具会对嵌套文件自动生成目录条目，
 * 其尾斜杠在本函数的空段检查下会被误判为非法路径，导致正常缓存 zip 一律被拒。
 * 目录条目的提取安全性由 adm-zip 的路径净化兜底（'../' 目录条目亦被拦在目标目录内）。
 */
function isUnsafeEntryName(entryName: string): boolean {
  if (!entryName) return true;
  if (entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) return true;
  const segments = entryName.split(/[/\\]/);
  return segments.some((seg) => seg === '..' || seg === '');
}

function safeStem(id: string): string {
  return id.replace(/[^\w-]+/g, '-') || 'layer';
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function cleanupJunk(dir: string): void {
  const junk = path.join(dir, '__MACOSX');
  if (fs.existsSync(junk)) fs.rmSync(junk, { recursive: true, force: true });
}

/** 解压后若存在唯一根目录则逐级拍平（XYZ zip 常见结构：单链目录可安全拍平） */
function collapseSingleRootDir(dir: string): void {
  for (let guard = 0; guard < 5; guard++) {
    const entries = fs.readdirSync(dir);
    if (entries.length !== 1) return;
    const only = path.join(dir, entries[0]);
    if (!fs.statSync(only).isDirectory()) return;
    // 目录重名（如 tiles-cache/0/0/0.png 里的 0 与 0）不能 rename，合并内容
    mergeDirInto(only, dir);
  }
}

/** 把 sub 的内容并入 dest（同名文件覆盖、同名目录递归合并），随后删除 sub */
function mergeDirInto(sub: string, dest: string): void {
  for (const entry of fs.readdirSync(sub)) {
    const src = path.join(sub, entry);
    const target = path.join(dest, entry);
    if (!fs.existsSync(target)) {
      fs.renameSync(src, target);
      continue;
    }
    if (fs.statSync(src).isDirectory() && fs.statSync(target).isDirectory()) {
      mergeDirInto(src, target);
      continue;
    }
    // 同名文件/类型冲突：重复解包场景，以迁移过来的为准
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(src, target);
  }
  // 递归删除：同名目录合并后 sub 内可能仍有未迁移内容（例如子目录被合并掉的情况）
  fs.rmSync(sub, { recursive: true, force: true });
}

const TILE_EXT_RE = /^(png|jpe?g|webp|pbf|avif)$/i;

/**
 * XYZ 瓦片根定位：把「包了一层目录（rootDir/…）」或「多一个顶层目录乱入」的
 * zip 重新对齐到 {z}/{x}/{y}.ext 根目录。
 *
 * 为什么需要：编辑器 `zipCacheBundle` 产出的是 `{z}/{x}/{y}.ext`（去掉根目录），
 * 但 `wrapZipWithRootDir` / 直接上传目录 zip 会保留 rootDir 一层；
 * 服务端发布包固定托管为 /published/<slug>/tiles/<layerId>/{z}/{x}/{y}.ext，
 * 所以必须把外层目录去掉，否则 URL 模板对不上真实文件。
 *
 * 判定依据（只认可靠结构，避免误删真实数据）：
 * - 相对路径形如 `<z>/<x>/<y>.<ext>`，z/x/y 均为纯数字，ext 为瓦片后缀；
 * - 取**最浅**的满足「path[0] 与 path[1] 均为数字且存在瓦片文件」的目录作为新根，
 *   候选目录层级差至少 1 才会真正搬移。
 */
function findXyzRoot(dir: string): string {
  interface Candidate {
    rel: string;
    depth: number;
  }
  let best: Candidate | null = null;
  const walk = (current: string, relParts: string[], depth: number): void => {
    if (depth > 6) return;
    let hasTile = false;
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full, [...relParts, entry], depth + 1);
        continue;
      }
      if (relParts.length >= 3 && TILE_EXT_RE.test(path.extname(entry))) {
        const last = relParts[relParts.length - 1];
        const prev = relParts[relParts.length - 2];
        if (/^\d+$/.test(last) && /^\d+$/.test(prev)) hasTile = true;
      }
    }
    if (hasTile && relParts.length > 0) {
      const cand: Candidate = { rel: relParts.join('/'), depth: relParts.length };
      if (!best || cand.depth < best.depth) best = cand;
    }
  };
  walk(dir, [], 0);
  if (!best) return dir;
  const bestCand = best as Candidate;
  return path.join(dir, ...bestCand.rel.split('/'));
}

/** 把 src 下的全部条目搬到 dest（同名递归合并、文件覆盖） */
function moveEntries(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry);
    const target = path.join(dest, entry);
    if (!fs.existsSync(target)) {
      fs.renameSync(from, target);
      continue;
    }
    if (fs.statSync(from).isDirectory() && fs.statSync(target).isDirectory()) {
      mergeDirInto(from, target);
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(from, target);
  }
}

/**
 * 把 XYZ 瓦片内容对齐到 dest 根：先搬到临时目录，再清掉原外层目录，最后落回 dest。
 * 走临时目录是为了避免「目标根已有同名目录」时把内容搬进旧结构的歧义。
 */
function alignXyzRoot(dest: string, xyzRoot: string): void {
  const topDir = xyzRoot.slice(dest.length + 1).split(path.sep)[0];
  const staleDir = topDir ? path.join(dest, topDir) : undefined;
  const staging = `${dest}.xyz-staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  moveEntries(xyzRoot, staging);
  if (staleDir && path.resolve(staleDir) !== path.resolve(staging)) {
    fs.rmSync(staleDir, { recursive: true, force: true });
  }
  moveEntries(staging, dest);
  fs.rmSync(staging, { recursive: true, force: true });
}

function detectTileExt(tilesDir: string): string {
  const counts = new Map<string, number>();
  const allowed = new Set(['png', 'jpg', 'jpeg', 'webp', 'pbf', 'avif']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (stat.isFile()) {
        const ext = path.extname(entry).replace(/^\./, '').toLowerCase();
        if (allowed.has(ext)) counts.set(ext, (counts.get(ext) ?? 0) + 1);
      }
    }
  };
  walk(tilesDir, 0);
  let best = 'png';
  let bestCount = 0;
  for (const [ext, count] of counts) {
    if (count > bestCount) {
      best = ext;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// slug
// ---------------------------------------------------------------------------

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * 场景包发布 slug：<name-slugified>-<短id前8>。同场景重复发布覆盖同 slug。
 * 相比 publishScene，不要求 doc.id 已存在（编辑器可能未先存场景）；缺省走 randomUUID 兜底。
 */
function resolveSlug(doc: SceneDocument): string {
  const sceneId = doc.id ?? '';
  const shortId = sceneId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'pkg';
  const base = slugifyName(doc.name) || 'scene';
  const preferred = `${base}-${shortId}`;
  const candidate = path.join(PUBLISHED_DIR, preferred);
  if (!fs.existsSync(candidate)) return preferred;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(candidate, 'manifest.json'), 'utf8'),
    ) as PublishManifest;
    if (manifest.sceneId === sceneId) return preferred;
  } catch {
    // 损坏 → 走冲突兜底
  }
  for (let i = 2; i < 100; i++) {
    const alt = `${preferred}-${i}`;
    if (!fs.existsSync(path.join(PUBLISHED_DIR, alt))) return alt;
  }
  throw new HttpError(500, '无法分配发布 slug');
}

// ---------------------------------------------------------------------------
// bundle 解包
// ---------------------------------------------------------------------------

interface BundleOutcome {
  /** 发布包内相对路径（用于 SceneDocument 改写） */
  hostedRelPath: string;
  /** 对应图层的产物 url（XYZ 模板或 tileset.json） */
  artifactUrl: string;
  /** 产物类型 */
  artifactKind: PublishArtifactKind;
  /** 产物显示名（用于 PublishArtifact.name） */
  artifactName: string;
  /** 文件格式（png / json...） */
  artifactFormat?: string;
  /** 若本 bundle 提供了 tileset.json 顶层入口，登记便于合并顶层 wrapper */
  tilesetEntryRel?: string;
}

function unpackBundle(
  bundle: BundleEntry,
  outDir: string,
  base: string,
  layer: SceneLayer,
): BundleOutcome {
  const bytes = fs.readFileSync(bundle.tmpPath);
  if (!bytes.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new HttpError(400, `bundle ${bundle.meta.layerId}: 不是有效的 zip 文件`);
  }
  const zip = new AdmZip(bytes);
  const entries = zip.getEntries();
  // 目录条目（名称以 '/' 结尾）不参与校验、不视为非法：JSZip 等工具对嵌套文件
  // 自动生成目录条目，正常缓存 zip 不应因此被拒（t15 回归）。zip-slip 校验仅对
  // 真实文件条目保留；目录条目的提取安全由 adm-zip 路径净化兜底，文件条目解包时
  // 自会隐式创建父目录。
  const fileEntries = entries.filter((entry) => !entry.isDirectory);
  if (fileEntries.some((entry) => isUnsafeEntryName(entry.entryName))) {
    throw new HttpError(400, `bundle ${bundle.meta.layerId}: zip 包含非法路径条目，已拒绝解压`);
  }

  if (bundle.meta.kind === 'xyz') {
    const stem = safeStem(bundle.meta.layerId);
    const dest = path.join(outDir, 'tiles', stem);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    zip.extractAllTo(dest, true);
    cleanupJunk(dest);
    collapseSingleRootDir(dest);
    // 兼容「保留了 rootDir 外层目录」的 zip（例如 rootDir 下只有 0/0/0.png
    // 这类单链结构，collapse 无法安全拍平）：按 {z}/{x}/{y} 结构重新对齐根目录。
    const xyzRoot = findXyzRoot(dest);
    if (path.resolve(xyzRoot) !== path.resolve(dest)) {
      alignXyzRoot(dest, xyzRoot);
    }
    const ext = detectTileExt(dest);
    const url = `${base}/tiles/${stem}/{z}/{x}/{y}.${ext}`;
    return {
      hostedRelPath: `tiles/${stem}/{z}/{x}/{y}.${ext}`,
      artifactUrl: url,
      artifactKind: 'tiles',
      artifactName: layer.name ?? `tiles/${stem}`,
      artifactFormat: ext,
    };
  }

  // kind === '3dtiles'
  const stem = safeStem(bundle.meta.layerId);
  const dest = path.join(outDir, 'tilesets', stem);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  zip.extractAllTo(dest, true);
  cleanupJunk(dest);

  // 定位 tileset.json（最短路径优先，跳过 __MACOSX）
  const tilesetEntry = entries
    .filter((e) => !e.isDirectory && /(^|\/)tileset\.json$/i.test(e.entryName))
    .filter((e) => !/^__MACOSX\//i.test(e.entryName))
    .sort((a, b) => a.entryName.length - b.entryName.length)[0];

  let hostedRelPath: string;
  if (tilesetEntry) {
    // 解压后保留 zip 内目录结构（其它 b3dm/i3dm 相对路径不变）
    hostedRelPath = `tilesets/${stem}/${tilesetEntry.entryName.split('\\').join('/')}`;
  } else {
    // 兜底：解压根目录第一层即是 tileset.json（容错：解压后扫描）
    const found = findTilesetJson(dest);
    if (!found) {
      throw new HttpError(400, `bundle ${bundle.meta.layerId}: 3D Tiles zip 内未找到 tileset.json`);
    }
    hostedRelPath = `tilesets/${stem}/${path.posix.join(...found.parts)}`;
  }

  // 提升 tileset.json 到 /tilesets/<stem>/ 根，便于：1) 顶层 scene.json 引用稳定；
  // 2) tileset.json 的 content.uri 相对路径仍指向同目录 b3dm，无需修改。
  // 注意：tileset.json 的 content.uri 在 zip 内原本就是相对于其自身目录，
  // 解压到 /tilesets/<stem>/ 后保持原目录结构即等价于保留相对路径。
  const finalTilesetPath = path.join(outDir, hostedRelPath);
  if (!fs.existsSync(finalTilesetPath)) {
    throw new HttpError(500, `bundle ${bundle.meta.layerId}: 解压后无法定位 tileset.json`);
  }
  return {
    hostedRelPath,
    artifactUrl: `${base}/${hostedRelPath}`,
    artifactKind: 'tileset',
    artifactName: layer.name ?? `tileset/${stem}`,
    artifactFormat: 'json',
  };
}

// 解压目录向下递归找 tileset.json（按路径最短优先）
function findTilesetJson(
  dir: string,
  parts: string[] = [],
): { parts: string[]; fullPath: string } | null {
  let best: { parts: string[]; fullPath: string } | null = null;
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '__MACOSX') continue;
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      const child = findTilesetJson(full, [...parts, entry]);
      if (child && (!best || child.parts.length < best.parts.length)) {
        best = child;
      }
    } else if (/^tileset\.json$/i.test(entry)) {
      const cand = { parts: [...parts, entry], fullPath: full };
      if (!best || cand.parts.length < best.parts.length) best = cand;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 托管版 SceneDocument：把 bundle 对应图层 source 改写为服务端 URL
// ---------------------------------------------------------------------------

function rewriteHostedScene(
  scene: SceneDocument,
  layersById: Map<string, BundleOutcome>,
  base: string,
): SceneDocument {
  const layers = (scene.layers ?? []).map((layer) => {
    const outcome = layersById.get(layer.id);
    if (!outcome) return layer;
    const next: SceneLayer = {
      ...layer,
      source: rewriteLayerSource(layer.source, outcome.hostedRelPath, base),
    };
    return next;
  });
  return {
    ...scene,
    layers,
  };
}

function rewriteLayerSource(
  source: SceneLayerSource,
  hostedRelPath: string,
  base: string,
): SceneLayerSource {
  // 把"本地缓存图层"统一改写为服务端 URL：XYZ 用模板（{z}/{x}/{y}），
  // 3D Tiles 指向 /published/<slug>/tilesets/<layer>/.../tileset.json。
  // 这里用完整服务端 URL（带 /published/<slug>/ 前缀），编辑器加载时无需再拼。
  void source;
  return { kind: 'url', url: `${base}/${hostedRelPath}` };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export function publishPackage(input: PublishPackageInput, createdBy?: string): PublishPackageOutcome {
  ensureDataDirs();
  const doc = input.scene;
  if (!doc || typeof doc !== 'object' || typeof doc.name !== 'string') {
    throw new HttpError(400, '缺少有效的场景文档（scene 字段）');
  }

  // 校验：每个 bundle 必须对应一个图层
  const layersById = new Map<string, SceneLayer>();
  for (const layer of doc.layers ?? []) {
    layersById.set(layer.id, layer);
  }
  for (const bundle of input.bundles) {
    if (!layersById.has(bundle.meta.layerId)) {
      throw new HttpError(400, `bundle ${bundle.meta.layerId}: 场景中找不到对应图层 id`);
    }
    if (!['xyz', '3dtiles'].includes(bundle.meta.kind)) {
      throw new HttpError(400, `bundle ${bundle.meta.layerId}: kind 必须为 'xyz' 或 '3dtiles'`);
    }
  }

  const slug = resolveSlug(doc);
  assertSafeSlug(slug);
  const outDir = path.join(PUBLISHED_DIR, slug);
  const base = `/published/${slug}`;

  // 清理旧产物
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const artifacts: PublishArtifact[] = [];
  const bundleOutcomes = new Map<string, BundleOutcome>();

  // 处理 bundles
  for (const bundle of input.bundles) {
    const layer = layersById.get(bundle.meta.layerId)!;
    try {
      const outcome = unpackBundle(bundle, outDir, base, layer);
      bundleOutcomes.set(bundle.meta.layerId, outcome);
      artifacts.push({
        kind: outcome.artifactKind,
        url: outcome.artifactUrl,
        name: outcome.artifactName,
        format: outcome.artifactFormat,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[publishPackage] bundle ${bundle.meta.layerId} 解包失败: ${message}`);
      throw err; // 任一 bundle 失败 → 整包失败（数据完整性优先）
    } finally {
      // 清理临时文件
      try {
        fs.rmSync(bundle.tmpPath, { force: true });
      } catch {
        /* noop */
      }
    }
  }

  // 处理零散 assets（落到 /models/）
  for (const asset of input.assets) {
    try {
      const dest = path.join(outDir, 'models', asset.filename);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(asset.tmpPath, dest);
      try {
        fs.rmSync(asset.tmpPath, { force: true });
      } catch {
        /* noop */
      }
      const ext = path.extname(asset.filename).replace(/^\./, '').toLowerCase();
      let kind: PublishArtifactKind = 'glb';
      if (ext === 'geojson' || ext === 'json') kind = 'geojson';
      else if (ext === 'glb' || ext === 'gltf') kind = 'glb';
      artifacts.push({
        kind,
        url: `${base}/models/${asset.filename}`,
        name: asset.filename,
        format: ext,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[publishPackage] asset ${asset.filename} 落盘失败: ${message}`);
    }
  }

  // 生成托管版 SceneDocument（source 已改写为服务端 URL；保留原 doc 的 id/createdAt/createdBy 等元数据）
  const hostedScene = rewriteHostedScene(doc, bundleOutcomes, base);
  const now = new Date().toISOString();
  const sceneId = doc.id ?? '';
  const enrichedScene: SceneDocument = {
    ...hostedScene,
    id: sceneId || hostedScene.id,
    createdAt: hostedScene.createdAt ?? doc.createdAt ?? now,
    updatedAt: now,
  };
  writeJson(path.join(outDir, 'scene.json'), enrichedScene);

  // 写 manifest（route handler 会再覆盖一次以写入 stable sceneId）
  const manifest: PublishManifest = {
    sceneId,
    slug,
    name: doc.name,
    publishedAt: now,
    artifacts,
  };
  writeJson(path.join(outDir, 'manifest.json'), manifest);

  // 顶层 tileset 引用：当存在多个 3dtiles bundle 时，给编辑器一个统一入口
  // 当前每个 bundle 单独托管一份 tileset.json；scene.json 已记录每个 bundle 的 URL。
  // 不强制合成顶层 tileset：编辑器按 layer.source.url 加载即可。

  // 注册到服务注册表
  const entry = entryFromManifest(manifest, doc.name);
  if (createdBy) {
    (entry as { createdBy?: string }).createdBy = createdBy;
  }
  upsertService(entry);

  // 清理残留 bundle/asset 临时文件（防御性）
  for (const bundle of input.bundles) {
    try {
      fs.rmSync(bundle.tmpPath, { force: true });
    } catch {
      /* noop */
    }
  }
  for (const asset of input.assets) {
    try {
      fs.rmSync(asset.tmpPath, { force: true });
    } catch {
      /* noop */
    }
  }

  return {
    manifest,
    hostedScene: enrichedScene,
    hostedSceneUrl: `${base}/scene.json`,
  };
}
