/**
 * 服务端流式导出任务（t34）——把超大本地 XYZ 缓存目录（或托管 slug）按
 * 子区域 / 层级裁剪后打包为 ZIP 下载。
 *
 * 为什么必须由服务端做：真实规模是「整个东北 z0–20 ≈ 44.8 亿瓦片 / 7.4TB 纯数据」，
 * 浏览器端枚举与打包都必然崩溃；服务端必须做到：
 *
 * 1. **公式法总数**：totalTiles 由 bounds + 层级范围用 2^z 网格与 bbox 求交直接算出，
 *    绝不枚举源目录——2.4M 文件的目录创建任务仍是百毫秒级（只有 O(z 层数) 次浮点运算
 *    + 有界抽样 stat）。切片换算与 editor 侧 tileRangeForExtent 语义一致（floor、
 *    边界经度归属东侧瓦片、纬度钳制 ±85.05112878°），但服务端独立实现，不跨包引入
 *    browser 代码；并在服务端补齐跨 180°（antimeridian）求交。
 * 2. **恒定内存流式打包**：逐瓦片「stat → createReadStream →（可选 zlib deflateRaw）
 *    → 追加写入 ZIP」，ZIP 条目用 data descriptor（general purpose bit 3）免回写补丁；
 *    中央目录逐条追加到临时文件、finalize 时流式拼接回主文件——因此**内存与瓦片数、
 *    总字节数都无关**（44.8 亿条目也不会撑爆 RSS），磁盘只多 ~0.6% 的中央目录开销。
 *    ZIP64（条目/归档 ≥ 4GB、条目数 ≥ 65535）按 APPNOTE 写 extra 字段与 EOCD64。
 * 3. **进度**：doneTiles / doneBytes 单调递增，rate 为 10s 滑动窗口（瓦片/秒），
 *    phase 流转 scanning → packing → finalizing → done | failed | cancelled。
 * 4. **取消**：AbortSignal 贯穿整个打包循环与每条 pipeline，取消后关闭句柄并删除半成品。
 * 5. **护栏**：估算瓦片数 / 字节数超过可配置上限（默认 2000 万瓦片 / 200GB）时拒绝
 *    创建并给出可执行建议（缩小 bbox / 降低 maxZoom / 分批 / 调整环境变量）。
 *
 * 安全模型（与 t26 同源）：
 * - 源目录必须是 GIS_HOST_DIR_ROOTS 白名单内的真实目录（复用 assertHostDirAllowed：
 *   realpath 规范化 + 越界拒绝），slug 源 additionally 校验注册表条目为 XYZ 托管；
 * - 瓦片扩展名走 t26 的 XYZ_TILE_EXTENSIONS 白名单；
 * - 产物只写入 DATA_DIR/exports/<id>.zip（与任何源目录物理隔离），meta 副档
 *   <id>.json 也在此目录；下载端点只允许流式返回「本任务注册的产物路径」，并做
 *   realpath 越界复核，id 为服务端生成的 UUID，猜测/穿越拿不到任何文件；
 * - 产物路径永不接受请求输入，杜绝路径穿越。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';

import { HttpError } from '../util/http.js';
import {
  XYZ_TILE_EXTENSIONS,
  assertHostDirAllowed,
} from './hostDirectory.js';
import { DATA_DIR, assertSafeId } from './storage.js';
import { getRegisteredService } from './registry.js';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 导出产物目录：DATA_DIR/exports/（与源目录隔离，仅服务端写入） */
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports');

/** 默认护栏：2000 万瓦片（约等于一次可完成的导出量级，磁盘/时长均可控） */
export const DEFAULT_EXPORT_MAX_TILES = 20_000_000;
/** 默认护栏：200GB（纯数据体积，不含 ZIP 结构开销） */
export const DEFAULT_EXPORT_MAX_BYTES = 200 * 1024 ** 3;
/** 默认并发任务上限（导出是重 I/O 任务，防止把磁盘打满） */
export const DEFAULT_EXPORT_MAX_CONCURRENT = 4;

export const EXPORT_MAX_TILES_ENV = 'GIS_EXPORT_MAX_TILES';
export const EXPORT_MAX_BYTES_ENV = 'GIS_EXPORT_MAX_BYTES';
export const EXPORT_MAX_CONCURRENT_ENV = 'GIS_EXPORT_MAX_CONCURRENT';

/** 允许导出的最大层级（2^24 网格下计数仍远小于 2^53） */
export const MAX_EXPORT_ZOOM = 24;
/** 全世界边界（纬度已按 Web Mercator 钳制） */
export const WORLD_BOUNDS: readonly [number, number, number, number] = [
  -180, -85.0511287798066, 180, 85.0511287798066,
];
/** Web Mercator 有效纬度上界（与 editor 侧 MERCATOR_MAX_LAT 同值） */
export const MERCATOR_MAX_LAT = 85.0511287798066;

/** 抽样估算字节数时每层最多 stat 的瓦片数（创建任务的开销与之成正比，保持有界） */
const SAMPLES_PER_LEVEL = 8;
/** rate 滑动窗口宽度（毫秒） */
const RATE_WINDOW_MS = 10_000;
/** rate 采样最小间隔（毫秒） */
const RATE_SAMPLE_MS = 200;
/** 逐瓦片读取的 highWaterMark（恒定内存的关键之一：小块缓冲） */
const TILE_READ_HIGH_WATER_MARK = 256 * 1024;

