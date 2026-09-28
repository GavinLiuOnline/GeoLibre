/**
 * 服务端「按路径托管本地目录」（t26）——免上传发布 GB 级缓存。
 *
 * 场景：本机存在 15GB / 242 万文件的 XYZ 瓦片目录（{z}/{x}/{y}.jpg，层级 0–21）或
 * 3D Tiles 数据集目录。浏览器端既无法上传也无法枚举，但服务端同机可直读——因此由
 * `POST /api/services/host-directory` 登记该目录，服务端按 `/tiles/<slug>/...`
 * 与 `/tilesets/<slug>/...` 直接静态托管，编辑器只引用 URL。
 *
 * 安全模型（**默认拒绝**）：
 * - 允许根白名单来自环境变量 `GIS_HOST_DIR_ROOTS`（冒号分隔的绝对路径列表）；
 *   未配置 / 全部无效 → 接口返回 403 并给出开启指引，绝不暴露任意目录；
 * - 目录与每个待托管文件都经 `fs.realpathSync` 规范化，必须落在某个允许根之内
 *   （符号链接逃逸会被 realpath 解析后越界拒绝）；
 * - 仅允许瓦片/模型/清单类扩展名，其余 403；
 * - 扫描是**有界**的：XYZ 只读顶层 z 目录名 + 抽样探测扩展名 + 每层有界计数，
 *   绝不读取瓦片内容。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { PublishArtifact, ServiceEntry } from '@geolibre/gis-shared';

import { HttpError } from '../util/http.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 允许根白名单环境变量（冒号分隔的绝对路径） */
export const HOST_DIR_ROOTS_ENV = 'GIS_HOST_DIR_ROOTS';

/** XYZ 瓦片允许的扩展名 */
export const XYZ_TILE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp', 'avif'];

/** 3D Tiles 数据集允许的扩展名（瓦片内容 + 模型 + 纹理 + 清单） */
export const TILESET_EXTENSIONS: readonly string[] = [
  'json', // tileset.json / 子清单
  'b3dm',
  'i3dm',
  'pnts',
  'cmpt',
  'glb',
  'gltf',
  'bin',
  'ktx2',
  'ktx',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
];

/** 扫描上界（保证开销与文件数无关的量级） */
const SCAN_LIMITS = {
  /** 每个 z 层的瓦片计数上限（超出即停止并标记 truncated） */
  maxTilesPerLevel: 20_000,
  /** 抽样探测扩展名的文件数上限 */
  maxExtensionSamples: 64,
  /** 3D Tiles 目录遍历条目上限 */
  maxTilesetEntries: 5_000,
  /** 一次扫描最多读取的目录条目总数（XYZ 与 3D Tiles 共用；保证内存与时间有界） */
  maxTotalEntries: 100_000,
  /** 递归深度上限（XYZ 层级目录通常 0–24） */
  maxDepth: 8,
};

export interface ScanLimits {
  maxTilesPerLevel?: number;
  maxExtensionSamples?: number;
  maxTilesetEntries?: number;
  maxTotalEntries?: number;
  maxDepth?: number;
}

const DEFAULT_ACCESS_TTL_SECONDS = 3600;

/** 合并默认上界 */
function resolveLimits(limits: ScanLimits): Required<ScanLimits> {
  return {
    maxTilesPerLevel: limits.maxTilesPerLevel ?? SCAN_LIMITS.maxTilesPerLevel,
    maxExtensionSamples: limits.maxExtensionSamples ?? SCAN_LIMITS.maxExtensionSamples,
    maxTilesetEntries: limits.maxTilesetEntries ?? SCAN_LIMITS.maxTilesetEntries,
    maxTotalEntries: limits.maxTotalEntries ?? SCAN_LIMITS.maxTotalEntries,
    maxDepth: limits.maxDepth ?? SCAN_LIMITS.maxDepth,
  };
}

// ---------------------------------------------------------------------------
// 白名单与路径安全
// ---------------------------------------------------------------------------

/** 解析白名单根（realpath 规范化；不存在的根忽略并在控制台告警） */
export function allowedHostRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[HOST_DIR_ROOTS_ENV];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const roots: string[] = [];
  for (const part of raw.split(':')) {
    const candidate = part.trim();
    if (!candidate) continue;
    try {
      const real = fs.realpathSync(path.resolve(candidate));
      if (fs.statSync(real).isDirectory()) roots.push(real);
      else console.warn(`[host-directory] 忽略非目录白名单根: ${candidate}`);
    } catch {
      console.warn(`[host-directory] 忽略不存在的白名单根: ${candidate}`);
    }
  }
  return roots;
}

