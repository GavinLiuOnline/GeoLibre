/**
 * @geolibre/xyz-cache · xyz-disk —— 磁盘瓦片管线（t35，纯 Node 逻辑，零 electron 依赖）
 *
 * 移植自 gis-full editor `electron/xyzDisk.ts`。全部磁盘 IO 经由可注入的
 * `CacheStorage` 抽象（默认 `nodeCacheStorage` = node:fs/promises + node:fs），
 * 导出函数均增加可选 `storage` 参数，缺省行为与原实现逐字一致。
 *
 * 用户指令：「使用 electron 才允许超大场景的 xyz 缓存，同时为 electron 的缓存导入导出做优化」。
 *
 * 为什么必须由主进程做：超大 XYZ 缓存（例：东北 z0–20 ≈ 44.8 亿瓦片 / 7.4TB）在渲染进程
 * 受三重死穴——webkitdirectory 文件数上限（t23）、渲染进程内存（t29 需先把内容装进 Blob）、
 * ZIP 内存打包模型。主进程有 Node fs，可以绕开全部三重限制：
 *
 * 1. **有界扫描**（scanXyzDirectory）：`fsp.opendir` 惰性逐条读取 + 条目预算，**不枚举全量、
 *    不物化 Dirent 数组**，耗时与文件总数无关（44.8 亿文件级目录也是秒级返回）；
 *    与服务端 t26 hostDirectory 的扫描语义对齐（各自独立实现，不跨包引代码）。
 * 2. **流式导出**（runDiskTileExport）：
 *    - `directory`：按裁剪条件逐瓦片 `copyFile` 直拷瓦片树；
 *    - `zip`：StreamingZipWriter 逐瓦片「stat → createReadStream →（可选 deflateRaw）→ 追加
 *      写入 ZIP」，data descriptor 免回写补丁，中央目录暂存临时文件——内存（RSS）与瓦片数、
 *      总字节数都无关。设计与服务端 t34 exportJob 同构（同一套 ZIP 布局 / ZIP64 规则）。
 * 3. **裁剪过滤**（tilePassesFilter / estimateFilterTileCount）：bounds + minZoom/maxZoom
 *    公式法求交（与 editor scale.ts / 服务端 exportJob 同一公式，独立实现），支持
 *    web-mercator / geographic 两种切片与 TMS 翻转。
 *
 * 安全模型：
 * - 输入路径必须经 realpath 规范化（parseDiskDir），软链目录即被解析为真实目标；
 * - 瓦片扩展名走白名单 XYZ_DISK_TILE_EXTENSIONS；
 * - 导出目标 assertExportPaths：目标不得与源目录互相包含（防自拷贝递归）、zip 目标必须是
 *   `.zip` 后缀、directory 目标必须不存在或为空目录；
 * - 取消（AbortSignal）与失败都会清理半成品（zip + 中央目录临时文件 / 目标目录整体删除）。
 *
 * 本模块**不 import 'electron'**，全部能力来自可注入的 CacheStorage（Node 实现
 * 基于 node:fs / node:path / node:zlib / node:stream），因此可以在 node:test
 * 直接单测；宿主（Electron main 等）只做对话框 / webContents 的粘合。
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';

import type { CacheDirent, CacheFileHandle, CacheStats, CacheStorage } from './cache-storage';
import { nodeCacheStorage } from './node-cache-storage';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 允许的 XYZ 瓦片扩展名（与服务端 t26 XYZ_TILE_EXTENSIONS 同一口径，独立声明） */
export const XYZ_DISK_TILE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp', 'avif'];

/** 世界边界（Web Mercator 有效纬度钳制；与服务端 WORLD_BOUNDS / editor MERCATOR_MAX_LAT 同值） */
export const XYZ_DISK_WORLD_BOUNDS: readonly [number, number, number, number] = [
  -180, -85.0511287798066, 180, 85.0511287798066,
];

/** 支持导出的最大层级（2^24 网格下计数仍远小于 2^53） */
export const XYZ_DISK_MAX_ZOOM = 24;

/** 逐瓦片读取的 highWaterMark（1MB：单瓦片通常 8–40KB，一批 1MB 足够摊薄 syscall） */
const TILE_READ_HIGH_WATER_MARK = 1024 * 1024;

/** 速率滑动窗口（毫秒）—— 与 t33 progress / t34 exportJob 同一窗口宽度 */
const RATE_WINDOW_MS = 10_000;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 切片模式（与 editor XyzTilingMode / t30 metadata.tilingMode 同义） */
export type XyzDiskTilingMode = 'web-mercator' | 'geographic';

/** 扫描预算：所有默认值共同保证「扫描耗时与文件总数无关」 */
export interface XyzDiskScanLimits {
  /** 全局 opendir 读取条目预算（默认 200_000 条；每读一条计数一次） */
  maxTotalEntries: number;
  /** 单层瓦片计数预算（默认 40_000；达到即该层截断） */
  maxTilesPerLevel: number;
  /** bounds 推算的瓦片键采样上限（默认 2048） */
  boundsSampleTiles: number;
}

export const DEFAULT_XYZ_DISK_SCAN_LIMITS: XyzDiskScanLimits = {
  maxTotalEntries: 200_000,
  maxTilesPerLevel: 40_000,
  boundsSampleTiles: 2048,
};

/** 单层扫描统计 */
export interface XyzDiskLevelStat {
  z: number;
  /** 有界计数的瓦片数（下限；truncated 时实际更多） */
  tiles: number;
}

/** scanXyzDirectory 结果（绝不返回全量文件清单） */
export interface XyzDiskScanResult {
  kind: 'xyz';
  /** realpath 规范化后的源目录 */
  dir: string;
  /** 层级统计（按 z 升序） */
  levels: XyzDiskLevelStat[];
  /** 采样到的扩展名（升序） */
  extensions: string[];
  /** 主扩展名（出现次数最多者） */
  primaryExt: string;
  /** 有界计数的瓦片总数（下限；truncated=true 时实际更多） */
  tileCount: number;
  /** 计数是否被预算截断 */
  truncated: boolean;
  /** 扫描过的目录条目数（诊断用，证明开销有界） */
  scannedEntries: number;
  /** 由采样瓦片键推算的地理范围（样本不足时 undefined） */
  bounds: [number, number, number, number] | undefined;
  /** 参与范围推算的采样瓦片键数 */
  boundsSampleTiles: number;
}

/** 裁剪过滤条件（供流式导出与统计共用） */
export interface XyzDiskTileFilter {
  /** 地理范围 [minLon, minLat, maxLon, maxLat]（度）；缺省全球 */
  bounds?: readonly [number, number, number, number];
  /** 最小层级（含） */
  minZoom?: number;
  /** 最大层级（含） */
  maxZoom?: number;
  /** TMS：瓦片文件名 y 自南向北（t30 metadata.tms） */
  tms?: boolean;
  /** 切片模式（t30 metadata.tilingMode；缺省 web-mercator） */
  tilingMode?: XyzDiskTilingMode;
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** xyzDisk 可读错误（message 直接展示给用户；code 供 UI 分支） */
export class XyzDiskError extends Error {
  readonly code: 'invalid-path' | 'invalid-spec' | 'not-xyz' | 'dest-conflict' | 'io';