export type ExportSrcKind = 'slug' | 'dir';
export type ExportCompression = 'store' | 'deflate';
export type ExportPhase = 'scanning' | 'packing' | 'finalizing' | 'done' | 'failed' | 'cancelled';
export type ExportStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/** bounds：[west, south, east, north]（经纬度，度） */
export type ExportBounds = [number, number, number, number];

export interface ExportSrc {
  kind: ExportSrcKind;
  value: string;
}

export interface ExportPerLevelEstimate {
  tiles: number;
  bytes: number;
}

export interface ExportEstimate {
  totalTiles: number;
  /** 抽样估算的源数据字节数（每层 ≤ 8 个样本均值 × 层内瓦片数；0 表示未探到样本） */
  totalBytes: number;
  perLevel: Record<string, ExportPerLevelEstimate>;
}

export interface ExportLimits {
  maxTiles: number;
  maxBytes: number;
  maxConcurrent: number;
}

export interface ExportJobSnapshot {
  id: string;
  src: ExportSrc;
  bounds: ExportBounds | null;
  minZoom: number;
  maxZoom: number;
  format: 'zip';
  compression: ExportCompression;
  ext: string;
  status: ExportStatus;
  phase: ExportPhase;
  doneTiles: number;
  totalTiles: number;
  doneBytes: number;
  totalBytes: number;
  /** 打包速率（瓦片/秒，10s 滑动窗口） */
  rate: number;
  /** 打包时被跳过的瓦片（源里缺失/不可读） */
  skippedTiles: number;
  outputPath: string | null;
  outputSize: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  estimate: ExportEstimate | null;
}

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

// ---------------------------------------------------------------------------
// CRC-32（自实现，避免依赖 Node 版本差异的 zlib.crc32）
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

// ---------------------------------------------------------------------------
// 公式法：2^z 网格与 bbox 求交（与 editor tileRangeForExtent 语义一致 + 跨 180°）
// ---------------------------------------------------------------------------

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 经度 → 瓦片 x（floor 语义：边界经度归属东侧瓦片），结果钳制到 [0, 2^z-1] */
export function lngToTileX(lng: number, zoom: number): number {
  const n = 2 ** zoom;
  return clampInt(Math.floor(((lng + 180) / 360) * n), 0, n - 1);
}

/** 纬度 → 瓦片 y（floor 语义：边界纬度归属南侧瓦片），纬度先钳制到墨卡托范围 */
export function latToTileY(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  const clamped = Math.min(MERCATOR_MAX_LAT, Math.max(-MERCATOR_MAX_LAT, lat));
  const latRad = (clamped * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  return clampInt(y, 0, n - 1);
}

/**
 * bbox 的经度区间在 z 层命中的 x 连续段列表（含两端）。
 * east < west 视为跨 180°（如 [170, -170] = 170..180 ∪ -180..-170），
 * 返回两段且互不重叠。退化（west === east）为单列。
 */
export function xSpansForBounds(west: number, east: number, zoom: number): Array<[number, number]> {
  const n = 2 ** zoom;
  const w = Math.min(180, Math.max(-180, west));
  const e = Math.min(180, Math.max(-180, east));
  if (e >= w) return [[lngToTileX(w, zoom), lngToTileX(e, zoom)]];
  return [
    [lngToTileX(w, zoom), n - 1],
    [0, lngToTileX(e, zoom)],
  ];
}

/** bbox 的纬度区间在 z 层命中的 [yTop, yBottom]（含两端；极地自动钳制） */
export function yRangeForBounds(south: number, north: number, zoom: number): [number, number] {
  return [latToTileY(north, zoom), latToTileY(south, zoom)];
}

/** 单层瓦片数（公式法：列数 × 行数，绝不变irectory 枚举） */
export function estimateTilesForLevel(bounds: ExportBounds, zoom: number): number {
  const [west, south, east, north] = bounds;
  const spans = xSpansForBounds(west, east, zoom);
  const [yTop, yBottom] = yRangeForBounds(south, north, zoom);
  let cols = 0;
  for (const [x0, x1] of spans) cols += x1 - x0 + 1;
  return cols * (yBottom - yTop + 1);
}

/** 各层瓦片数（公式法） */
export function computeTileEstimate(
  bounds: ExportBounds,
  minZoom: number,
  maxZoom: number,
): { totalTiles: number; perLevelTiles: Record<string, number> } {
  const perLevelTiles: Record<string, number> = {};
  let totalTiles = 0;
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const tiles = estimateTilesForLevel(bounds, z);
    perLevelTiles[String(z)] = tiles;
    totalTiles += tiles;
  }
  return { totalTiles, perLevelTiles };
}

// ---------------------------------------------------------------------------
// bounds / 参数解析与校验
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asInt(v: unknown, label: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!isFiniteNumber(n) || !Number.isInteger(n)) {
    throw new HttpError(400, `${label} 必须为整数`);
  }
  return n;
}

/** 解析并校验 bounds：支持 [w,s,e,n] 数组或 {west,south,east,north} 对象 */
export function parseExportBounds(input: unknown): ExportBounds {
  let w: unknown;
  let s: unknown;
  let e: unknown;
  let n: unknown;
  if (Array.isArray(input) && input.length === 4) {
    [w, s, e, n] = input;
  } else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    w = o.west;
    s = o.south;
    e = o.east;
    n = o.north;
  } else {
    throw new HttpError(400, 'bounds 必须为 [west, south, east, north] 数组或同名键对象');
  }
  for (const [label, v] of [
    ['west', w],
    ['south', s],
    ['east', e],
    ['north', n],
  ] as const) {
    if (!isFiniteNumber(v)) throw new HttpError(400, `bounds.${label} 必须为有限数字`);
  }
  const west = Math.min(180, Math.max(-180, w as number));
  const east = Math.min(180, Math.max(-180, e as number));
  const south = s as number;
  const north = n as number;
  if (south > north) throw new HttpError(400, `bounds 非法：south(${south}) 不能大于 north(${north})`);
  return [west, south, east, north];
}

