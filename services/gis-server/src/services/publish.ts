/**
 * 发布服务：把场景文档生成为静态发布包 data/published/<slug>/。
 *
 * - 二维：内嵌/引用的 GeoJSON 落盘为 data/<layerId>.geojson；
 *   瓦片 zip 解压后按 XYZ 路径 tiles/{z}/{x}/{y}.<ext> 托管；
 *   imagery 图层的 XYZ 模板 URL 原样登记为 tiles 产物。
 * - 三维：GLB/glTF 资产生成 3D Tiles 1.1 tileset.json（含 geolocation 时写入
 *   ENU→ECEF transform），content.uri 指向发布包内模型文件；
 *   zip 内已含 tileset.json 的 3D Tiles 包原样托管。
 * - 汇总 manifest.json（PublishManifest），发布 URL 一律为服务端根相对路径。
 */

import fs from 'node:fs';
import path from 'node:path';

import AdmZip from 'adm-zip';
import type {
  PublishArtifact,
  PublishManifest,
  PublishArtifactKind,
  SceneDocument,
  SceneLayer,
  ServiceEntry,
} from '@geolibre/gis-shared';

import { enuToFixedFrame } from './geo.js';
import {
  PUBLISHED_DIR,
  assertSafeSlug,
  ensureDataDirs,
  resolveAssetFile,
  resolveAssetUrl,
} from './storage.js';
import { entryFromManifest, findServiceByAssetId, listServices, upsertService } from './registry.js';
import { HttpError } from '../util/http.js';

const GLOBE_REGION = [-Math.PI, -Math.PI / 2, 0, Math.PI, Math.PI / 2, 6500000];
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\3\4"
const GLB_MAGIC = Buffer.from('glTF', 'ascii');

interface ModelEntry {
  layerId: string;
  name: string;
  /** 发布包内相对 tileset.json 的模型地址 */
  uri: string;
  /** ENU→ECEF 变换（列主序 4x4），无 geolocation 时缺省 */
  matrix?: number[];
}

type LayerPayload =
  | { kind: 'text'; text: string; ext: 'geojson' | 'json' }
  | { kind: 'zip'; bytes: Buffer }
  | { kind: 'model'; bytes: Buffer; ext: 'glb' | 'gltf' }
  | { kind: 'passthrough-url'; url: string };

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
    .replace(/-+$/g, '');
}

/**
 * slug 规则（固定透明）：<场景名 slugified>-<场景短id 前8位>。
 * 同一场景重复发布覆盖同一 slug（服务地址稳定）；理论上短 id 已保证唯一，
 * 兜底再检查目录冲突并递增后缀，绝不覆盖其他场景的服务。
 */
function resolveSlug(doc: SceneDocument): string {
  const sceneId = doc.id ?? '';
  const shortId = sceneId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'scene';
  const base = slugifyName(doc.name) || 'scene';
  const preferred = `${base}-${shortId}`;
  const candidate = path.join(PUBLISHED_DIR, preferred);
  if (!fs.existsSync(candidate)) return preferred;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'manifest.json'), 'utf8')) as PublishManifest;
    if (manifest.sceneId === sceneId) return preferred; // 同场景重复发布 → 覆盖
  } catch {
    // 清单损坏 → 按冲突处理
  }
  for (let i = 2; i < 100; i++) {
    const alt = `${preferred}-${i}`;
    if (!fs.existsSync(path.join(PUBLISHED_DIR, alt))) return alt;
  }
  throw new HttpError(500, '无法分配发布 slug');
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function safeStem(id: string): string {
  return id.replace(/[^\w-]+/g, '-') || 'layer';
}

function isUnsafeEntryName(entryName: string): boolean {
  if (entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) return true;
  return entryName.split('/').some((seg) => seg === '..');
}

