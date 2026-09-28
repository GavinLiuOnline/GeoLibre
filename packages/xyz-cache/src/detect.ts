/**
 * editor/core · localCache/detect —— 缓存目录结构探测（纯函数）
 *
 * 提供可在 vitest 单测里独立验证的工具：
 * - 相对路径规范化（POSIX 分隔符、去除 ./ 头部）
 * - webkitRelativePath → 根目录名 + 相对路径列表
 * - XYZ 瓦片路径识别（{z}/{x}/{y}.<ext> 或 {z}/{x}/{y}/<ext>）
 * - tileset.json 入口探测
 */
import type { CacheFileEntry, DirectoryFile } from './types';

/** 把任意路径分隔符统一为 POSIX（'/'），去掉开头的 './' */
export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// URL / 本地路径识别（t18）
// ---------------------------------------------------------------------------

/**
 * URL scheme 前缀（**≥2 个字符**，避免把 Windows 盘符 `C:` 误判为 scheme）。
 * 匹配 `file:`、`http:`、`blob:`、`data:` 等。
 */
const URL_SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]+):/;

/** 渲染进程可直接加载的瓦片协议（相对路径交给调用方按基准解析） */
const LOADABLE_TILE_PROTOCOLS = new Set(['blob:', 'data:', 'http:', 'https:']);

/** 取小写协议名（含冒号，如 `file:`）；无 scheme（含 `C:/...` 盘符路径）返回 null */
export function urlProtocolOf(value: string): string | null {
  const match = URL_SCHEME_PATTERN.exec(value.trim());
  return match ? `${match[1]!.toLowerCase()}:` : null;
}

/** 是否带 URL scheme（`C:/tiles/0/0/0.png`、`./a/b.png`、`a/b.png` 均返回 false） */
export function hasUrlScheme(value: string): boolean {
  return urlProtocolOf(value) !== null;
}

/** 是否 `file://` URL（本地磁盘路径） */
export function isFileUrl(value: string): boolean {
  return urlProtocolOf(value) === 'file:';
}

/**
 * `file://` URL → 本地文件系统路径。
 * - `file:///home/x` → `/home/x`
 * - `file://host/share/x` → `//host/share/x`
 * - 非 file:// URL / 非法转义 → 抛可读错误
 */
export function fileUrlToPath(url: string): string {
  const trimmed = url.trim();
  if (!isFileUrl(trimmed)) {
    throw new Error(`不是 file:// URL，无法转换为本地路径：${url}`);
  }
  try {
    const parsed = new URL(trimmed);
    const path = decodeURIComponent(parsed.pathname);
    return parsed.host ? `//${parsed.host}${path}` : path;
  } catch {
    throw new Error(`无法解析 file:// URL（含非法转义或格式错误）：${url}`);
  }
}

/**
 * 瓦片 URL 是否可被渲染进程直接加载（`blob:` / `data:` / `http(s):` / 相对路径）。
 *
 * `file:` 等本地协议返回 false —— 标准浏览器会拒绝从页面 fetch/file 图片；
 * 这类缓存必须先经 `importLocalCacheFromPath` 转成 Blob，或改用目录选择导入。
 */
export function isLoadableTileUrl(value: string): boolean {
  const protocol = urlProtocolOf(value);
  if (protocol === null) return true; // 相对路径，由调用方按基准解析
  return LOADABLE_TILE_PROTOCOLS.has(protocol);
}

/**
 * 从 webkitdirectory 选中的 File[] 中抽取：
 * - 根目录名（webkitRelativePath 第一段）
 * - 相对路径（去掉根段后的部分）
 * - 字节数
 *
 * 容错：未带相对路径的 File 视为非法（webkitdirectory 模式必有 webkitRelativePath）。
 */
export interface FlattenedFile {
  rootDir: string;
  relPath: string;
  size: number;
  file: File;
}

export function flattenDirectoryFiles(files: File[]): FlattenedFile[] {
  const out: FlattenedFile[] = [];
  for (const f of files) {
    const rel = (f as DirectoryFile).webkitRelativePath;
    if (!rel) continue;
    const normalized = normalizeRelativePath(rel);
    const parts = normalized.split('/');
    if (parts.length < 2) continue; // 跳过根目录本身
    const [rootDir, ...rest] = parts;
    out.push({ rootDir, relPath: rest.join('/'), size: f.size, file: f });
  }
  return out;
}

/** 给定扁平化列表，构造文件清单（不含 File 句柄的纯数据） */
export function toFileEntries(items: FlattenedFile[]): CacheFileEntry[] {
  return items.map((it) => ({ path: it.relPath, size: it.size }));
}

/** 命中扩展名的命中项 */
export interface NameHit {
  /** 相对路径（含目录），如 'Tiles/tileset.json' */
  path: string;
  /** 基名小写 */
  base: string;
}

/**
 * 在清单中按基名（小写）匹配；返回按路径最短优先的命中列表（最近根目录优先）。
 * 候选基名可不带扩展名（如 'tileset'）或带（如 'tileset.json'）。
 */
export function findByBasename(items: FlattenedFile[], candidates: string[]): NameHit[] {
  const cand = candidates.map((c) => c.toLowerCase());
  const hits = items
    .filter((it) => {
      const base = it.relPath.split('/').pop()?.toLowerCase() ?? '';
      return cand.includes(base);
    })
    .sort((a, b) => a.relPath.length - b.relPath.length);
  return hits.map((it) => ({
    path: it.relPath,
    base: (it.relPath.split('/').pop() ?? '').toLowerCase(),
  }));
}