function parseExportSrc(input: unknown): ExportSrc {
  let kind: unknown;
  let value: unknown;
  if (typeof input === 'string' && input.trim()) {
    // 简写：以 / 开头的字符串按本地目录，否则按 slug
    kind = input.startsWith('/') ? 'dir' : 'slug';
    value = input;
  } else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    if (typeof o.kind === 'string') {
      kind = o.kind;
      value = o.value;
    } else if (typeof o.slug === 'string') {
      kind = 'slug';
      value = o.slug;
    } else if (typeof o.dir === 'string') {
      kind = 'dir';
      value = o.dir;
    }
  }
  if (kind !== 'slug' && kind !== 'dir') {
    throw new HttpError(400, "src 必须为 {kind:'slug'|'dir', value} / {slug} / {dir}（或目录字符串）");
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'src.value 不能为空');
  }
  return { kind, value };
}

// ---------------------------------------------------------------------------
// 源解析与有界探测（创建任务的开销与源文件数量级无关）
// ---------------------------------------------------------------------------

/** 有界列目录（opendirSync 惰性读取，最多 maxEntries 条；不物化超大目录） */
function listBounded(dir: string, maxEntries: number): fs.Dirent[] {
  const out: fs.Dirent[] = [];
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(dir);
  } catch {
    return out;
  }
  try {
    let entry = handle.readSync();
    while (entry && out.length < maxEntries) {
      out.push(entry);
      entry = handle.readSync();
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      /* noop */
    }
  }
  return out;
}

function extOf(name: string): string {
  return path.extname(name).replace(/^\./, '').toLowerCase();
}

export interface XyzSourceProbe {
  /** 顶层存在的数字层级（升序；用于缺省 zoom 范围） */
  levels: number[];
  /** 探测到的主扩展名（白名单内出现最多者） */
  primaryExt: string;
}

/**
 * 有界探测 XYZ 源目录：顶层 z 目录 + 少量层级的少量条目采样扩展名。
 * 只 readdir/stat 元数据，不读取瓦片内容，条目总量有界（≤ 数百）。
 */
export function probeXyzSource(dir: string): XyzSourceProbe {
  const top = listBounded(dir, 4096);
  const levels = top
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => Number(d.name))
    .sort((a, b) => a - b);
  if (levels.length === 0) {
    throw new HttpError(400, `目录结构不是 XYZ 瓦片树（顶层缺少数字层级目录）: ${dir}`);
  }
  // 在最低/中间/最高三个层级里采样扩展名（真实缓存各层扩展名一致）
  const picks = [...new Set([levels[0], levels[Math.floor(levels.length / 2)], levels[levels.length - 1]])];
  const counts = new Map<string, number>();
  let seen = 0;
  outer: for (const z of picks) {
    const levelDir = path.join(dir, String(z));
    const xDirs = listBounded(levelDir, 256)
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .slice(0, 8);
    for (const xd of xDirs) {
      const files = listBounded(path.join(levelDir, xd.name), 256);
      for (const f of files) {
        if (!f.isFile()) continue;
        const ext = extOf(f.name);
        if (!XYZ_TILE_EXTENSIONS.includes(ext)) continue;
        counts.set(ext, (counts.get(ext) ?? 0) + 1);
        seen += 1;
        if (seen >= 16) break outer;
      }
    }
  }
  const primaryExt =
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
  if (!primaryExt) {
    throw new HttpError(
      400,
      `未能在源目录中探测到白名单内瓦片扩展名（${XYZ_TILE_EXTENSIONS.join('/')}）：${dir}；可显式传 ext 参数`,
    );
  }
  return { levels, primaryExt };
}

/**
 * 解析导出源：slug → 注册表条目（必须为 XYZ 目录托管）；dir → 白名单校验。
 * 返回经 realpath 规范化、且位于 GIS_HOST_DIR_ROOTS 白名单内的源目录。
 */
export function resolveExportSourceDir(src: ExportSrc): string {
  if (src.kind === 'slug') {
    const entry = getRegisteredService(src.value);
    if (!entry) throw new HttpError(404, `托管服务不存在: ${src.value}`);
    if (!entry.hostDir || entry.hostKind !== 'xyz') {
      throw new HttpError(400, `托管服务 ${src.value} 不是 XYZ 瓦片目录（导出仅支持 XYZ 缓存目录）`);
    }
    // 注册后源目录可能被移动/软链改向：再次做白名单 + realpath 校验
    return assertHostDirAllowed(entry.hostDir);
  }
  return assertHostDirAllowed(src.value);
}