function cleanupJunk(dir: string): void {
  const junk = path.join(dir, '__MACOSX');
  if (fs.existsSync(junk)) fs.rmSync(junk, { recursive: true, force: true });
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/** 解压后若存在唯一根目录则拍平，保证 XYZ 位于 tiles/ 直下 */
function collapseSingleRootDir(dir: string): void {
  for (let guard = 0; guard < 5; guard++) {
    const entries = fs.readdirSync(dir);
    if (entries.length !== 1) return;
    const only = path.join(dir, entries[0]);
    if (!fs.statSync(only).isDirectory()) return;
    for (const child of fs.readdirSync(only)) {
      fs.renameSync(path.join(only, child), path.join(dir, child));
    }
    fs.rmdirSync(only);
  }
}

/** 统计 tiles/ 下最常见瓦片扩展名（默认 png） */
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
// 图层数据源 → 可发布载荷
// ---------------------------------------------------------------------------

function extOf(filename: string): string {
  return path.extname(filename).replace(/^\./, '').toLowerCase();
}

function payloadFromFile(filePath: string, filename: string, layer: SceneLayer): LayerPayload | null {
  const ext = extOf(filename);
  if (ext === 'zip') return { kind: 'zip', bytes: fs.readFileSync(filePath) };
  if (ext === 'glb') return { kind: 'model', bytes: fs.readFileSync(filePath), ext: 'glb' };
  if (ext === 'gltf') return { kind: 'model', bytes: fs.readFileSync(filePath), ext: 'gltf' };
  if (ext === 'geojson' || ext === 'json') {
    const text = fs.readFileSync(filePath, 'utf8');
    return { kind: 'text', text, ext };
  }
  return null; // kml 等暂不参与发布
}

function payloadFromBytes(bytes: Buffer, layer: SceneLayer): LayerPayload | null {
  if (bytes.subarray(0, 4).equals(ZIP_MAGIC)) return { kind: 'zip', bytes };
  if (bytes.subarray(0, 4).equals(GLB_MAGIC)) return { kind: 'model', bytes, ext: 'glb' };
  const text = bytes.toString('utf8');
  try {
    JSON.parse(text);
    return { kind: 'text', text, ext: 'json' };
  } catch {
    return null;
  }
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`远程数据请求失败 ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resolveLayerPayload(layer: SceneLayer): Promise<LayerPayload | null> {
  const { source } = layer;

  if (source.kind === 'inline') {
    if (layer.features === undefined || layer.features === null) return null;
    return { kind: 'text', text: JSON.stringify(layer.features), ext: 'geojson' };
  }

  if (source.kind === 'assetId') {
    const asset = resolveAssetFile(source.assetId ?? '', source.filename);
    if (!asset) return null;
    return payloadFromFile(asset.filePath, asset.filename, layer);
  }

  // kind === 'url'
  const url = source.url ?? '';
  if (!url) return null;
  if (url.startsWith('/assets/')) {
    const asset = resolveAssetUrl(url);
    if (!asset) return null;
    return payloadFromFile(asset.filePath, asset.filename, layer);
  }
  if (/^https?:\/\//i.test(url)) {
    // 远程瓦片/地形/3D Tiles 模板：直接按 URL 登记，不下载
    if (layer.type === 'imagery' || layer.type === '3dtiles') {
      return { kind: 'passthrough-url', url };
    }
    const bytes = await fetchBytes(url);
    return payloadFromBytes(bytes, layer);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 各类载荷处理
// ---------------------------------------------------------------------------

function addTextArtifact(
  layer: SceneLayer,
  payload: Extract<LayerPayload, { kind: 'text' }>,
  outDir: string,
  base: string,
  artifacts: PublishArtifact[],
): void {
  let text = payload.text;
  if (payload.ext === 'json') {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      // tileset.json 误挂在 geojson 图层时按 3D Tiles 处理
      if (layer.type === '3dtiles' && parsed.asset && parsed.root) {
        const rel = `3dtiles/${safeStem(layer.id)}/tileset.json`;
        writeJson(path.join(outDir, rel), parsed);
        artifacts.push({ kind: 'tileset', url: `${base}/${rel}`, name: layer.name, format: 'json' });
        return;
      }
      text = JSON.stringify(parsed);
    } catch {
      throw new HttpError(400, `图层 ${layer.name}: JSON 数据解析失败`);
    }
  }
  const rel = `data/${safeStem(layer.id)}.geojson`;
  writeJson(path.join(outDir, rel), JSON.parse(text));
  artifacts.push({ kind: 'geojson', url: `${base}/${rel}`, name: layer.name, format: 'geojson' });
}

function addZipArtifact(
  layer: SceneLayer,
  bytes: Buffer,
  outDir: string,
  base: string,
  artifacts: PublishArtifact[],
  zipTilesets: string[],
): void {
  const zip = new AdmZip(bytes);
  const entries = zip.getEntries();
  if (entries.some((entry) => isUnsafeEntryName(entry.entryName))) {
    throw new HttpError(400, `图层 ${layer.name}: zip 包含非法路径条目，已拒绝解压`);
  }
  const tilesetEntry = entries
    .filter((entry) => !entry.isDirectory && /(^|\/)tileset\.json$/i.test(entry.entryName) && !/^__MACOSX\//i.test(entry.entryName))
    .sort((a, b) => a.entryName.length - b.entryName.length)[0];

  if (tilesetEntry) {
    // 已是 3D Tiles 包：原样托管
    const dest = path.join(outDir, '3dtiles', safeStem(layer.id));
    fs.rmSync(dest, { recursive: true, force: true });
    zip.extractAllTo(dest, true);
    cleanupJunk(dest);
    const rel = `3dtiles/${safeStem(layer.id)}/${tilesetEntry.entryName.split('\\').join('/')}`;
    artifacts.push({ kind: 'tileset', url: `${base}/${rel}`, name: layer.name, format: 'json' });
    zipTilesets.push(rel);
    return;
  }

  // 瓦片包：解压为 XYZ 目录
  const dest = path.join(outDir, 'tiles');
  fs.rmSync(dest, { recursive: true, force: true });
  zip.extractAllTo(dest, true);
  cleanupJunk(dest);
  collapseSingleRootDir(dest);
  const ext = detectTileExt(dest);
  artifacts.push({
    kind: 'tiles',
    url: `${base}/tiles/{z}/{x}/{y}.${ext}`,
    name: layer.name,
    format: ext,
  });
}

function addModelArtifact(
  layer: SceneLayer,
  payload: Extract<LayerPayload, { kind: 'model' }>,
  outDir: string,
  base: string,
  artifacts: PublishArtifact[],
  models: ModelEntry[],
): void {
  const stem = safeStem(layer.id);
  const rel = `models/${stem}.${payload.ext}`;
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, payload.bytes);
  artifacts.push({ kind: 'glb', url: `${base}/${rel}`, name: layer.name, format: payload.ext });
  models.push({ layerId: layer.id, name: layer.name, uri: rel, matrix: layerTransformMatrix(layer) });
}

/** 图层 geolocation（position + 配准 translate）→ ENU→ECEF 矩阵 */
function layerTransformMatrix(layer: SceneLayer): number[] | undefined {
  const pos = layer.position;
  if (!pos || typeof pos.lon !== 'number' || typeof pos.lat !== 'number') return undefined;
  const t = layer.projection?.transform;
  const lon = pos.lon + (t?.translate?.x ?? 0);
  const lat = pos.lat + (t?.translate?.y ?? 0);
  const height = (pos.height ?? layer.style?.height ?? 0) + (t?.translate?.z ?? 0);
  return enuToFixedFrame(lon, lat, height, t?.rotateZ ?? 0, t?.scale && t.scale > 0 ? t.scale : 1);
}

// ---------------------------------------------------------------------------
// 3D Tiles tileset 生成
// ---------------------------------------------------------------------------

const LOCAL_BOUNDING_BOX = [0, 0, 0, 1000, 0, 0, 0, 1000, 0, 0, 0, 1000];

function modelTile(model: ModelEntry): Record<string, unknown> {
  const tile: Record<string, unknown> = {
    boundingVolume: { box: LOCAL_BOUNDING_BOX },
    geometricError: 0,
    refine: 'REPLACE',
    content: { uri: model.uri },
  };
  if (model.matrix) tile.transform = model.matrix;
  return tile;
}

function buildModelTileset(models: ModelEntry[]): Record<string, unknown> {
  if (models.length === 1) {
    return { asset: { version: '1.1' }, geometricError: 128, root: modelTile(models[0]) };
  }
  return {
    asset: { version: '1.1' },
    geometricError: 1e7,
    root: {
      boundingVolume: { region: GLOBE_REGION },
      geometricError: 1e7,
      refine: 'REPLACE',
      children: models.map(modelTile),
    },
  };
}

function buildWrapperTileset(childUris: string[]): Record<string, unknown> {
  if (childUris.length === 1) {
    return {
      asset: { version: '1.1' },
      geometricError: 1e7,
      root: {
        boundingVolume: { region: GLOBE_REGION },
        geometricError: 1e7,
        refine: 'REPLACE',
        content: { uri: childUris[0] },
      },
    };
  }
  return {
    asset: { version: '1.1' },
    geometricError: 1e7,
    root: {
      boundingVolume: { region: GLOBE_REGION },
      geometricError: 1e7,
      refine: 'REPLACE',
      children: childUris.map((uri) => ({
        boundingVolume: { region: GLOBE_REGION },
        geometricError: 1e7,
        refine: 'REPLACE',
        content: { uri },
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function publishScene(doc: SceneDocument, createdBy?: string): Promise<PublishManifest> {
  ensureDataDirs();
  if (!doc.id) throw new HttpError(500, '发布前场景必须已保存（缺少 id）');

  const slug = resolveSlug(doc);
  assertSafeSlug(slug);
  const outDir = path.join(PUBLISHED_DIR, slug);
  const base = `/published/${slug}`;

  // 重复发布同一场景：清空旧产物
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const artifacts: PublishArtifact[] = [];
  const models: ModelEntry[] = [];
  const zipTilesets: string[] = [];

  for (const layer of doc.layers ?? []) {
    try {
      if (layer.type === 'kml') {
        console.warn(`[publish] 图层「${layer.name}」为 KML，暂不参与发布，已跳过`);
        continue;
      }
      const payload = await resolveLayerPayload(layer);
      if (!payload) {
        console.warn(`[publish] 图层「${layer.name}」无可发布数据源，已跳过`);
        continue;
      }
      switch (payload.kind) {
        case 'passthrough-url':
          artifacts.push({
            kind: (layer.type === '3dtiles' ? 'tileset' : 'tiles') as PublishArtifactKind,
            url: payload.url,
            name: layer.name,
          });
          break;
        case 'text':
          addTextArtifact(layer, payload, outDir, base, artifacts);
          break;
        case 'zip':
          addZipArtifact(layer, payload.bytes, outDir, base, artifacts, zipTilesets);
          break;
        case 'model':
          addModelArtifact(layer, payload, outDir, base, artifacts, models);
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[publish] 图层「${layer.name}」发布失败: ${message}`);
    }
  }

  // 场景级 tileset.json：GLB 优先，其次包装托管的 3D Tiles 包
  if (models.length > 0) {
    writeJson(path.join(outDir, 'tileset.json'), buildModelTileset(models));
    artifacts.push({ kind: 'tileset', url: `${base}/tileset.json`, name: `${doc.name} 3D Tiles`, format: 'json' });
  } else if (zipTilesets.length > 0) {
    writeJson(path.join(outDir, 'tileset.json'), buildWrapperTileset(zipTilesets));
    artifacts.push({ kind: 'tileset', url: `${base}/tileset.json`, name: `${doc.name} 3D Tiles`, format: 'json' });
  }

  const manifest: PublishManifest = {
    sceneId: doc.id,
    slug,
    name: doc.name,
    publishedAt: new Date().toISOString(),
    artifacts,
  };
  writeJson(path.join(outDir, 'manifest.json'), manifest);
  // 注册到服务注册表（publishedAt 保留首次发布时间）
  const entry = entryFromManifest(manifest, doc.name);
  if (createdBy) (entry as { createdBy?: string }).createdBy = createdBy;
  upsertService(entry);
  return manifest;
}