/** 是否位于某个允许根之内（含根本身） */
function isInside(root: string, target: string): boolean {
  if (root === target) return true;
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 校验候选目录在白名单内；不满足时抛出 403（带配置指引） */
export function assertHostDirAllowed(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const realDir = realpathDirectory(dir);
  const roots = allowedHostRoots(env);
  if (roots.length === 0) {
    throw new HttpError(
      403,
      `目录托管未启用：请先设置环境变量 ${HOST_DIR_ROOTS_ENV}（冒号分隔的允许根绝对路径），例如 ` +
        `${HOST_DIR_ROOTS_ENV}=/home/me/tiles:/data/cache。默认不暴露任何目录。`,
    );
  }
  if (!roots.some((root) => isInside(root, realDir))) {
    throw new HttpError(
      403,
      `目录不在允许根内：${realDir}。允许根（${HOST_DIR_ROOTS_ENV}）：${roots.join(':')}`,
    );
  }
  return realDir;
}

/** realpath + 必须是已存在的目录 */
export function realpathDirectory(dir: unknown): string {
  if (typeof dir !== 'string' || !dir.trim()) {
    throw new HttpError(400, '缺少 dir（目录绝对路径）');
  }
  const resolved = path.resolve(dir);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new HttpError(404, `目录不存在: ${resolved}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new HttpError(404, `无法读取目录: ${real}`);
  }
  if (!stat.isDirectory()) throw new HttpError(400, `不是目录: ${real}`);
  return real;
}

/**
 * 把请求相对路径安全地解析为托管根内的绝对文件路径。
 * 拒绝：绝对路径、`..` 段、空段、反斜杠、NUL、非允许扩展名、realpath 越界。
 */
export function resolveHostedFile(
  rootDir: string,
  relPath: string,
  allowedExtensions: readonly string[],
): { filePath: string; ext: string } {
  if (typeof relPath !== 'string' || !relPath) throw new HttpError(400, '缺少文件相对路径');
  if (relPath.includes('\0')) throw new HttpError(403, '非法路径');
  const normalized = relPath.replace(/^\/+/, '');
  if (!normalized) throw new HttpError(403, '非法路径');
  if (normalized.includes('\\')) throw new HttpError(403, '非法路径（不允许反斜杠）');
  const segments = normalized.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new HttpError(403, '非法路径条目（禁止目录穿越）');
  }
  if (segments.some((s) => s.startsWith('.'))) {
    throw new HttpError(403, '非法路径条目（禁止隐藏文件/目录）');
  }
  const ext = path.extname(normalized).replace(/^\./, '').toLowerCase();
  if (!ext || !allowedExtensions.includes(ext)) {
    throw new HttpError(403, `不允许的文件类型: ${ext || '(无扩展名)'}`);
  }
  const candidate = path.resolve(rootDir, normalized);
  if (!isInside(rootDir, candidate)) throw new HttpError(403, '路径越界');
  let realFile: string;
  try {
    realFile = fs.realpathSync(candidate); // 解析符号链接：软链目标越界即被拦下
  } catch {
    throw new HttpError(404, `文件不存在: ${normalized}`);
  }
  if (!isInside(rootDir, realFile)) throw new HttpError(403, '路径越界（符号链接逃逸）');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realFile);
  } catch {
    throw new HttpError(404, `文件不存在: ${normalized}`);
  }
  if (!stat.isFile()) throw new HttpError(404, `不是文件: ${normalized}`);
  return { filePath: realFile, ext };
}

// ---------------------------------------------------------------------------
// 轻量扫描
// ---------------------------------------------------------------------------

export interface XyzScanResult {
  kind: 'xyz';
  /** 顶层 z 目录层级（数字，升序） */
  levels: number[];
  /** 每层瓦片数（有界；达到上限即停止并置 truncated） */
  tileCounts: Record<string, number>;
  /** 计数是否被上限截断 */
  truncated: boolean;
  /** 抽样探测到的扩展名（升序） */
  extensions: string[];
  /** 主扩展名（出现次数最多者） */
  primaryExt: string;
  /** 统计到的瓦片总数（有界） */
  totalTiles: number;
  /** 扫描过的条目数（诊断用，证明开销有界） */
  scannedEntries: number;
  /** 是否读取了瓦片内容（恒为 false，安全断言） */
  contentRead: false;
}

function listDirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 逐条惰性遍历目录（`fs.opendirSync` + `readSync`）。
 *
 * 为什么不直接用 `readdirSync`：真实 XYZ 缓存的某一层目录可能含**上百万**子目录/文件，
 * `readdirSync` 会把整份目录一次性物化到内存（2.4M 文件量级下是几百 MB 的 Dirent 数组）。
 * 惰性迭代只保留"当前一条"，配合 `maxEntries` 预算即可做到内存与时间都与文件数无关。
 */
function forEachEntryBounded(
  dir: string,
  maxEntries: number,
  visit: (entry: fs.Dirent) => boolean | void,
): { entries: number; truncated: boolean } {
  let entries = 0;
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(dir);
  } catch {
    return { entries, truncated: false };
  }
  let truncated = false;
  try {
    let entry = handle.readSync();
    while (entry) {
      if (entries >= maxEntries) {
        truncated = true;
        break;
      }
      entries += 1;
      const stop = visit(entry);
      if (stop === false) {
        truncated = true;
        break;
      }
      entry = handle.readSync();
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      /* noop */
    }
  }
  return { entries, truncated };
}

/** 有界递归计数：返回 { tiles, extCounts, entries, truncated } */
function countTiles(
  dir: string,
  limits: Required<ScanLimits>,
  budget: number,
  state: { entries: number; truncated: boolean },
  depth = 0,
): { tiles: number; extCounts: Map<string, number> } {
  const extCounts = new Map<string, number>();
  let tiles = 0;
  if (depth > limits.maxDepth || state.entries >= limits.maxTotalEntries) {
    state.truncated = true;
    return { tiles, extCounts };
  }
  const childDirs: string[] = [];
  const walked = forEachEntryBounded(dir, limits.maxTotalEntries - state.entries, (entry) => {
    if (tiles >= budget || state.entries >= limits.maxTotalEntries) {
      state.truncated = true;
      return false;
    }
    if (entry.isDirectory()) {
      childDirs.push(path.join(dir, entry.name));
      return;
    }
    if (!entry.isFile()) return; // 符号链接/套接字等一律不计数
    const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
    if (!XYZ_TILE_EXTENSIONS.includes(ext)) return;
    tiles += 1;
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  });
  state.entries += walked.entries;
  if (walked.truncated) state.truncated = true;

  for (const child of childDirs) {
    if (tiles >= budget || state.entries >= limits.maxTotalEntries) {
      state.truncated = true;
      break;
    }
    const sub = countTiles(child, limits, budget - tiles, state, depth + 1);
    tiles += sub.tiles;
    for (const [ext, n] of sub.extCounts) extCounts.set(ext, (extCounts.get(ext) ?? 0) + n);
  }
  return { tiles, extCounts };
}

/**
 * 轻量扫描 XYZ 瓦片目录：
 * 只枚举顶层 z 目录 + 每层有界计数 + 抽样探测扩展名；**不读取任何瓦片内容**。
 * 条目读取总量受 `maxTotalEntries` 约束（默认 10 万），因此 242 万文件的目录也只需有界时间/内存。
 */
export function scanXyzDirectory(dir: string, limits: ScanLimits = {}): XyzScanResult {
  const lim = resolveLimits(limits);
  const topEntries = listDirEntries(dir); // 顶层只有 z 目录（个位数~几十），全量安全
  const levels = topEntries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => Number(e.name))
    .sort((a, b) => a - b);
  if (levels.length === 0) {
    throw new HttpError(400, `目录结构不是 XYZ 瓦片树（顶层缺少数字层级目录）: ${dir}`);
  }

  const tileCounts: Record<string, number> = {};
  const extCounts = new Map<string, number>();
  const state = { entries: 0, truncated: false };
  let totalTiles = 0;
  for (const level of levels) {
    const levelDir = path.join(dir, String(level));
    const budget = Math.min(lim.maxTilesPerLevel, lim.maxTotalEntries - state.entries);
    if (budget <= 0) {
      state.truncated = true;
      tileCounts[String(level)] = 0;
      continue;
    }
    const { tiles, extCounts: levelExts } = countTiles(levelDir, lim, budget, state);
    tileCounts[String(level)] = tiles;
    totalTiles += tiles;
    for (const [ext, n] of levelExts) extCounts.set(ext, (extCounts.get(ext) ?? 0) + n);
    if (tiles >= lim.maxTilesPerLevel || state.entries >= lim.maxTotalEntries) state.truncated = true;
  }

  if (totalTiles === 0) {
    throw new HttpError(400, `目录结构不是 XYZ 瓦片树（层级目录内未发现瓦片文件）: ${dir}`);
  }

  const extensions = [...extCounts.keys()].sort();
  const primaryExt = [...extCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return {
    kind: 'xyz',
    levels,
    tileCounts,
    truncated: state.truncated,
    extensions,
    primaryExt,
    totalTiles,
    scannedEntries: state.entries,
    contentRead: false,
  };
}

export interface TilesetScanResult {
  kind: '3dtiles';
  /** tileset.json 相对数据集根的路径 */
  tilesetPath: string;
  /** 数据集根（tileset.json 所在目录相对托管根） */
  datasetRoot: string;
  /** asset.version（tileset.json 的 asset.version） */
  assetVersion?: string;
  geometricError?: number;
  /** 顶层 root 的直接子节点数（若有） */
  rootChildren?: number;
  /** 有界统计的条目数 */
  scannedEntries: number;
  truncated: boolean;
  extensions: string[];
}

/** 在目录（或一层子目录）内定位 tileset.json（路径最短优先） */
export function findTilesetJson(dir: string): { relPath: string; dirRel: string } | null {
  let best: { relPath: string; dirRel: string } | null = null;
  const consider = (relPath: string, dirRel: string): void => {
    if (!best || relPath.split('/').length < best.relPath.split('/').length) best = { relPath, dirRel };
  };
  if (fs.existsSync(path.join(dir, 'tileset.json'))) consider('tileset.json', '');
  // 一层子目录探测：惰性遍历 + 有界（数据集根可能有海量瓦片子目录）
  forEachEntryBounded(dir, SCAN_LIMITS.maxTilesetEntries, (entry) => {
    if (!entry.isDirectory()) return;
    if (entry.name === '__MACOSX') return;
    if (fs.existsSync(path.join(dir, entry.name, 'tileset.json'))) {
      consider(`${entry.name}/tileset.json`, entry.name);
    }
  });
  return best;
}

/** 轻量扫描 3D Tiles 数据集目录：只读 tileset.json 元信息 + 有界统计扩展名 */
export function scan3dTilesDirectory(dir: string, limits: ScanLimits = {}): TilesetScanResult {
  const lim = resolveLimits(limits);
  const hit = findTilesetJson(dir);
  if (!hit) throw new HttpError(400, `目录结构不是 3D Tiles 数据集（未找到 tileset.json）: ${dir}`);

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, hit.relPath), 'utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, `tileset.json 不是有效 JSON: ${hit.relPath}`);
  }

  // 有界 + 惰性遍历统计扩展名（不读取任何瓦片内容，也不一次性物化海量目录条目）
  const state = { entries: 0, truncated: false };
  const extCounts = new Map<string, number>();
  const walk = (current: string, depth: number): void => {
    if (depth > lim.maxDepth || state.entries >= lim.maxTotalEntries) {
      state.truncated = true;
      return;
    }
    const childDirs: string[] = [];
    const walked = forEachEntryBounded(current, lim.maxTotalEntries - state.entries, (entry) => {
      if (entry.isDirectory()) {
        childDirs.push(path.join(current, entry.name));
        return;
      }
      const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
      if (TILESET_EXTENSIONS.includes(ext)) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    });
    state.entries += walked.entries;
    if (walked.truncated) state.truncated = true;
    for (const child of childDirs) {
      if (state.entries >= lim.maxTotalEntries) {
        state.truncated = true;
        break;
      }
      walk(child, depth + 1);
    }
  };
  walk(dir, 0);

  const asset = (meta.asset ?? {}) as Record<string, unknown>;
  const root = meta.root as { children?: unknown[] } | undefined;
  return {
    kind: '3dtiles',
    tilesetPath: hit.relPath,
    datasetRoot: hit.dirRel,
    assetVersion: typeof asset.version === 'string' ? asset.version : undefined,
    geometricError: typeof meta.geometricError === 'number' ? meta.geometricError : undefined,
    rootChildren: Array.isArray(root?.children) ? root.children.length : undefined,
    scannedEntries: state.entries,
    truncated: state.truncated,
    extensions: [...extCounts.keys()].sort(),
  };
}

// ---------------------------------------------------------------------------
// 托管服务注册
// ---------------------------------------------------------------------------

export interface HostDirectoryInput {
  dir: string;
  kind: 'xyz' | '3dtiles';
  slug?: string;
  title?: string;
}

export interface HostDirectoryResult {
  entry: ServiceEntry;
  scan: XyzScanResult | TilesetScanResult;
  /** 托管地址（相对服务端根） */
  access: { url: string; kind: 'tiles' | 'tileset'; note: string };
}

/** slugify（与既有 slug 风格一致：小写、连字符、去特殊字符） */
export function slugifyName(name: string): string {
  const s = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'dir';
}

function resolveHostSlug(input: HostDirectoryInput, dir: string): string {
  const provided = typeof input.slug === 'string' ? input.slug.trim() : '';
  const base = provided || `host-${slugifyName(path.basename(dir))}`;
  const slug = base.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    throw new HttpError(400, `非法 slug（仅允许小写字母/数字/连字符，2–80 字符）: ${base}`);
  }
  return slug;
}

/** 允许的扩展名（按托管类型） */
export function allowedExtensionsFor(kind: 'xyz' | '3dtiles'): readonly string[] {
  return kind === 'xyz' ? XYZ_TILE_EXTENSIONS : TILESET_EXTENSIONS;
}

/**
 * 登记一个目录托管服务：
 * 白名单校验 → 结构校验 + 轻量扫描 → 注册表 upsert（同 slug 覆盖，publishedAt 保留）。
 * 返回条目 + 可访问地址（不复制、不上传任何文件）。
 */
export function buildHostDirectoryEntry(
  input: HostDirectoryInput,
  now = new Date().toISOString(),
): HostDirectoryResult {
  const kind = input.kind;
  if (kind !== 'xyz' && kind !== '3dtiles') {
    throw new HttpError(400, "kind 必须为 'xyz' 或 '3dtiles'");
  }
  const realDir = assertHostDirAllowed(input.dir);
  const slug = resolveHostSlug(input, realDir);
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : path.basename(realDir);

  if (kind === 'xyz') {
    const scan = scanXyzDirectory(realDir);
    const artifact: PublishArtifact = {
      kind: 'tiles',
      url: `/tiles/${slug}/{z}/{x}/{y}.${scan.primaryExt}`,
      name: title,
      format: scan.primaryExt,
    };
    return {
      entry: {
        slug,
        sceneId: '',
        sceneName: title,
        types: ['tiles'],
        artifacts: [artifact],
        publishedAt: now,
        updatedAt: now,
        hostDir: realDir,
        hostKind: 'xyz',
      },
      scan,
      access: {
        url: artifact.url,
        kind: 'tiles',
        note: '服务端按路径托管该目录，未复制/未上传任何文件；目录内容变化即时生效',
      },
    };
  }

  const scan = scan3dTilesDirectory(realDir);
  const artifact: PublishArtifact = {
    kind: 'tileset',
    url: `/tilesets/${slug}/${scan.tilesetPath}`,
    name: title,
    format: 'json',
  };
  return {
    entry: {
      slug,
      sceneId: '',
      sceneName: title,
      types: ['tileset'],
      artifacts: [artifact],
      publishedAt: now,
      updatedAt: now,
      hostDir: realDir,
      hostKind: '3dtiles',
    },
    scan,
    access: {
      url: artifact.url,
      kind: 'tileset',
      note: '服务端按路径托管该目录，未复制/未上传任何文件；目录内容变化即时生效',
    },
  };
}

/** 托管响应的缓存头（目录内容可能被工具重写，用较短 TTL） */
export function hostedCacheControl(maxAgeSeconds = DEFAULT_ACCESS_TTL_SECONDS): string {
  return `public, max-age=${maxAgeSeconds}`;
}

export { DEFAULT_ACCESS_TTL_SECONDS };