/** 抽样估算某层字节均值（≤ 8 次 stat；探不到样本返回 0） */
function sampleLevelAvgBytes(
  dir: string,
  bounds: ExportBounds,
  zoom: number,
  ext: string,
  maxSamples: number,
): number {
  const [west, south, east, north] = bounds;
  const spans = xSpansForBounds(west, east, zoom);
  const [yTop, yBottom] = yRangeForBounds(south, north, zoom);
  let cols = 0;
  for (const [x0, x1] of spans) cols += x1 - x0 + 1;
  const rows = yBottom - yTop + 1;
  if (cols <= 0 || rows <= 0) return 0;
  const k = Math.min(maxSamples, cols * rows);
  const sizes: number[] = [];
  for (let i = 0; i < k; i += 1) {
    // 在列范围内等距取样，y 在上下边缘交替
    const colTarget = k === 1 ? 0 : Math.round((i * (cols - 1)) / (k - 1));
    let x = -1;
    let acc = 0;
    for (const [x0, x1] of spans) {
      const span = x1 - x0 + 1;
      if (colTarget < acc + span) {
        x = x0 + (colTarget - acc);
        break;
      }
      acc += span;
    }
    if (x < 0) continue;
    const y = i % 2 === 0 ? yTop : yBottom;
    try {
      const st = fs.statSync(path.join(dir, String(zoom), String(x), `${y}.${ext}`));
      if (st.isFile()) sizes.push(st.size);
    } catch {
      /* 缺失的样本直接忽略 */
    }
  }
  if (sizes.length === 0) return 0;
  return sizes.reduce((a, b) => a + b, 0) / sizes.length;
}

/** 估算 bounds × 层级范围内的字节量（抽样法，开销有界） */
export function estimateBytes(
  dir: string,
  bounds: ExportBounds,
  minZoom: number,
  maxZoom: number,
  ext: string,
): { totalBytes: number; perLevelBytes: Record<string, number> } {
  const perLevelBytes: Record<string, number> = {};
  let totalBytes = 0;
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const avg = sampleLevelAvgBytes(dir, bounds, z, ext, SAMPLES_PER_LEVEL);
    perLevelBytes[String(z)] = avg;
    totalBytes += avg;
  }
  return { totalBytes, perLevelBytes };
}

// ---------------------------------------------------------------------------
// 护栏
// ---------------------------------------------------------------------------