// ---------------------------------------------------------------------------
// 3D Tiles 数据集 zip 直接发布（独立于场景的服务来源）
// ---------------------------------------------------------------------------

/**
 * 把上传的 3D Tiles 数据集 zip（tileset.json + .b3dm/.glb/纹理树，支持嵌套一层目录）
 * 直接发布为服务：/published/<slug>/tileset.json 可被 Cesium3DTileset 直接加载。
 * slug 规则：<文件名 slugified>-<资产短id>，同资产重复发布覆盖同 slug。
 */
export function publishAssetTiles(assetId: string, filename?: string): { manifest: PublishManifest; entry: ServiceEntry } {
  ensureDataDirs();
  const asset = resolveAssetFile(assetId, filename);
  if (!asset) throw new HttpError(404, `资产不存在: ${assetId}`);
  if (!/\.zip$/i.test(asset.filename)) {
    throw new HttpError(400, '3D Tiles 直接发布仅支持 zip 数据集（内含 tileset.json）');
  }

  const zip = new AdmZip(asset.filePath);
  const zipEntries = zip.getEntries();
  if (zipEntries.some((entry) => isUnsafeEntryName(entry.entryName))) {
    throw new HttpError(400, 'zip 包含非法路径条目，已拒绝解压');
  }
  const tilesetEntry = zipEntries
    .filter(
      (entry) =>
        !entry.isDirectory &&
        /(^|\/)tileset\.json$/i.test(entry.entryName) &&
        !/^__MACOSX\//i.test(entry.entryName),
    )
    .sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length)[0];
  if (!tilesetEntry) {
    throw new HttpError(400, `zip 中未找到 tileset.json，不是 3D Tiles 数据集: ${asset.filename}`);
  }

  // slug 分配：同资产覆盖同 slug；避免占用其他服务的目录
  const shortId = assetId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'asset';
  const existing = findServiceByAssetId(assetId);
  let slug: string;
  if (existing) {
    slug = existing.slug;
  } else {
    slug = `${slugifyName(asset.filename.replace(/\.zip$/i, '')) || '3dtiles'}-${shortId}`;
    const taken = new Set(listServices().map((s) => s.slug));
    if (taken.has(slug) || fs.existsSync(path.join(PUBLISHED_DIR, slug))) {
      for (let i = 2; i < 100; i++) {
        const alt = `${slug}-${i}`;
        if (!taken.has(alt) && !fs.existsSync(path.join(PUBLISHED_DIR, alt))) {
          slug = alt;
          break;
        }
      }
    }
  }
  assertSafeSlug(slug);

  // 解压到发布目录，并把 tileset.json 提升到根目录
  const outDir = path.join(PUBLISHED_DIR, slug);
  fs.rmSync(outDir, { recursive: true, force: true });
  zip.extractAllTo(outDir, true);
  cleanupJunk(outDir);

  if (!fs.existsSync(path.join(outDir, 'tileset.json'))) {
    const relDir = path.posix.dirname(tilesetEntry.entryName.split('\\').join('/'));
    const nestedDir = path.join(outDir, relDir);
    if (!fs.existsSync(path.join(nestedDir, 'tileset.json'))) {
      throw new HttpError(400, '解压后无法定位 tileset.json 于发布根目录');
    }
    for (const child of fs.readdirSync(nestedDir)) {
      fs.renameSync(path.join(nestedDir, child), path.join(outDir, child));
    }
    const segments = relDir.split('/').filter(Boolean);
    while (segments.length) {
      try {
        fs.rmdirSync(path.join(outDir, ...segments));
      } catch {
        break; // 目录非空（存在未被提升的同级资源），保留
      }
      segments.pop();
    }
  }

  const now = new Date().toISOString();
  const manifest: PublishManifest = {
    sceneId: '',
    slug,
    name: asset.filename,
    publishedAt: now,
    artifacts: [
      { kind: 'tileset', url: `/published/${slug}/tileset.json`, name: asset.filename, format: 'json' },
    ],
  };
  writeJson(path.join(outDir, 'manifest.json'), manifest);

  const entry: ServiceEntry = {
    slug,
    sceneId: '',
    sceneName: asset.filename,
    types: ['tileset'],
    artifacts: manifest.artifacts,
    publishedAt: now,
    updatedAt: now,
    assetId,
  };
  upsertService(entry);
  return { manifest, entry };
}