  constructor(code: XyzDiskError['code'], message: string) {
    super(message);
    this.name = 'XyzDiskError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 路径校验（防穿越 / 软链）
// ---------------------------------------------------------------------------

export interface ParsedDiskDir {
  /** 用户输入的原始路径 */
  input: string;
  /** realpath 规范化后的绝对路径 */
  realPath: string;
}

/**
 * 校验并规范化磁盘目录输入：
 * - 必须是非空字符串的绝对路径（拒绝相对路径 / NUL 字节）；
 * - 必须 realpath 成功且是目录（软链在 realpath 后透明解析为真实目录）。
 */
export async function parseDiskDir(
  input: unknown,
  label = '目录',
  storage: CacheStorage = nodeCacheStorage,
): Promise<ParsedDiskDir> {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new XyzDiskError('invalid-path', `${label}路径不能为空`);
  }
  if (input.includes('\0')) {
    throw new XyzDiskError('invalid-path', `${label}路径包含非法字符`);
  }
  const trimmed = input.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new XyzDiskError('invalid-path', `${label}必须是绝对路径（收到「${trimmed}」）`);
  }
  let realPath: string;
  try {
    realPath = await storage.realpath(trimmed);
  } catch {
    throw new XyzDiskError('invalid-path', `${label}不存在或不可访问：${trimmed}`);
  }
  const stat = await storage.stat(realPath).catch(() => undefined);
  if (!stat || !stat.isDirectory()) {
    throw new XyzDiskError('invalid-path', `${label}不是目录：${realPath}`);
  }
  return { input: trimmed, realPath };
}

/** inner 是否等于 outer 或在 outer 内部（两侧都须为绝对路径） */
function isInside(inner: string, outer: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * 校验导出目标与源目录的关系（防自拷贝 / 递归）：
 * - dest 必须是绝对路径；
 * - dest 不得等于 src 或位于 src 内部（往源里写会导致自拷贝递归）；
 * - src 不得位于 dest 内部（导出过程会遍历目标目录时把目标自己也读进来）。
 * 返回 resolve 后的目标绝对路径。
 */
export function assertExportPaths(srcRealPath: string, dest: unknown, format: 'zip' | 'directory'): string {
  if (typeof dest !== 'string' || dest.trim() === '') {
    throw new XyzDiskError('invalid-path', '导出目标路径不能为空');
  }
  if (dest.includes('\0')) {
    throw new XyzDiskError('invalid-path', '导出目标路径包含非法字符');
  }
  const trimmed = dest.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new XyzDiskError('invalid-path', `导出目标必须是绝对路径（收到「${trimmed}」）`);
  }
  const destAbs = path.resolve(trimmed);
  if (isInside(destAbs, srcRealPath)) {
    throw new XyzDiskError(
      'dest-conflict',
      `导出目标（${destAbs}）位于源目录（${srcRealPath}）内部，会造成自拷贝递归，已中止`,
    );
  }
  if (isInside(srcRealPath, destAbs)) {
    throw new XyzDiskError(
      'dest-conflict',
      `源目录（${srcRealPath}）位于导出目标（${destAbs}）内部，导出过程会包含目标自身，已中止`,
    );
  }
  if (format === 'zip' && !/\.zip$/i.test(destAbs)) {
    throw new XyzDiskError('invalid-spec', `流式 ZIP 导出的目标必须是 .zip 文件（收到「${destAbs}」）`);
  }
  return destAbs;
}

// ---------------------------------------------------------------------------
// 公式法：瓦片坐标 ↔ 经纬度（web-mercator / geographic / TMS）
// ---------------------------------------------------------------------------

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 经度 → 瓦片 x（floor 语义），结果钳制到该模式的有效网格 */
export function lngToTileX(lng: number, zoom: number, tilingMode: XyzDiskTilingMode = 'web-mercator'): number {
  // geographic（CGCS2000 经纬度直方格）：z 层 2^(z+1) 列 × 2^z 行，覆盖 -180..180 / -90..90
  const n = tilingMode === 'geographic' ? 2 ** (zoom + 1) : 2 ** zoom;
  return clampInt(Math.floor(((lng + 180) / 360) * n), 0, n - 1);
}

/** 纬度 → 瓦片 y（floor 语义，北起；纬度钳制到模式有效域） */
export function latToTileY(lat: number, zoom: number, tilingMode: XyzDiskTilingMode = 'web-mercator'): number {
  if (tilingMode === 'geographic') {
    const n = 2 ** zoom;
    return clampInt(Math.floor(((90 - clampInt(lat, -90, 90)) / 180) * n), 0, n - 1);
  }
  const n = 2 ** zoom;
  const clamped = Math.min(85.0511287798066, Math.max(-85.0511287798066, lat));
  const latRad = (clamped * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  return clampInt(y, 0, n - 1);
}

/** 瓦片 x 的西边界经度 */
export function tileXToLon(x: number, zoom: number, tilingMode: XyzDiskTilingMode = 'web-mercator'): number {
  const n = tilingMode === 'geographic' ? 2 ** (zoom + 1) : 2 ** zoom;
  return (x / n) * 360 - 180;
}

/** 瓦片 y 的北边界纬度（XYZ 北起口径；TMS 请先翻 y） */
export function tileYToLat(y: number, zoom: number, tilingMode: XyzDiskTilingMode = 'web-mercator'): number {
  if (tilingMode === 'geographic') {
    const n = 2 ** zoom;
    return 90 - (y / n) * 180;
  }
  const n = 2 ** zoom;
  const clampedY = clampInt(y, 0, n);
  const mercN = Math.PI - (2 * Math.PI * clampedY) / n;
  return (Math.atan(Math.sinh(mercN)) * 180) / Math.PI;
}

/** 单瓦片的经纬度范围 [minLon, minLat, maxLon, maxLat]（按过滤器的模式与 TMS 口径） */
export function tileToBounds(
  z: number,
  x: number,
  y: number,
  filter: XyzDiskTileFilter = {},
): [number, number, number, number] {
  const tilingMode = filter.tilingMode ?? 'web-mercator';
  const tms = filter.tms === true;
  const n = 2 ** z;
  const northY = tms ? n - 1 - y : y; // TMS 文件 y 自南向北 → 翻转成北起口径
  const west = tileXToLon(x, z, tilingMode);
  const east = tileXToLon(x + 1, z, tilingMode);
  const north = tileYToLat(northY, z, tilingMode);
  const south = tileYToLat(northY + 1, z, tilingMode);
  return [west, south, east, north];
}

const WORLD: readonly [number, number, number, number] = XYZ_DISK_WORLD_BOUNDS;

/**
 * 单瓦片是否命中裁剪条件（流式导出与统计共用；公式与遍历区间同源，双保险）。
 * z 不在 [minZoom, maxZoom]（提供时）→ false；瓦片范围与 bounds 无交 → false。
 */
export function tilePassesFilter(z: number, x: number, y: number, filter: XyzDiskTileFilter = {}): boolean {
  const minZoom = filter.minZoom ?? 0;
  const maxZoom = filter.maxZoom ?? XYZ_DISK_MAX_ZOOM;
  if (z < minZoom || z > maxZoom) return false;
  const bounds = filter.bounds ?? WORLD;
  const [west, south, east, north] = tileToBounds(z, x, y, filter);
  return west < bounds[2] && east > bounds[0] && south < bounds[3] && north > bounds[1];
}

/** bbox 在 z 层命中的 x 连续段列表（含两端；跨 180° 拆两段） */
export function xSpansForBounds(
  bounds: readonly [number, number, number, number],
  zoom: number,
  tilingMode: XyzDiskTilingMode = 'web-mercator',
): Array<[number, number]> {
  const [minLon, , maxLon] = bounds;
  const n = tilingMode === 'geographic' ? 2 ** (zoom + 1) : 2 ** zoom;
  const w = clampInt(minLon, -180, 180);
  const e = clampInt(maxLon, -180, 180);
  const xw = lngToTileX(w, zoom, tilingMode);
  const xe = lngToTileX(e, zoom, tilingMode);
  if (e >= w) return [[xw, xe]];
  return [
    [xw, n - 1],
    [0, xe],
  ];
}

/** bbox 在 z 层命中的 [yTop, yBottom]（含两端，北起口径） */
export function yRangeForBounds(
  bounds: readonly [number, number, number, number],
  zoom: number,
  tilingMode: XyzDiskTilingMode = 'web-mercator',
): [number, number] {
  const [, minLat, , maxLat] = bounds;
  return [latToTileY(maxLat, zoom, tilingMode), latToTileY(minLat, zoom, tilingMode)];
}

/**
 * 公式法估算：bounds × 层级范围在该过滤器下的瓦片总数（零 IO，与 editor scale.ts /
 * 服务端 exportJob 同一公式，独立实现）。TMS 只改变文件命名口径，网格求交不变。
 */
export function estimateFilterTileCount(
  filter: XyzDiskTileFilter,
): { totalTiles: number; perLevel: Array<{ z: number; tiles: number }> } {
  const tilingMode = filter.tilingMode ?? 'web-mercator';
  const bounds = filter.bounds ?? WORLD;
  const minZoom = Math.max(0, Math.floor(filter.minZoom ?? 0));
  const maxZoom = Math.min(XYZ_DISK_MAX_ZOOM, Math.max(minZoom, Math.floor(filter.maxZoom ?? 18)));
  const perLevel: Array<{ z: number; tiles: number }> = [];
  let totalTiles = 0;
  for (let z = minZoom; z <= maxZoom; z += 1) {
    let cols = 0;
    for (const [x0, x1] of xSpansForBounds(bounds, z, tilingMode)) cols += x1 - x0 + 1;
    const [yTop, yBottom] = yRangeForBounds(bounds, z, tilingMode);
    const tiles = Math.max(0, cols) * Math.max(0, yBottom - yTop + 1);
    perLevel.push({ z, tiles });
    totalTiles += tiles;
  }
  return { totalTiles, perLevel };
}

/** 由采样瓦片键推算 bounds（并集；空输入返回 undefined） */
export function boundsFromTileKeys(
  keys: ReadonlyArray<{ z: number; x: number; y: number }>,
  tilingMode: XyzDiskTilingMode = 'web-mercator',
): [number, number, number, number] | undefined {
  if (keys.length === 0) return undefined;
  let minLon = 180;
  let minLat = 90;
  let maxLon = -180;
  let maxLat = -90;
  for (const key of keys) {
    const [west, south, east, north] = tileToBounds(key.z, key.x, key.y, { tilingMode });
    minLon = Math.min(minLon, west);
    minLat = Math.min(minLat, south);
    maxLon = Math.max(maxLon, east);
    maxLat = Math.max(maxLat, north);
  }
  return [minLon, minLat, maxLon, maxLat];
}

// ---------------------------------------------------------------------------
// 有界扫描
// ---------------------------------------------------------------------------

interface ScanState {
  entries: number;
  truncated: boolean;
  tiles: number;
  extCounts: Map<string, number>;
  sample: Array<{ z: number; x: number; y: number }>;
  sampleBudget: number;
}

/**
 * 惰性逐条遍历目录（fsp.opendir），条目预算内回调；visit 返回 false 提前终止。
 * 每读一条（含被 visit 拒绝的）都计入 visit 自己维护的计数器 —— 预算语义与
 * 服务端 forEachEntryBounded 一致。
 */
async function forEachEntryBounded(
  dir: string,
  maxEntries: number,
  visit: (entry: CacheDirent) => boolean | void,
  storage: CacheStorage,
): Promise<{ entries: number; truncated: boolean }> {
  let entries = 0;
  let truncated = false;
  let handle: Awaited<ReturnType<CacheStorage['opendir']>>;
  try {
    handle = await storage.opendir(dir);
  } catch {
    return { entries, truncated };
  }
  try {
    for (;;) {
      const entry = await handle.read();
      if (!entry) break;
      if (entries >= maxEntries) {
        truncated = true;
        break;
      }
      entries += 1;
      if (visit(entry) === false) {
        truncated = true;
        break;
      }
    }
  } finally {
    try {
      await handle.close();
    } catch {
      /* noop */
    }
  }
  return { entries, truncated };
}

/** 数字目录/文件名 → number（非数字返回 undefined） */
function numericName(name: string): number | undefined {
  return /^\d+$/.test(name) ? Number(name) : undefined;
}

/** 瓦片文件名 `<y>.<ext>` → { y, ext }（扩展名必须在白名单） */
export function parseTileFileName(name: string): { y: number; ext: string } | undefined {
  const match = /^(\d+)\.([A-Za-z0-9]+)$/.exec(name);
  if (!match) return undefined;
  const ext = match[2]!.toLowerCase();
  if (!XYZ_DISK_TILE_EXTENSIONS.includes(ext)) return undefined;
  return { y: Number(match[1]), ext };
}

/**
 * 有界扫描 XYZ 瓦片目录：
 * - `fsp.opendir` 惰性逐条读取，全局条目预算 + 单层瓦片预算；
 * - **不返回全量文件清单**，返回层级统计 / 扩展名 / 有界瓦片计数（下限）/ 采样范围；
 * - 耗时与文件总数无关（预算先到先停，truncated=true 明示「实际更多」）；
 * - 结构不匹配（顶层无数字层级目录）→ XyzDiskError('not-xyz')。
 */
export async function scanXyzDirectory(
  input: string,
  options: { limits?: Partial<XyzDiskScanLimits>; storage?: CacheStorage } = {},
): Promise<XyzDiskScanResult> {
  const storage = options.storage ?? nodeCacheStorage;
  const { realPath } = await parseDiskDir(input, '瓦片目录', storage);
  const limits: XyzDiskScanLimits = { ...DEFAULT_XYZ_DISK_SCAN_LIMITS, ...(options.limits ?? {}) };

  // 顶层 z 目录：真实缓存层数 ≤ 30 个左右，一次 readdir 足够（条目数有限，不违背预算语义）
  const topEntries = await storage.readdir(realPath, { withFileTypes: true }).catch(() => []);
  const levelDirs = topEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ z: numericName(entry.name), name: entry.name }))
    .filter((entry): entry is { z: number; name: string } => entry.z !== undefined)
    .sort((a, b) => a.z - b.z);
  if (levelDirs.length === 0) {
    throw new XyzDiskError(
      'not-xyz',
      `目录结构不是 XYZ 瓦片树（顶层缺少数字层级目录）：${realPath}。` +
        '请确认选择的是 <z>/<x>/<y>.<ext> 结构的 XYZ 缓存目录。',
    );
  }

  const state: ScanState = {
    entries: 0,
    truncated: false,
    tiles: 0,
    extCounts: new Map<string, number>(),
    sample: [],
    sampleBudget: Math.max(1, Math.ceil(limits.boundsSampleTiles / levelDirs.length)),
  };

  const levels: XyzDiskLevelStat[] = [];
  for (const { z, name } of levelDirs) {
    const remainingEntries = limits.maxTotalEntries - state.entries;
    if (remainingEntries <= 0) {
      state.truncated = true;
      break;
    }
    const budget = Math.min(limits.maxTilesPerLevel, remainingEntries);

    // 第一段：收集该层的 x 目录（计入全局条目预算）
    const xDirs: Array<{ name: string; x: number }> = [];
    const walked = await forEachEntryBounded(
      path.join(realPath, name),
      remainingEntries,
      (entry) => {
        state.entries += 1;
        if (state.entries >= limits.maxTotalEntries) return false;
        if (!entry.isDirectory()) return undefined;
        const x = numericName(entry.name);
        if (x === undefined) return undefined;
        xDirs.push({ name: entry.name, x });
        return undefined;
      },
      storage,
    );
    if (walked.truncated) state.truncated = true;

    // 第二段：逐 x 目录有界计数瓦片（计入全局条目预算 + 单层瓦片预算）
    let tiles = 0;
    for (const { name: xName, x } of xDirs) {
      if (tiles >= budget || state.entries >= limits.maxTotalEntries) {
        state.truncated = true;
        break;
      }
      const sampled = await forEachEntryBounded(
        path.join(realPath, name, xName),
        Math.min(limits.maxTotalEntries - state.entries, budget - tiles),
        (entry) => {
          state.entries += 1;
          if (!entry.isFile()) return undefined;
          const tile = parseTileFileName(entry.name);
          if (!tile) return undefined;
          tiles += 1;
          state.tiles += 1;
          state.extCounts.set(tile.ext, (state.extCounts.get(tile.ext) ?? 0) + 1);
          if (state.sample.length < state.sampleBudget) {
            state.sample.push({ z, x, y: tile.y });
          }
          return tiles >= budget || state.entries >= limits.maxTotalEntries ? false : undefined;
        },
        storage,
      );
      if (sampled.truncated) state.truncated = true;
    }
    levels.push({ z, tiles });
  }

  const extensions = [...state.extCounts.keys()].sort((a, b) => a.localeCompare(b));
  const primaryExt =
    [...state.extCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
  return {
    kind: 'xyz',
    dir: realPath,
    levels,
    extensions,
    primaryExt,
    tileCount: state.tiles,
    truncated: state.truncated,
    scannedEntries: state.entries,
    bounds: boundsFromTileKeys(state.sample),
    boundsSampleTiles: state.sample.length,
  };
}