function envNumber(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[export-job] 忽略非法环境变量值: ${JSON.stringify(raw)}`);
    return fallback;
  }
  return n;
}

export function resolveExportLimits(): ExportLimits {
  return {
    maxTiles: envNumber(process.env[EXPORT_MAX_TILES_ENV], DEFAULT_EXPORT_MAX_TILES),
    maxBytes: envNumber(process.env[EXPORT_MAX_BYTES_ENV], DEFAULT_EXPORT_MAX_BYTES),
    maxConcurrent: envNumber(process.env[EXPORT_MAX_CONCURRENT_ENV], DEFAULT_EXPORT_MAX_CONCURRENT),
  };
}

/** 计算满足瓦片上限的最大 maxZoom（供 413 建议用；找不到返回 null） */
function suggestMaxZoom(bounds: ExportBounds, minZoom: number, maxZoom: number, maxTiles: number): number | null {
  let best: number | null = null;
  let acc = 0;
  for (let z = minZoom; z <= maxZoom; z += 1) {
    acc += estimateTilesForLevel(bounds, z);
    if (acc <= maxTiles) best = z;
    else break;
  }
  return best;
}

function assertWithinCaps(
  bounds: ExportBounds,
  minZoom: number,
  maxZoom: number,
  estimate: ExportEstimate,
  limits: ExportLimits,
): void {
  if (limits.maxTiles > 0 && estimate.totalTiles > limits.maxTiles) {
    const perLevel = Object.entries(estimate.perLevel)
      .sort((a, b) => b[1].tiles - a[1].tiles)
      .slice(0, 3)
      .map(([z, v]) => `z${z}=${v.tiles.toLocaleString('en-US')}`)
      .join(', ');
    const suggested = suggestMaxZoom(bounds, minZoom, maxZoom, limits.maxTiles);
    const parts = [
      `导出规模超出上限：预估 ${estimate.totalTiles.toLocaleString('en-US')} 瓦片 > 上限 ${limits.maxTiles.toLocaleString('en-US')} 瓦片（大头：${perLevel}）。`,
      '可执行建议：① 缩小 bounds（子区域导出）；',
    ];
    if (suggested !== null && suggested < maxZoom) {
      parts.push(`② 降低 maxZoom 到 ${suggested}（该范围下预估 ≤ 上限）；`);
    } else {
      parts.push('② 降低 maxZoom；');
    }
    parts.push(
      '③ 分批导出（按层级或区域多次创建任务）；',
      `④ 确认磁盘与时长可承受后，用 ${EXPORT_MAX_TILES_ENV} / ${EXPORT_MAX_BYTES_ENV} 调整上限。`,
    );
    throw new HttpError(413, parts.join(''));
  }
  if (limits.maxBytes > 0 && estimate.totalBytes > limits.maxBytes) {
    throw new HttpError(
      413,
      `导出规模超出上限：预估数据量 ${(estimate.totalBytes / 1024 ** 3).toFixed(1)}GB > 上限 ` +
        `${(limits.maxBytes / 1024 ** 3).toFixed(0)}GB。可执行建议：缩小 bounds / 降低 maxZoom / 分批导出，` +
        `或用 ${EXPORT_MAX_BYTES_ENV} 调整上限（注意抽样估算可能偏低，实际以运行时复核为准）。`,
    );
  }
}

// ---------------------------------------------------------------------------
// 流式 ZIP 写入器（恒定内存；data descriptor + 中央目录暂存临时文件）
// ---------------------------------------------------------------------------

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

/**
 * 流式 ZIP 写入器：
 * - 本地条目头（flags = UTF-8 + bit3 数据描述符）→ 瓦片字节流 → 数据描述符；
 * - 中央目录记录即时追加到独立临时文件（内存不随条目数增长）；
 * - finalize 把中央目录流式拼接回主文件并写 EOCD（必要时 ZIP64）。
 */
export class StreamingZipWriter {
  private fh: fsp.FileHandle | null = null;
  private cdFh: fsp.FileHandle | null = null;
  private cdTmpPath = '';
  private pos = 0;
  private cdPos = 0;
  private count = 0;
  private anyZip64 = false;

  async open(zipPath: string, cdTmpPath: string): Promise<void> {
    this.fh = await fsp.open(zipPath, 'w');
    this.cdFh = await fsp.open(cdTmpPath, 'w');
    this.cdTmpPath = cdTmpPath;
    this.pos = 0;
    this.cdPos = 0;
    this.count = 0;
    this.anyZip64 = false;
  }

  private async append(buf: Buffer): Promise<void> {
    if (!this.fh) throw new Error('StreamingZipWriter 未打开');
    await this.fh.write(buf);
    this.pos += buf.length;
  }

  /**
   * 追加一个文件条目：流式读取 filePath（可选 deflateRaw），恒定内存。
   * 读取/压缩过程中 abort 会经由 pipeline 的 signal 立即中断。
   */
  async addFile(
    name: string,
    filePath: string,
    opts: { store?: boolean; mtime?: Date; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this.fh || !this.cdFh) throw new Error('StreamingZipWriter 未打开');
    const fh = this.fh;
    const writer = this;
    const st = await fsp.stat(filePath);
    if (!st.isFile()) throw new Error(`不是常规文件: ${filePath}`);
    // 单条目 ≥ 4GB 需 ZIP64 本地头 + 8 字节数据描述符；瓦片场景不存在，明确拒绝。
    if (st.size > U32_MAX - 4096) {
      throw new HttpError(413, `单文件过大无法写入 ZIP 条目（≥4GB）: ${name}`);
    }
    const nameBuf = Buffer.from(name, 'utf8');
    if (nameBuf.length > 0xffff) throw new HttpError(400, `ZIP 条目名过长: ${name}`);
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
            writer.advance(chunk.length);
            cb();
          },
          (err: Error) => cb(err),
        );
      },
    });
    const compressor = opts.store ? null : createDeflateRaw();
    if (compressor) {
      await pipeline(
        fs.createReadStream(filePath, { highWaterMark: TILE_READ_HIGH_WATER_MARK }),
        crcTap,
        compressor,
        sink,
        { signal: opts.signal },
      );
    } else {
      await pipeline(
        fs.createReadStream(filePath, { highWaterMark: TILE_READ_HIGH_WATER_MARK }),
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

    await this.appendCdRecord({ nameBuf, method, dosTime, dosDate, crc: state.crc >>> 0, usize: state.usize, csize: state.csize, offset });
    this.count += 1;
  }

  /** 数据写入完成后推进位置（仅在 sink / pipeline 写盘成功后调用） */
  advance(delta: number): void {
    this.pos += delta;
  }

  private async appendCdRecord(e: ZipEntryRecord): Promise<void> {
    if (!this.cdFh) throw new Error('StreamingZipWriter 未打开');
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
    this.cdPos += rec.length;
  }

  /** 中央目录落盘 → 写 EOCD（必要时 ZIP64）→ 返回最终大小与条目数 */
  async finalize(signal?: AbortSignal): Promise<{ size: number; entries: number }> {
    if (!this.fh || !this.cdFh) throw new Error('StreamingZipWriter 未打开');
    const cdOffset = this.pos;
    await this.cdFh.close();
    this.cdFh = null;
    const rs = fs.createReadStream(this.cdTmpPath, { highWaterMark: 1024 * 1024 });
    for await (const chunk of rs) {
      if (signal?.aborted) {
        rs.destroy();
        throw new Error('aborted');
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
// 任务模型与注册表
// ---------------------------------------------------------------------------

interface RateSample {
  t: number;
  tiles: number;
}

export class ExportJob {
  readonly id: string;
  readonly src: ExportSrc;
  readonly resolvedDir: string;
  readonly bounds: ExportBounds | null;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly format: 'zip' = 'zip';
  readonly compression: ExportCompression;
  readonly ext: string;
  readonly estimate: ExportEstimate;
  readonly outputPath: string;

  status: ExportStatus = 'pending';
  phase: ExportPhase = 'scanning';
  doneTiles = 0;
  totalTiles = 0;
  doneBytes = 0;
  totalBytes = 0;
  rate = 0;
  skippedTiles = 0;
  outputSize: number | null = null;
  error: string | null = null;
  startedAt: string | null = null;
  finishedAt: string | null = null;

  readonly abort = new AbortController();
  /** 取消任务（幂等）；等待任务落到终态用 whenSettled() */
  cancel(): void {
    this.abort.abort();
  }

  private rateSamples: RateSample[] = [];
  private settled: Promise<void>;
  private settleResolve: (() => void) | null = null;

  constructor(init: {
    id: string;
    src: ExportSrc;
    resolvedDir: string;
    bounds: ExportBounds | null;
    minZoom: number;
    maxZoom: number;
    compression: ExportCompression;
    ext: string;
    estimate: ExportEstimate;
  }) {
    this.id = init.id;
    this.src = init.src;
    this.resolvedDir = init.resolvedDir;
    this.bounds = init.bounds;
    this.minZoom = init.minZoom;
    this.maxZoom = init.maxZoom;
    this.compression = init.compression;
    this.ext = init.ext;
    this.estimate = init.estimate;
    this.totalTiles = init.estimate.totalTiles;
    this.totalBytes = init.estimate.totalBytes;
    this.outputPath = path.join(EXPORTS_DIR, `${init.id}.zip`);
    this.settled = new Promise<void>((resolve) => {
      this.settleResolve = resolve;
    });
  }

  whenSettled(): Promise<void> {
    return this.settled;
  }

  /** 打包循环内部：记录速率（10s 滑动窗口） */
  noteRate(): void {
    const now = Date.now();
    const last = this.rateSamples[this.rateSamples.length - 1];
    if (last && now - last.t < RATE_SAMPLE_MS) return;
    this.rateSamples.push({ t: now, tiles: this.doneTiles });
    while (this.rateSamples.length > 2 && now - this.rateSamples[0].t > RATE_WINDOW_MS) {
      this.rateSamples.shift();
    }
    const first = this.rateSamples[0];
    const lastSample = this.rateSamples[this.rateSamples.length - 1];
    const dt = (lastSample.t - first.t) / 1000;
    this.rate = dt > 0 ? Math.round(((lastSample.tiles - first.tiles) / dt) * 10) / 10 : 0;
  }

  settle(): void {
    this.settleResolve?.();
    this.settleResolve = null;
  }

  toSnapshot(): ExportJobSnapshot {
    const snap: ExportJobSnapshot = {
      id: this.id,
      src: { kind: this.src.kind, value: this.src.value },
      bounds: this.bounds ? ([...this.bounds] as ExportBounds) : null,
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      format: 'zip',
      compression: this.compression,
      ext: this.ext,
      status: this.status,
      phase: this.phase,
      doneTiles: this.doneTiles,
      totalTiles: this.totalTiles,
      doneBytes: this.doneBytes,
      totalBytes: this.totalBytes,
      rate: this.rate,
      skippedTiles: this.skippedTiles,
      outputPath: this.outputPath,
      outputSize: this.outputSize,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      estimate: this.estimate,
    };
    return snap;
  }
}

const jobs = new Map<string, ExportJob>();

export function getExportJob(id: string): ExportJob | null {
  if (typeof id !== 'string' || !id) return null;
  return jobs.get(id) ?? null;
}

export function listExportJobs(): ExportJobSnapshot[] {
  return [...jobs.values()]
    .map((j) => j.toSnapshot())
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}

// ---------------------------------------------------------------------------
// meta 副档（重启恢复：done 可恢复下载，其余视为中断并清理）
// ---------------------------------------------------------------------------

function metaPath(id: string): string {
  return path.join(EXPORTS_DIR, `${id}.json`);
}

function persistMeta(job: ExportJob): void {
  try {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    const tmp = `${metaPath(job.id)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(job.toSnapshot(), null, 2), 'utf8');
    fs.renameSync(tmp, metaPath(job.id));
  } catch (err) {
    console.warn(`[export-job] 写 meta 失败（不影响导出）: ${job.id}`, err);
  }
}