/**
 * XYZ 瓦片路径识别：<dirs?>/{z}/{x}/{y}.<ext>
 * - 不支持 padding：{z} {x} {y} 必须是裸整数
 * - ext 是文件后缀（png/jpg/jpeg/webp/...)
 * - 允许任意层目录前缀（最末三层必须是 {z}/{x}/{y}.ext）
 */
const XYZ_PATTERN = /^(?:.+\/)?(\d+)\/(\d+)\/(\d+)\.([a-z0-9]+)$/i;

export interface XyzTileInfo {
  level: number;
  x: number;
  y: number;
  /** 文件后缀（小写） */
  ext: string;
}

/**
 * 给定相对路径，判断是否为合法 XYZ 瓦片；返回 null 表示不匹配。
 *
 * t18：带 URL scheme 的字符串（`file:///…`、`http://…`、`blob:…`）**不是**相对瓦片路径，
 * 一律返回 null —— 否则 `file:///home/x/tiles/0/0/0.jpg` 会被误判为瓦片 `0/0/0`。
 * Windows 盘符路径（`C:/tiles/0/0/0.png`）不视为 scheme，仍然匹配。
 */
export function parseXyzPath(relPath: string): XyzTileInfo | null {
  const normalized = normalizeRelativePath(relPath);
  if (hasUrlScheme(normalized)) return null;
  const m = XYZ_PATTERN.exec(normalized);
  if (!m) return null;
  return { level: Number(m[1]), x: Number(m[2]), y: Number(m[3]), ext: m[4].toLowerCase() };
}

/**
 * 从任意瓦片 URL / 路径解析 `{z}/{x}/{y}` 映射键。
 * 与 `parseXyzPath` 的差别：**允许**带 scheme 的绝对 URL（取 pathname 末三段），
 * 供 `importLocalCacheFromPath`（file:// / http 清单导入）复用同一套探测逻辑。
 */
export function xyzKeyFromUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  let path = trimmed;
  if (hasUrlScheme(trimmed)) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return undefined; // 非法 URL：不猜测
    }
  }
  path = path.split('?')[0] ?? path;
  path = path.split('#')[0] ?? path;
  const info = parseXyzPath(normalizeRelativePath(path));
  return info ? `${info.level}/${info.x}/${info.y}` : undefined;
}

/** 从映射键集合求层级范围（空集合返回 {min:0,max:0}） */
export function levelRangeOfKeys(keys: Iterable<string>): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const key of keys) {
    const level = Number(key.split('/')[0]);
    if (!Number.isFinite(level)) continue;
    if (level < min) min = level;
    if (level > max) max = level;
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

/**
 * XYZ 瓦片目录探测结果。
 */
export interface XyzDetection {
  /** 瓦片模板，如 `{z}/{x}/{y}.jpg` */
  template: string;
  /** 主导后缀（小写） */
  ext: string;
  /** 主导后缀的最小层级 */
  minLevel: number;
  /** 主导后缀的最大层级 */
  maxLevel: number;
  /** 主导后缀的瓦片数量 */
  tileCount: number;
}

/**
 * 探测 XYZ 瓦片目录：
 * - 至少要有 1 张瓦片
 * - 同一 ext 后缀占比 >= 80%（避免目录里同时混 png/jpg 时误识别）
 *
 * t18 修复（大目录卡死/崩溃）：
 * - 单次遍历内聚合 ext 计数与层级范围，不再构造十万级的 `matches` / `filtered` 中间数组；
 * - 层级范围用循环求 min/max，替代 `Math.min(...levels)` —— 后者在十万级瓦片时
 *   会因参数数量超限抛 `RangeError: Maximum call stack size exceeded`（实测 ≥20 万即复现）。
 */
export function detectXyzTiles(items: FlattenedFile[]): XyzDetection | undefined {
  const perExt = new Map<string, { count: number; min: number; max: number }>();
  let tileCount = 0;
  for (const it of items) {
    const info = parseXyzPath(it.relPath);
    if (!info) continue;
    tileCount++;
    const agg = perExt.get(info.ext);
    if (agg) {
      agg.count++;
      if (info.level < agg.min) agg.min = info.level;
      if (info.level > agg.max) agg.max = info.level;
    } else {
      perExt.set(info.ext, { count: 1, min: info.level, max: info.level });
    }
  }
  if (tileCount === 0) return undefined;
  let dominantExt = '';
  let dominant = { count: 0, min: 0, max: 0 };
  for (const [ext, agg] of perExt) {
    if (agg.count > dominant.count) {
      dominantExt = ext;
      dominant = agg;
    }
  }
  if (dominant.count / tileCount < 0.8) return undefined; // 后缀不一致，不视为瓦片目录
  return {
    template: `{z}/{x}/{y}.${dominantExt}`,
    ext: dominantExt,
    minLevel: dominant.min,
    maxLevel: dominant.max,
    tileCount: dominant.count,
  };
}

/** 探测 tileset.json 入口（基名 'tileset.json'） */
export function detectTileset(items: FlattenedFile[]): NameHit | undefined {
  const hits = findByBasename(items, ['tileset.json']);
  return hits[0];
}

/**
 * 探测主入口优先级：
 * 1. 包含 tileset.json → '3dtiles'
 * 2. 包含 XYZ 瓦片 → 'xyz'
 * 3. 否则 null
 */
export type CacheDetection = { kind: '3dtiles'; tileset: NameHit } | { kind: 'xyz'; xyz: XyzDetection } | null;

export function detectCacheKind(items: FlattenedFile[]): CacheDetection {
  const tileset = detectTileset(items);
  if (tileset) return { kind: '3dtiles', tileset };
  const xyz = detectXyzTiles(items);
  if (xyz) return { kind: 'xyz', xyz };
  return null;
}