// ---------------------------------------------------------------------------
// 扫描 → 模板导入参数（desktop:import-xyz-from-disk 的纯逻辑）
// ---------------------------------------------------------------------------

/** 桌面端模板导入参数（渲染侧直接喂给 importCacheByTemplate / t25 链路） */
export interface XyzDiskImportParams {
  /** realpath 后的源目录（随场景保存进 metadata.detection.sourceDir） */
  dir: string;
  /** 目录名（图层缺省名） */
  name: string;
  /** file:// 基准地址 */
  baseUrl: string;
  /** 完整瓦片模板 `<file:///…>/{z}/{x}/{y}.<ext>` */
  template: string;
  ext: string;
  minZoom: number;
  maxZoom: number;
  /** 有界计数瓦片数（下限） */
  tileCount: number;
  truncated: boolean;
  /** 采样推算范围（可能 undefined） */
  bounds: [number, number, number, number] | undefined;
  levels: number[];
}

/** 由扫描结果推导 t25 模板导入参数（file:// 模板，Electron webSecurity:false 可直接加载） */
export function buildDiskImportParams(scan: XyzDiskScanResult): XyzDiskImportParams {
  if (scan.levels.length === 0 || !scan.primaryExt) {
    throw new XyzDiskError(
      'not-xyz',
      `目录中没有可用的 XYZ 瓦片（白名单扩展名：${XYZ_DISK_TILE_EXTENSIONS.join('/')}）：${scan.dir}`,
    );
  }
  const baseUrl = pathToFileURL(scan.dir).href;
  const template = `${baseUrl}/{z}/{x}/{y}.${scan.primaryExt}`;
  return {
    dir: scan.dir,
    name: path.basename(scan.dir) || '瓦片缓存',
    baseUrl,
    template,
    ext: scan.primaryExt,
    minZoom: scan.levels[0]!.z,
    maxZoom: scan.levels[scan.levels.length - 1]!.z,
    tileCount: scan.tileCount,
    truncated: scan.truncated,
    bounds: scan.bounds,
    levels: scan.levels.map((level) => level.z),
  };
}