function removeMeta(id: string): void {
  try {
    fs.rmSync(metaPath(id), { force: true });
  } catch {
    /* noop */
  }
}

function isInsideExportsDir(p: string): boolean {
  const rel = path.relative(EXPORTS_DIR, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 重启恢复：done 任务的产物与 meta 仍在 → 重新注册（下载可用）；
 * 其余（pending/running/failed/cancelled）与孤儿 zip/cd → 视为中断，清理残留。
 */
export function restorePersistedExportJobs(): { restored: number; purged: number } {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  let restored = 0;
  let purged = 0;
  const seenZip = new Set<string>();
  for (const name of fs.readdirSync(EXPORTS_DIR)) {
    if (name.endsWith('.cd') || name.includes('.json.tmp-')) {
      fs.rmSync(path.join(EXPORTS_DIR, name), { force: true });
      purged += 1;
      continue;
    }
    if (name.endsWith('.zip')) {
      seenZip.add(name);
      continue;
    }
    if (!name.endsWith('.json')) continue;
    let meta: ExportJobSnapshot;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(EXPORTS_DIR, name), 'utf8')) as ExportJobSnapshot;
    } catch {
      fs.rmSync(path.join(EXPORTS_DIR, name), { force: true });
      purged += 1;
      continue;
    }
    const id = meta?.id;
    let valid = false;
    try {
      assertSafeId(id, '导出任务 id');
      valid =
        typeof meta.outputPath === 'string' &&
        path.basename(meta.outputPath) === `${id}.zip` &&
        path.dirname(meta.outputPath) === EXPORTS_DIR &&
        fs.existsSync(meta.outputPath);
    } catch {
      valid = false;
    }
    if (valid && meta.status === 'done' && meta.outputPath) {
      const job = reviveJobFromMeta(meta);
      jobs.set(job.id, job);
      restored += 1;
    } else {
      // 未完成任务的中断残留：删除 zip 与 meta
      try {
        if (typeof meta?.outputPath === 'string' && isInsideExportsDir(meta.outputPath)) {
          fs.rmSync(meta.outputPath, { force: true });
        }
      } catch {
        /* noop */
      }
      fs.rmSync(path.join(EXPORTS_DIR, name), { force: true });
      purged += 1;
    }
  }
  // 孤儿 zip（无 meta）：重启后无法再经 API 下载，直接清理
  for (const zip of seenZip) {
    if (fs.existsSync(path.join(EXPORTS_DIR, zip))) continue;
  }
  for (const zip of fs.readdirSync(EXPORTS_DIR)) {
    if (!zip.endsWith('.zip')) continue;
    if (fs.existsSync(path.join(EXPORTS_DIR, `${zip.replace(/\.zip$/, '')}.json`))) continue;
    fs.rmSync(path.join(EXPORTS_DIR, zip), { force: true });
    purged += 1;
  }
  if (restored + purged > 0) {
    console.log(`[export-job] 重启恢复：${restored} 个已完成任务恢复下载，清理 ${purged} 个残留项`);
  }
  return { restored, purged };
}

function reviveJobFromMeta(meta: ExportJobSnapshot): ExportJob {
  const job = new ExportJob({
    id: meta.id,
    src: meta.src,
    resolvedDir: '',
    bounds: meta.bounds,
    minZoom: meta.minZoom,
    maxZoom: meta.maxZoom,
    compression: meta.compression,
    ext: meta.ext,
    estimate: meta.estimate ?? { totalTiles: meta.totalTiles, totalBytes: meta.totalBytes, perLevel: {} },
  });
  job.status = 'done';
  job.phase = 'done';
  job.doneTiles = meta.doneTiles;
  job.doneBytes = meta.doneBytes;
  job.totalTiles = meta.totalTiles;
  job.totalBytes = meta.totalBytes;
  job.outputSize = meta.outputSize;
  job.startedAt = meta.startedAt;
  job.finishedAt = meta.finishedAt;
  return job;
}

// ---------------------------------------------------------------------------
// 打包执行
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function removeJobArtifacts(job: ExportJob): Promise<void> {
  await Promise.all([
    fsp.rm(job.outputPath, { force: true }).catch(() => undefined),
    fsp.rm(`${job.outputPath}.cd`, { force: true }).catch(() => undefined),
  ]);
}

/** 任务主流程：scanning → packing → finalizing → done | failed | cancelled */
async function runExportJob(job: ExportJob): Promise<void> {
  const limits = resolveExportLimits();
  const writer = new StreamingZipWriter();
  let opened = false;
  try {
    job.startedAt = nowIso();
    job.status = 'running';
    job.phase = 'scanning';
    persistMeta(job);

    // scanning：源目录仍存在 + 产物目录就绪（创建时已做过公式估算与抽样）
    fs.accessSync(job.resolvedDir);
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    await fsp.rm(job.outputPath, { force: true });

    const cdTmp = `${job.outputPath}.cd`;
    await writer.open(job.outputPath, cdTmp);
    opened = true;
    job.abort.signal.throwIfAborted();
    job.phase = 'packing';

    const bounds = job.bounds ?? ([...WORLD_BOUNDS] as ExportBounds);
    for (let z = job.minZoom; z <= job.maxZoom; z += 1) {
      const spans = xSpansForBounds(bounds[0], bounds[2], z);
      const [yTop, yBottom] = yRangeForBounds(bounds[1], bounds[3], z);
      for (const [x0, x1] of spans) {
        for (let y = yTop; y <= yBottom; y += 1) {
          for (let x = x0; x <= x1; x += 1) {
            job.abort.signal.throwIfAborted();
            const rel = `${z}/${x}/${y}.${job.ext}`;
            const full = path.join(job.resolvedDir, String(z), String(x), `${y}.${job.ext}`);
            let st: fs.Stats | null = null;
            try {
              st = fs.statSync(full);
            } catch {
              st = null;
            }
            if (!st || !st.isFile()) {
              job.skippedTiles += 1;
              continue;
            }
            await writer.addFile(rel, full, { store: job.compression === 'store', mtime: st.mtime, signal: job.abort.signal });
            job.doneTiles += 1;
            job.doneBytes += st.size;
            job.noteRate();
            if ((job.doneTiles & 0xff) === 0) await yieldToEventLoop();
            // 运行时字节复核：抽样估算可能偏低，实际写盘量以这里为准
            if (limits.maxBytes > 0 && job.doneBytes > limits.maxBytes) {
              throw new HttpError(
                413,
                `导出中止：已写入数据量 ${(job.doneBytes / 1024 ** 3).toFixed(1)}GB 超过运行时上限 ` +
                  `${(limits.maxBytes / 1024 ** 3).toFixed(0)}GB（${EXPORT_MAX_BYTES_ENV}）。请缩小 bounds / 降低 maxZoom / 分批导出。`,
              );
            }
          }
        }
      }
    }

    job.abort.signal.throwIfAborted();
    job.phase = 'finalizing';
    const { size } = await writer.finalize(job.abort.signal);
    opened = false;
    job.outputSize = size;
    job.phase = 'done';
    job.status = 'done';
    job.finishedAt = nowIso();
    persistMeta(job);
  } catch (err) {
    const cancelled = job.abort.signal.aborted || (err as { code?: string })?.code === 'ABORT_ERR';
    job.error = cancelled
      ? '任务已取消'
      : err instanceof Error
        ? err.message
        : String(err);
    job.phase = cancelled ? 'cancelled' : 'failed';
    job.status = cancelled ? 'cancelled' : 'failed';
    job.finishedAt = nowIso();
    await writer.dispose();
    await removeJobArtifacts(job);
    persistMeta(job);
    if (!cancelled) {
      console.warn(`[export-job] 任务失败 ${job.id}: ${job.error}`);
    }
  } finally {
    if (opened) await writer.dispose();
    job.settle();
  }
}

// ---------------------------------------------------------------------------
// 创建 / 取消 / 删除
// ---------------------------------------------------------------------------

export interface CreateExportJobInput {
  src?: unknown;
  bounds?: unknown;
  minZoom?: unknown;
  maxZoom?: unknown;
  format?: unknown;
  compression?: unknown;
  ext?: unknown;
}

/**
 * 创建导出任务（公式估算 + 护栏校验，均为有界开销；任务自动开始打包）。
 * 抛出 HttpError：400 参数非法 / 403 白名单 / 404 源不存在 / 413 超限 / 429 并发满。
 */