// ---------------------------------------------------------------------------
// 流式 ZIP 写入器（恒定内存；data descriptor + 中央目录暂存临时文件）
// 布局与服务端 t34 exportJob 同构（同一套 APPNOTE 规则与 ZIP64 处理），独立实现。
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** 增量 CRC-32（初始值 0，多次调用链式传递；zlib 同款语义） */
export function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < chunk.length; i += 1) {
    c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

function dosDateTime(date: Date | undefined): [number, number] {
  const t = date?.getTime();
  if (typeof t !== 'number' || !Number.isFinite(t) || !date) return [0, 0x21]; // 1980-01-01 00:00
  const year = Math.max(1980, date.getFullYear());
  const month = Math.min(12, Math.max(1, date.getMonth() + 1));
  const day = Math.min(31, Math.max(1, date.getDate()));
  const hours = Math.min(23, Math.max(0, date.getHours()));
  const minutes = Math.min(59, Math.max(0, date.getMinutes()));
  const seconds = Math.min(59, Math.max(0, date.getSeconds()));
  const dosTime = (hours << 11) | (minutes << 5) | Math.floor(seconds / 2);
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return [dosTime, dosDate];
}

const U32_MAX = 0xffffffff;

interface ZipEntryRecord {
  nameBuf: Buffer;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  usize: number;
  csize: number;
  offset: number;
}

export class StreamingZipWriter {
  private readonly storage: CacheStorage;
  private fh: CacheFileHandle | null = null;
  private cdFh: CacheFileHandle | null = null;
  private cdTmpPath = '';
  private pos = 0;
  private count = 0;
  private anyZip64 = false;

  constructor(storage: CacheStorage = nodeCacheStorage) {
    this.storage = storage;
  }

  async open(zipPath: string, cdTmpPath: string): Promise<void> {
    this.fh = await this.storage.open(zipPath, 'w');
    this.cdFh = await this.storage.open(cdTmpPath, 'w');
    this.cdTmpPath = cdTmpPath;
    this.pos = 0;
    this.count = 0;
    this.anyZip64 = false;
  }

  private async append(buf: Buffer): Promise<void> {
    if (!this.fh) throw new XyzDiskError('io', 'StreamingZipWriter 未打开');
    await this.fh.write(buf);
    this.pos += buf.length;
  }

  /**
   * 追加一个文件条目：流式读取 filePath（可选 deflateRaw），恒定内存。
   * 读取/压缩过程中 abort 经由 pipeline 的 signal 立即中断。
   */
  async addFile(
    name: string,
    filePath: string,
    opts: { store?: boolean; mtime?: Date; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this.fh || !this.cdFh) throw new XyzDiskError('io', 'StreamingZipWriter 未打开');
    const fh = this.fh;
    const writer = this;
    const st = await this.storage.stat(filePath);
    if (!st.isFile()) throw new XyzDiskError('io', `不是常规文件: ${filePath}`);
    // 单条目 ≥ 4GB 需要 ZIP64 本地头 + 8 字节数据描述符；瓦片场景不存在，明确拒绝。
    if (st.size > U32_MAX - 4096) {
      throw new XyzDiskError('invalid-spec', `单文件过大无法写入 ZIP 条目（≥4GB）: ${name}`);
    }
    const nameBuf = Buffer.from(name, 'utf8');
    if (nameBuf.length > 0xffff) throw new XyzDiskError('invalid-spec', `ZIP 条目名过长: ${name}`);
    const [dosTime, dosDate] = dosDateTime(opts.mtime ?? st.mtime);
    const method = opts.store ? 0 : 8;
    const offset = this.pos;

    const header = Buffer.alloc(30 + nameBuf.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0808, 6); // flags: bit11 UTF-8 + bit3 data descriptor
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(0, 14); // crc（在数据描述符中）
    header.writeUInt32LE(0, 18); // csize
    header.writeUInt32LE(0, 22); // usize
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    nameBuf.copy(header, 30);
    await this.append(header);

    const state = { crc: 0, usize: 0, csize: 0 };
    const crcTap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        state.crc = crc32Update(state.crc, chunk);
        state.usize += chunk.length;
        cb(null, chunk);
      },
    });
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        state.csize += chunk.length;
        fh.write(chunk).then(
          () => {
            writer.pos += chunk.length;
            cb();
          },
          (err: Error) => cb(err),
        );
      },
    });
    const compressor = opts.store ? null : createDeflateRaw();
    const tileStream = this.storage.createReadStream(filePath, { highWaterMark: TILE_READ_HIGH_WATER_MARK });
    if (compressor) {
      await pipeline(
        tileStream,
        crcTap,
        compressor,
        sink,
        { signal: opts.signal },
      );
    } else {
      await pipeline(
        tileStream,
        crcTap,
        sink,
        { signal: opts.signal },
      );
    }

    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(state.crc >>> 0, 4);
    dd.writeUInt32LE(state.csize, 8);
    dd.writeUInt32LE(state.usize, 12);
    await this.append(dd);

    await this.appendCdRecord({
      nameBuf,
      method,
      dosTime,
      dosDate,
      crc: state.crc >>> 0,
      usize: state.usize,
      csize: state.csize,
      offset,
    });
    this.count += 1;
  }

  private async appendCdRecord(e: ZipEntryRecord): Promise<void> {
    if (!this.cdFh) throw new XyzDiskError('io', 'StreamingZipWriter 未打开');
    const entryZip64 = e.usize > U32_MAX || e.csize > U32_MAX || e.offset > U32_MAX;
    const extraLen = entryZip64 ? 4 + 24 : 0; // header(4) + usize8 + csize8 + offset8
    const rec = Buffer.alloc(46 + e.nameBuf.length + extraLen);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE((3 << 8) | (entryZip64 ? 45 : 20), 4); // version made by (Unix)
    rec.writeUInt16LE(entryZip64 ? 45 : 20, 6); // version needed
    rec.writeUInt16LE(0x0808, 8);
    rec.writeUInt16LE(e.method, 10);
    rec.writeUInt16LE(e.dosTime, 12);
    rec.writeUInt16LE(e.dosDate, 14);
    rec.writeUInt32LE(e.crc, 16);
    rec.writeUInt32LE(entryZip64 ? U32_MAX : e.csize, 20);
    rec.writeUInt32LE(entryZip64 ? U32_MAX : e.usize, 24);
    rec.writeUInt16LE(e.nameBuf.length, 28);
    rec.writeUInt16LE(extraLen, 30);
    rec.writeUInt16LE(0, 32); // comment len
    rec.writeUInt16LE(0, 34); // disk start
    rec.writeUInt16LE(0, 36); // internal attrs
    rec.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: 常规文件 0644
    rec.writeUInt32LE(entryZip64 ? U32_MAX : e.offset, 42);
    e.nameBuf.copy(rec, 46);
    if (entryZip64) {
      const extraAt = 46 + e.nameBuf.length;
      rec.writeUInt16LE(0x0001, extraAt);
      rec.writeUInt16LE(24, extraAt + 2);
      rec.writeBigUInt64LE(BigInt(e.usize), extraAt + 4);
      rec.writeBigUInt64LE(BigInt(e.csize), extraAt + 8);
      rec.writeBigUInt64LE(BigInt(e.offset), extraAt + 12);
      this.anyZip64 = true;
    }
    await this.cdFh.write(rec);
  }

  /** 中央目录落盘 → 写 EOCD（必要时 ZIP64）→ 返回最终大小与条目数 */
  async finalize(signal?: AbortSignal): Promise<{ size: number; entries: number }> {
    if (!this.fh) throw new XyzDiskError('io', 'StreamingZipWriter 未打开');
    const cdOffset = this.pos;
    const cdFh = this.cdFh;
    if (!cdFh) throw new XyzDiskError('io', 'StreamingZipWriter 中央目录句柄为空');
    this.cdFh = null;
    try {
      await cdFh.close();
    } catch {
      /* noop */
    }
    // 中央目录临时文件流式读出并拼接（目录本身在临时文件里，内存不随条目数增长）
    const rs = this.storage.createReadStream(this.cdTmpPath, { highWaterMark: 1024 * 1024 });
    for await (const chunk of rs) {
      if (signal?.aborted) {
        rs.destroy();
        throw new XyzDiskError('io', 'aborted');
      }
      await this.append(chunk);
    }
    const cdSize = this.pos - cdOffset;
    const needZip64 = this.anyZip64 || this.count >= 0xffff || cdSize > U32_MAX || cdOffset > U32_MAX;
    if (needZip64) {
      const z64 = Buffer.alloc(56);
      z64.writeUInt32LE(0x06064b50, 0);
      z64.writeBigUInt64LE(44n, 4); // 剩余记录长度
      z64.writeUInt16LE((3 << 8) | 45, 12);
      z64.writeUInt16LE(45, 14);
      z64.writeUInt32LE(0, 16);
      z64.writeUInt32LE(0, 20);
      z64.writeBigUInt64LE(BigInt(this.count), 24);
      z64.writeBigUInt64LE(BigInt(this.count), 32);
      z64.writeBigUInt64LE(BigInt(cdSize), 40);
      z64.writeBigUInt64LE(BigInt(cdOffset), 48);
      await this.append(z64);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
      loc.writeUInt32LE(1, 16);
      await this.append(loc);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(Math.min(this.count, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(this.count, 0xffff), 10);
    eocd.writeUInt32LE(needZip64 ? U32_MAX : cdSize, 12);
    eocd.writeUInt32LE(needZip64 ? U32_MAX : cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await this.append(eocd);
    await this.fh.close();
    this.fh = null;
    return { size: this.pos, entries: this.count };
  }

  /** 中止/失败清理：关闭句柄（半成品文件由调用方删除） */
  async dispose(): Promise<void> {
    for (const fh of [this.fh, this.cdFh]) {
      if (!fh) continue;
      try {
        await fh.close();
      } catch {
        /* noop */
      }
    }
    this.fh = null;
    this.cdFh = null;
  }
}

// ---------------------------------------------------------------------------
// 流式导出
// ---------------------------------------------------------------------------

export type DiskExportFormat = 'zip' | 'directory';

export type DiskExportPhase = 'prepare' | 'packing' | 'finalizing' | 'done' | 'failed' | 'cancelled';

export interface DiskExportSpec {
  /** 源目录（绝对路径；运行前会 realpath 规范化） */
  srcDir: string;
  /** 产物形态：zip（流式打包）或 directory（瓦片树直拷） */
  format: DiskExportFormat;
  /** 目标绝对路径：zip 文件路径 / 目标目录路径 */
  dest: string;
  /** 裁剪范围（缺省全球） */
  bounds?: readonly [number, number, number, number];
  minZoom?: number;
  maxZoom?: number;
  /** 瓦片扩展名（缺省从源目录有界抽样推导；必须在白名单内） */
  ext?: string;
  /** 切片模式（缺省 web-mercator） */
  tilingMode?: XyzDiskTilingMode;
  /** TMS（缺省 false） */
  tms?: boolean;
  /** ZIP 是否 deflate（缺省 false = STORE；影像已是压缩格式，STORE 更快） */
  compress?: boolean;
}

/** 导出进度（单调不减；rate 为 10s 滑动窗口瓦片/秒） */
export interface DiskExportProgress {
  phase: DiskExportPhase;
  doneTiles: number;
  totalTiles: number;
  doneBytes: number;
  skippedTiles: number;
  rate: number;
}

export interface DiskExportResult {
  status: 'done' | 'failed' | 'cancelled';
  output: string;
  fileCount: number;
  totalBytes: number;
  skippedTiles: number;
  durationMs: number;
  error?: string;
}

/** 规范化后的导出规格（全部字段收敛为运行所需的确定形态） */
export interface NormalizedDiskExportSpec extends Required<Omit<DiskExportSpec, 'bounds'>> {
  bounds: readonly [number, number, number, number] | undefined;
}

/** 规范化 + 校验导出规格（纯编排；抛 XyzDiskError） */
export async function normalizeDiskExportSpec(
  spec: unknown,
  options: { storage?: CacheStorage } = {},
): Promise<{
  spec: NormalizedDiskExportSpec;
  totalTiles: number;
}> {
  const storage = options.storage ?? nodeCacheStorage;
  if (!spec || typeof spec !== 'object') {
    throw new XyzDiskError('invalid-spec', '导出规格缺失');
  }
  const raw = spec as DiskExportSpec;
  if (raw.format !== 'zip' && raw.format !== 'directory') {
    throw new XyzDiskError('invalid-spec', `format 必须为 'zip' 或 'directory'（收到：${String(raw.format)}）`);
  }
  if (typeof raw.srcDir !== 'string' || raw.srcDir.trim() === '') {
    throw new XyzDiskError('invalid-spec', '源瓦片目录不能为空');
  }
  const { realPath } = await parseDiskDir(raw.srcDir, '源瓦片目录', storage);
  const destAbs = assertExportPaths(realPath, raw.dest, raw.format);
  if (raw.minZoom !== undefined && !Number.isInteger(raw.minZoom)) {
    throw new XyzDiskError('invalid-spec', `minZoom 必须为整数（收到：${String(raw.minZoom)}）`);
  }
  if (raw.maxZoom !== undefined && !Number.isInteger(raw.maxZoom)) {
    throw new XyzDiskError('invalid-spec', `maxZoom 必须为整数（收到：${String(raw.maxZoom)}）`);
  }
  const minZoom = Math.max(0, Math.floor(raw.minZoom ?? 0));
  const maxZoom = Math.min(XYZ_DISK_MAX_ZOOM, Math.floor(raw.maxZoom ?? XYZ_DISK_MAX_ZOOM));
  if (minZoom > maxZoom) {
    throw new XyzDiskError('invalid-spec', `minZoom（${minZoom}）不能大于 maxZoom（${maxZoom}）`);
  }
  const tilingMode: XyzDiskTilingMode = raw.tilingMode === 'geographic' ? 'geographic' : 'web-mercator';
  let ext = typeof raw.ext === 'string' ? raw.ext.toLowerCase().replace(/^\./, '') : '';
  if (ext && !XYZ_DISK_TILE_EXTENSIONS.includes(ext)) {
    throw new XyzDiskError(
      'invalid-spec',
      `瓦片扩展名必须在白名单内（${XYZ_DISK_TILE_EXTENSIONS.join('/')}）：${ext}`,
    );
  }
  if (!ext) {
    // 未显式给 ext：有界抽样探测主扩展名（小预算，开销有界）
    const probe = await scanXyzDirectory(realPath, {
      limits: { maxTotalEntries: 5_000, maxTilesPerLevel: 256, boundsSampleTiles: 16 },
      ...(options.storage ? { storage: options.storage } : {}),
    });
    if (!probe.primaryExt) {
      throw new XyzDiskError(
        'not-xyz',
        `源目录中未探测到白名单内瓦片（${XYZ_DISK_TILE_EXTENSIONS.join('/')}）：${realPath}`,
      );
    }
    ext = probe.primaryExt;
  }
  const normalized: NormalizedDiskExportSpec = {
    srcDir: realPath,
    format: raw.format,
    dest: destAbs,
    bounds: raw.bounds ?? undefined,
    minZoom,
    maxZoom,
    ext,
    tilingMode,
    tms: raw.tms === true,
    compress: raw.compress === true,
  };
  const { totalTiles } = estimateFilterTileCount({
    ...(normalized.bounds ? { bounds: normalized.bounds } : {}),
    minZoom,
    maxZoom,
    tilingMode,
    tms: normalized.tms,
  });
  return { spec: normalized, totalTiles };
}

export interface DiskExportHooks {
  /** 进度回调（运行器内部已节流；回调异常被吞掉） */
  onProgress?: (progress: DiskExportProgress) => void;
  /** AbortSignal（取消） */
  signal?: AbortSignal;
  /** 磁盘存储实现（缺省 nodeCacheStorage） */
  storage?: CacheStorage;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 目标目录准备：不存在 → 创建；存在 → 必须是空目录 */
async function prepareDirectoryDest(dest: string, storage: CacheStorage): Promise<void> {
  const stat = await storage.stat(dest).catch(() => undefined);
  if (stat) {
    if (!stat.isDirectory()) {
      throw new XyzDiskError('dest-conflict', `导出目标已存在且不是目录：${dest}`);
    }
    const children = await storage.readdir(dest, { withFileTypes: true }).catch(() => ['(readdir failed)' as unknown as CacheDirent]);
    if (children.length > 0) {
      throw new XyzDiskError('dest-conflict', `导出目标目录非空（${children.length} 个条目）：${dest}`);
    }
    return;
  }
  await storage.mkdir(dest, { recursive: true });
}

/** 半成品清理：zip → 删 zip + .cd 临时文件；directory → 整体删除目标目录 */
async function cleanupHalfProducts(format: DiskExportFormat, dest: string, storage: CacheStorage): Promise<void> {
  try {
    if (format === 'zip') {
      await storage.rm(dest, { force: true });
      await storage.rm(`${dest}.cd`, { force: true });
    } else {
      await storage.rm(dest, { recursive: true, force: true });
    }
  } catch {
    /* 清理失败不掩盖原始错误 */
  }
}

/**
 * 磁盘瓦片流式导出（恒定内存）：
 * - 逐层 z → x 连续段 → y → x 遍历（公式法区间，与 tilePassesFilter 同源）；
 * - 每瓦片 stat（缺失跳过并计数）→ zip：StreamingZipWriter.addFile / directory：copyFile；
 * - AbortSignal 取消 + 半成品清理；进度按瓦片数/字节回调（节流 + 相位切换必发）。
 *
 * 本函数**不抛异常**：失败/取消以 `status: 'failed' | 'cancelled'` 返回（含清理后的状态）。
 */
export async function runDiskTileExport(
  normalized: NormalizedDiskExportSpec,
  totalTiles: number,
  hooks: DiskExportHooks = {},
): Promise<DiskExportResult> {
  const storage = hooks.storage ?? nodeCacheStorage;
  const startedAt = Date.now();
  const signal = hooks.signal;
  const filter: XyzDiskTileFilter = {
    ...(normalized.bounds ? { bounds: normalized.bounds } : {}),
    minZoom: normalized.minZoom,
    maxZoom: normalized.maxZoom,
    tilingMode: normalized.tilingMode,
    tms: normalized.tms,
  };
  const progress: DiskExportProgress = {
    phase: 'prepare',
    doneTiles: 0,
    totalTiles,
    doneBytes: 0,
    skippedTiles: 0,
    rate: 0,
  };
  const rateSamples: Array<{ t: number; tiles: number }> = [];
  let lastEmit = 0;
  const emit = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastEmit < 120) return;
    lastEmit = now;
    const fresh = rateSamples.filter((s) => now - s.t <= RATE_WINDOW_MS);
    if (fresh.length >= 2) {
      const first = fresh[0]!;
      const last = fresh[fresh.length - 1]!;
      const dt = (last.t - first.t) / 1000;
      progress.rate = dt > 0 ? Math.max(0, (last.tiles - first.tiles) / dt) : 0;
    } else {
      progress.rate = 0;
    }
    try {
      hooks.onProgress?.({ ...progress });
    } catch {
      /* 进度回调异常不影响导出 */
    }
  };
  const noteRate = (): void => {
    const now = Date.now();
    const last = rateSamples[rateSamples.length - 1];
    if (last && now - last.t < 250) return;
    rateSamples.push({ t: now, tiles: progress.doneTiles });
    while (rateSamples.length > 2 && now - rateSamples[0]!.t > RATE_WINDOW_MS) rateSamples.shift();
  };

  const writer = new StreamingZipWriter(storage);
  let opened = false;
  try {
    if (normalized.format === 'zip') {
      await storage.rm(normalized.dest, { force: true });
      await writer.open(normalized.dest, `${normalized.dest}.cd`);
      opened = true;
    } else {
      await prepareDirectoryDest(normalized.dest, storage);
    }
    signal?.throwIfAborted();
    progress.phase = 'packing';
    emit(true);

    const bounds = normalized.bounds ?? XYZ_DISK_WORLD_BOUNDS;
    const ext = normalized.ext;
    let lastDir = '';
    for (let z = normalized.minZoom; z <= normalized.maxZoom; z += 1) {
      const spans = xSpansForBounds(bounds, z, normalized.tilingMode);
      const [yTop, yBottom] = yRangeForBounds(bounds, z, normalized.tilingMode);
      const n = 2 ** z;
      for (const [x0, x1] of spans) {
        for (let y = yTop; y <= yBottom; y += 1) {
          const fileY = normalized.tms ? n - 1 - y : y; // TMS 文件名自南向北
          for (let x = x0; x <= x1; x += 1) {
            signal?.throwIfAborted();
            if (!tilePassesFilter(z, x, y, filter)) continue;
            const full = path.join(normalized.srcDir, String(z), String(x), `${fileY}.${ext}`);
            let st: CacheStats | null = null;
            try {
              st = await storage.stat(full);
            } catch {
              st = null;
            }
            if (!st || !st.isFile()) {
              progress.skippedTiles += 1;
              continue;
            }
            if (normalized.format === 'zip') {
              await writer.addFile(`${z}/${x}/${fileY}.${ext}`, full, {
                store: !normalized.compress,
                mtime: st.mtime,
                ...(signal ? { signal } : {}),
              });
            } else {
              const destDir = path.join(normalized.dest, String(z), String(x));
              if (destDir !== lastDir) {
                await storage.mkdir(destDir, { recursive: true });
                lastDir = destDir;
              }
              await storage.copyFile(full, path.join(destDir, `${fileY}.${ext}`));
            }
            progress.doneTiles += 1;
            progress.doneBytes += st.size;
            noteRate();
            if ((progress.doneTiles & 0x7f) === 0) {
              emit();
              await yieldToEventLoop();
            }
          }
        }
      }
    }

    signal?.throwIfAborted();
    progress.phase = 'finalizing';
    emit(true);
    if (normalized.format === 'zip') {
      await writer.finalize(signal);
      opened = false;
    }
    progress.phase = 'done';
    emit(true);
    return {
      status: 'done',
      output: normalized.dest,
      fileCount: progress.doneTiles,
      totalBytes: progress.doneBytes,
      skippedTiles: progress.skippedTiles,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const cancelled = signal?.aborted === true || (err as { code?: string })?.code === 'ABORT_ERR';
    await writer.dispose();
    await cleanupHalfProducts(normalized.format, normalized.dest, storage);
    const message = cancelled ? '导出已取消' : err instanceof Error ? err.message : String(err);
    progress.phase = cancelled ? 'cancelled' : 'failed';
    emit(true);
    return {
      status: cancelled ? 'cancelled' : 'failed',
      output: normalized.dest,
      fileCount: progress.doneTiles,
      totalBytes: progress.doneBytes,
      skippedTiles: progress.skippedTiles,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  } finally {
    if (opened) await writer.dispose();
  }
}

// ---------------------------------------------------------------------------
// 导出任务运行器（jobId 注册表 + 节流进度事件）
// ---------------------------------------------------------------------------

export type DiskExportJobStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** 导出任务快照（main → renderer 经 'desktop:export-progress' 推送） */
export interface DiskExportJobSnapshot {
  jobId: string;
  status: DiskExportJobStatus;
  phase: DiskExportPhase;
  srcDir: string;
  dest: string;
  format: DiskExportFormat | undefined;
  minZoom: number;
  maxZoom: number;
  ext: string;
  doneTiles: number;
  totalTiles: number;
  doneBytes: number;
  skippedTiles: number;
  rate: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface DiskExportJob {
  snapshot: DiskExportJobSnapshot;
  controller: AbortController;
}

/** 导出任务运行器启动结果：jobId 立即可用；done 在任务落终态后 resolve（不 reject） */
export interface StartedDiskExportJob {
  jobId: string;
  done: Promise<DiskExportResult>;
}

/**
 * 桌面端导出任务运行器：
 * - start(spec, hooks)：**先校验规格**（失败同步/异步抛 XyzDiskError → IPC rejection，
 *   渲染侧能拿到可读原因），通过后注册任务并后台执行 runDiskTileExport；
 *   进度/终态经 onSnapshot 回调推送（节流 + 终态必发）；
 * - cancel(jobId)：abort（幂等）；返回是否命中了运行中的任务；
 * - 注册表有界（保留最近 32 个任务的最后快照，供诊断/查询）。
 */
export class XyzDiskExportRunner {
  private jobs = new Map<string, DiskExportJob>();

  async start(spec: unknown, hooks: { onSnapshot?: (snapshot: DiskExportJobSnapshot) => void; storage?: CacheStorage } = {}): Promise<StartedDiskExportJob> {
    // 规格校验：任何 XyzDiskError 都在注册任务之前抛出（IPC invoke 直接拒绝并带原因）
    const prepared = await normalizeDiskExportSpec(spec, { ...(hooks.storage ? { storage: hooks.storage } : {}) });
    const jobId = `xyz-export-${randomUUID()}`;
    const controller = new AbortController();
    const snapshot: DiskExportJobSnapshot = {
      jobId,
      status: 'running',
      phase: 'prepare',
      srcDir: prepared.spec.srcDir,
      dest: prepared.spec.dest,
      format: prepared.spec.format,
      minZoom: prepared.spec.minZoom,
      maxZoom: prepared.spec.maxZoom,
      ext: prepared.spec.ext,
      doneTiles: 0,
      totalTiles: prepared.totalTiles,
      doneBytes: 0,
      skippedTiles: 0,
      rate: 0,
      startedAt: Date.now(),
    };
    const job: DiskExportJob = { snapshot, controller };
    this.jobs.set(jobId, job);
    this.trimJobs();

    const emitSnapshot = (): void => {
      try {
        hooks.onSnapshot?.({ ...job.snapshot });
      } catch {
        /* 快照回调异常不影响导出 */
      }
    };

    const done = runDiskTileExport(prepared.spec, prepared.totalTiles, {
      signal: controller.signal,
      ...(hooks.storage ? { storage: hooks.storage } : {}),
      onProgress: (p) => {
        job.snapshot.phase = p.phase;
        job.snapshot.doneTiles = p.doneTiles;
        job.snapshot.totalTiles = p.totalTiles;
        job.snapshot.doneBytes = p.doneBytes;
        job.snapshot.skippedTiles = p.skippedTiles;
        job.snapshot.rate = p.rate;
        emitSnapshot();
      },
    }).then((result) => {
      job.snapshot.phase =
        result.status === 'done' ? 'done' : result.status === 'cancelled' ? 'cancelled' : 'failed';
      job.snapshot.status = result.status;
      job.snapshot.doneTiles = result.fileCount;
      job.snapshot.doneBytes = result.totalBytes;
      job.snapshot.skippedTiles = result.skippedTiles;
      job.snapshot.finishedAt = Date.now();
      if (result.error) job.snapshot.error = result.error;
      emitSnapshot();
      return result;
    });

    return { jobId, done };
  }

  /** 取消任务（幂等）；返回是否命中了运行中的任务 */
  cancel(jobId: unknown): boolean {
    if (typeof jobId !== 'string') return false;
    const job = this.jobs.get(jobId);
    if (!job || job.snapshot.status !== 'running') return false;
    job.controller.abort();
    return true;
  }

  get(jobId: string): DiskExportJobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job.snapshot } : undefined;
  }

  /** 注册表有界（保留最近 32 个任务的最后快照） */
  private trimJobs(): void {
    while (this.jobs.size > 32) {
      const oldest = this.jobs.keys().next().value;
      if (oldest === undefined) break;
      this.jobs.delete(oldest);
    }
  }
}