export function createExportJob(input: CreateExportJobInput): ExportJob {
  const src = parseExportSrc(input.src);
  if (input.format !== undefined && input.format !== 'zip') {
    throw new HttpError(400, `暂仅支持 format='zip'（收到: ${String(input.format)}）`);
  }
  const compression =
    input.compression === undefined ? 'store' : (input.compression as ExportCompression);
  if (compression !== 'store' && compression !== 'deflate') {
    throw new HttpError(400, "compression 必须为 'store' 或 'deflate'");
  }
  let ext: string | undefined;
  if (input.ext !== undefined) {
    if (typeof input.ext !== 'string' || !XYZ_TILE_EXTENSIONS.includes(input.ext.toLowerCase())) {
      throw new HttpError(400, `ext 必须为白名单扩展名之一: ${XYZ_TILE_EXTENSIONS.join('/')}`);
    }
    ext = input.ext.toLowerCase();
  }

  const dir = resolveExportSourceDir(src);
  const probe = probeXyzSource(dir);
  const effectiveExt = ext ?? probe.primaryExt;

  let minZoom: number;
  let maxZoom: number;
  if (input.minZoom === undefined && input.maxZoom === undefined) {
    minZoom = probe.levels[0];
    maxZoom = probe.levels[probe.levels.length - 1];
  } else {
    if (input.minZoom === undefined || input.maxZoom === undefined) {
      throw new HttpError(400, 'minZoom 与 maxZoom 必须成对提供（或都不提供以取源目录全部层级）');
    }
    minZoom = asInt(input.minZoom, 'minZoom');
    maxZoom = asInt(input.maxZoom, 'maxZoom');
  }
  if (minZoom < 0 || maxZoom > MAX_EXPORT_ZOOM) {
    throw new HttpError(400, `层级范围必须在 0–${MAX_EXPORT_ZOOM} 内（收到 ${minZoom}–${maxZoom}）`);
  }
  if (minZoom > maxZoom) {
    throw new HttpError(400, `minZoom(${minZoom}) 不能大于 maxZoom(${maxZoom})`);
  }
  const bounds = input.bounds === undefined || input.bounds === null ? null : parseExportBounds(input.bounds);
  const effectiveBounds = bounds ?? ([...WORLD_BOUNDS] as ExportBounds);

  // 公式法估算（绝不枚举源目录）+ 抽样字节估算
  const { totalTiles, perLevelTiles } = computeTileEstimate(effectiveBounds, minZoom, maxZoom);
  const { totalBytes, perLevelBytes } =
    totalTiles > 0
      ? estimateBytes(dir, effectiveBounds, minZoom, maxZoom, effectiveExt)
      : { totalBytes: 0, perLevelBytes: {} as Record<string, number> };
  const perLevel: Record<string, ExportPerLevelEstimate> = {};
  for (let z = minZoom; z <= maxZoom; z += 1) {
    perLevel[String(z)] = {
      tiles: perLevelTiles[String(z)] ?? 0,
      bytes: perLevelBytes[String(z)] ?? 0,
    };
  }
  const estimate: ExportEstimate = { totalTiles, totalBytes, perLevel };

  const limits = resolveExportLimits();
  assertWithinCaps(effectiveBounds, minZoom, maxZoom, estimate, limits);

  const running = [...jobs.values()].filter((j) => j.status === 'pending' || j.status === 'running');
  if (limits.maxConcurrent > 0 && running.length >= limits.maxConcurrent) {
    throw new HttpError(
      429,
      `导出任务并发已达上限（${limits.maxConcurrent}）：已有 ${running.length} 个任务在运行。` +
        `等待现有任务完成，或用 ${EXPORT_MAX_CONCURRENT_ENV} 调整上限。`,
    );
  }

  const job = new ExportJob({
    id: randomUUID(),
    src,
    resolvedDir: dir,
    bounds,
    minZoom,
    maxZoom,
    compression,
    ext: effectiveExt,
    estimate,
  });
  jobs.set(job.id, job);
  persistMeta(job);
  setImmediate(() => {
    void runExportJob(job);
  });
  return job;
}

/** 取消任务并等待终态（不删除注册表与产物；产物删除用 removeExportJob） */
export async function cancelExportJob(id: string): Promise<ExportJob> {
  const job = getExportJob(id);
  if (!job) throw new HttpError(404, `导出任务不存在: ${id}`);
  if (job.status === 'pending' || job.status === 'running') {
    job.cancel();
    await job.whenSettled();
  }
  return job;
}

/** 取消（若在跑）+ 删除产物与 meta + 移出注册表 */
export async function removeExportJob(id: string): Promise<{
  id: string;
  cancelled: boolean;
  removed: string[];
  message: string;
}> {
  const job = getExportJob(id);
  if (!job) throw new HttpError(404, `导出任务不存在: ${id}`);
  let cancelled = false;
  if (job.status === 'pending' || job.status === 'running') {
    job.cancel();
    await job.whenSettled();
    cancelled = true;
  }
  const removed: string[] = [];
  for (const p of [job.outputPath, `${job.outputPath}.cd`, metaPath(job.id)]) {
    try {
      await fsp.rm(p, { force: true });
      removed.push(path.basename(p));
    } catch {
      /* noop */
    }
  }
  jobs.delete(job.id);
  return {
    id: job.id,
    cancelled,
    removed,
    message: cancelled
      ? `已取消导出任务并清理临时产物: ${job.id}`
      : `已删除导出任务产物: ${job.id}`,
  };
}
