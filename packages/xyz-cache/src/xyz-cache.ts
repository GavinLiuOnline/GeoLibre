/**
 * editor/core · localCache/xyzCache —— XYZ 瓦片缓存导入与预览
 *
 * 工作流：
 * 1. 接受 webkitdirectory 选中的 File[]，探测 {z}/{x}/{y}.<ext> 结构
 * 2. 构建 Map<"z/x/y", blob URL>（`buildXyzTileMap`）或 Map<"z/x/y", Blob>
 *    （`buildXyzTileBlobMap`，配合懒加载对象 URL，t18）
 * 3. 自定义 LocalXyzImageryProvider（结构满足 Cesium.ImageryProvider，鸭子类型），
 *    requestImage 查映射表（命中返回对应图片，缺失返回透明 1x1 PNG）
 * 4. 注册为 imagery 图层并附加 LocalCacheMetadata
 *
 * t18（修复 file:// 路径 / 超大目录导入卡死）：
 * - `buildXyzTileMapAsync` / `buildXyzTileBlobMap` 按批让出事件循环并上报单调进度，
 *   避免十万级瓦片把渲染进程主线程一次锁死；
 * - 提供者支持**懒加载对象 URL**（`tileBlobs`）：只在 Cesium 真正请求瓦片时才
 *   `URL.createObjectURL`，并带 LRU 上限，避免一次性注册百万级 blob URL；
 * - `requestImage` 永不返回 `undefined`、不重试、不等 file:// —— 缺瓦片 / 协议不可加载
 *   （默认含 `file:`） / 解码失败统一回退透明 PNG，避免 Cesium 因空图像进入错误循环。
 */
import {
  Credit,
  Event,
  GeographicTilingScheme,
  ImageryProvider,
  NeverTileDiscardPolicy,
  Rectangle,
  WebMercatorTilingScheme,
} from 'cesium';
import type { ImageryTypes, Request as CesiumRequest, TilingScheme } from 'cesium';

import {
  detectXyzTiles,
  flattenDirectoryFiles,
  isFileUrl,
  isLoadableTileUrl,
  normalizeRelativePath,
  parseXyzPath,
} from './detect';
import type { FlattenedFile } from './detect';
import { Proj4TilingScheme } from './proj4-tiling-scheme';
import { buildXyzTileUrl, hasXyzPlaceholders, xyzTemplateExt } from './tile-url';
import type {
  LocalCacheMetadata,
  XyzCacheImportOptions,
  XyzLayerCrs,
  XyzTilingMode,
} from './types';

// ---------------------------------------------------------------------------
// 1x1 透明 PNG（fallback：本地瓦片缺失时返回，让图层不显示错误）
// ---------------------------------------------------------------------------

/** 1x1 透明 PNG（base64） */
const TRANSPARENT_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

/**
 * 自定义 XYZ ImageryProvider：三种数据来源（并存，优先级 tiles > tileBlobs > urlTemplate）
 * - `tiles`：`<z>/<x>/<y>` → 可直接加载的 URL 映射（blob URL / http(s) / data）
 * - `tileBlobs`：`<z>/<x>/<y>` → Blob（请求到时才建对象 URL + LRU，t18）
 * - `urlTemplate`（t25）：**免枚举**模板模式，按 `{z}/{x}/{y}`（+ 可选 `{s}`/`{token}`）
 *   在 Cesium 真正请求时现算 URL 并按需加载 —— 导入期不枚举、不下载任何瓦片，
 *   因此 GB 级 / 百万文件级缓存（如 2,426,811 文件的本地 XYZ）也能立即出图。
 *
 * 未命中 / 越界 / 加载失败统一返回 1x1 透明 PNG（Cesium 视为无数据），**不报错、不重试**。
 *
 * 注意：Cesium 的 ImageryProvider 是「接口函数」（直接调用即
 * throwInstantiationError），无法 extends + super() 继承；这里按
 * Cesium 自定义 provider 的标准做法做鸭子类型实现（结构满足
 * ImageryProvider 接口，LayerManager.addImageryLayerInstance 按结构消费）。
 */
export class LocalXyzImageryProvider {
  /** 缓存：{z}/{x}/{y} → 可直接加载的 URL（blob URL / http(s) / data） */
  readonly tiles: Map<string, string>;
  /** 懒加载模式：{z}/{x}/{y} → Blob（请求到时才建对象 URL，t18） */
  readonly tileBlobs: Map<string, Blob> | undefined;
  /** 模板模式（t25）：瓦片 URL 模板；undefined 表示非模板模式 */
  readonly urlTemplate: string | undefined;
  /** 模板模式：{s} 子域列表 */
  readonly subdomains: readonly string[] | undefined;
  /** 模板模式：{token} 令牌 */
  readonly token: string | undefined;
  /**
   * TMS（t30）：true = 瓦片文件名 y 自南向北（TMS 约定）。
   * Cesium 请求的是自北向南的 XYZ y；查找映射 / 代入模板前按
   * y' = 行数 - 1 - y 翻转（requestImage 统一处理，tiles/tileBlobs/urlTemplate 三种
   * 来源一致）。行数取自 tilingScheme（t37 起兼容 proj4 自定义网格；内置方案行数
   * 恒为 2^z，与 t30 公式等价）。
   */
  readonly tms: boolean;
  /** 探测到的最小层级 */
  readonly minLevel: number;
  /** 探测到的最大层级（=maximumLevel，Cesium 据此限制请求） */
  readonly maxLevel: number;
  /** 覆盖 Cesium 默认 4326 矩形（WebMercator/Geographic 不同） */
  readonly rectangle: Rectangle;
  readonly tileWidth = 256;
  readonly tileHeight = 256;
  readonly maximumLevel: number | undefined;
  readonly minimumLevel: number;
  readonly tilingScheme: TilingScheme;
  /** proj4 任意投影 CRS（t37；undefined = 内置 web-mercator/geographic 切片方案） */
  readonly crs: XyzLayerCrs | undefined;
  readonly tileDiscardPolicy = new NeverTileDiscardPolicy();
  readonly errorEvent: Event = new Event();
  readonly credit: Credit;
  readonly proxy: ImageryProvider['proxy'] = undefined as unknown as ImageryProvider['proxy'];
  readonly hasAlphaChannel: boolean;

  /**
   * 是否允许 file:// 瓦片（Electron webSecurity:false 场景；默认 false）。
   * public：重建图层（rebuildXyzLayer，t30）需要原样继承该开关。
   */
  readonly allowFileUrls: boolean;
  /** 懒加载对象 URL 的 LRU 上限 */
  private readonly maxLazyObjectUrls: number;
  /** 懒加载创建的对象 URL（key → objectURL，插入序即 LRU 序） */
  private readonly lazyObjectUrls = new Map<string, string>();
  /** 图像加载器（模板/映射统一走它；默认 URL 解码，测试可注入计数实现）。
   * public：重建图层（rebuildXyzLayer，t30）需要原样继承注入的实现。 */
  readonly loadImage: XyzTileImageLoader | undefined;

  constructor(options: LocalXyzProviderOptions) {
    const tiles = options.tiles ?? new Map<string, string>();
    const tileBlobs = options.tileBlobs;
    const urlTemplate = options.urlTemplate?.trim() || undefined;
    if (tiles.size === 0 && (!tileBlobs || tileBlobs.size === 0) && !urlTemplate) {
      throw new Error(
        'XYZ 瓦片提供者缺少瓦片数据（tiles / tileBlobs / urlTemplate 均为空）',
      );
    }
    if (urlTemplate && !hasXyzPlaceholders(urlTemplate)) {
      throw new Error(
        `XYZ 瓦片模板必须包含 {z}/{x}/{y} 占位符（实际「${urlTemplate}」）`,
      );
    }
    this.allowFileUrls = options.allowFileUrls === true;
    this.maxLazyObjectUrls = Math.max(1, Math.floor(options.maxLazyObjectUrls ?? 512));
    // 协议校验：file:// 等无法被渲染进程直接加载的协议 → 显式可读错误（而非静默黑屏/卡死）
    if (options.validateTileUrls !== false && tiles.size > 0) {
      for (const [key, url] of tiles) {
        if (!isLoadableTileUrl(url) && !(this.allowFileUrls && isFileUrl(url))) {
          throw new Error(
            `XYZ 瓦片 URL 协议不受支持（瓦片 ${key}）：${url}。` +
              'file:// 等本地协议无法被渲染进程直接加载；请用「导入 → 本地 XYZ 缓存目录」选择目录，' +
              '或先经 importLocalCacheFromPath 把瓦片转成 Blob 再导入' +
              '（确需直连 file:// 时可传 allowFileUrls: true）。',
          );
        }
      }
    }
    // 模板模式同样做协议校验：file:// 模板只有在 allowFileUrls（Electron）时才允许
    if (
      urlTemplate &&
      options.validateTileUrls !== false &&
      !isLoadableTileUrl(urlTemplate) &&
      !(this.allowFileUrls && isFileUrl(urlTemplate))
    ) {
      throw new Error(
        `XYZ 模板协议不受支持：${urlTemplate}。浏览器无法从页面加载 file:// 瓦片；` +
          '请改用 http(s) 静态服务（例如在缓存目录执行 `python3 -m http.server 8090`），' +
          '或使用 Electron 桌面端（allowFileUrls: true）。',
      );
    }
    this.tiles = tiles;
    this.tileBlobs = tileBlobs;
    this.urlTemplate = urlTemplate;
    this.subdomains = options.subdomains ? [...options.subdomains] : undefined;
    this.token = options.token;
    this.tms = options.tms === true;
    this.loadImage = options.loadImage;
    this.minLevel = options.minLevel;
    this.maxLevel = options.maxLevel;
    this.maximumLevel = options.maxLevel;
    this.minimumLevel = options.minLevel;
    this.hasAlphaChannel = options.hasAlphaChannel ?? true;
    // CRS 优先级（t37）：metadata.crs（proj4 任意投影）> tilingMode（内置 3857/4326）。
    // crs 存在时切片方案 = Proj4TilingScheme（2^z 方格均分 validBounds、origin 默认左上），
    // tilingMode 不再生效（保持 metadata 字段兼容：重建时写 crs 会移除 tilingMode）。
    const crs = options.crs;
    this.crs = crs;
    if (crs) {
      this.tilingScheme = new Proj4TilingScheme(crs) as unknown as TilingScheme;
      // 方案矩形 = validBounds；options.bounds 作为**请求子范围**与 validBounds 求交
      // （bounds 应位于 validBounds 内；无交时回退 validBounds，避免 rectangle 变 undefined）
      const validRect = Rectangle.fromDegrees(
        crs.validBounds[0],
        crs.validBounds[1],
        crs.validBounds[2],
        crs.validBounds[3],
      );
      this.rectangle = options.bounds
        ? (Rectangle.intersection(
            Rectangle.fromDegrees(options.bounds[0], options.bounds[1], options.bounds[2], options.bounds[3]),
            validRect,
          ) ?? validRect)
        : validRect;
    } else {
      const mode: XyzTilingMode = options.tilingMode ?? 'web-mercator';
      this.tilingScheme =
        mode === 'geographic' ? new GeographicTilingScheme() : new WebMercatorTilingScheme();
      // 可选范围限制（t25）：只对指定经纬度矩形发请求，避免模板模式对全世界拉瓦片
      this.rectangle = options.bounds
        ? Rectangle.fromDegrees(
            options.bounds[0],
            options.bounds[1],
            options.bounds[2],
            options.bounds[3],
          )
        : this.tilingScheme.rectangle;
    }
    this.credit = options.credit ? new Credit(options.credit) : new Credit('');
  }

  /**
   * 由 Cesium 调用：命中映射 / 模板命中返回对应图片；
   * 未命中 / 越界 / 协议不可加载 / 解码失败统一返回透明 PNG。
   *
   * 保证：**永不返回 undefined、永不重试、永不等待 file://** —— 避免 Cesium 因空图像
   * 进入错误重试循环（导入卡死的观测形态之一）。模板模式下 URL 在这里（首次请求时）
   * 才计算并按需加载，导入期零网络请求。
   */
  requestImage(x: number, y: number, level: number, _request?: CesiumRequest): Promise<ImageryTypes> | undefined {
    // TMS（t30）：Cesium 的 y 自北向南，TMS 文件名 y 自南向北 → 查找前翻转。
    // 翻转只发生在「文件查找 / URL 代入」这一层：越界校验（isTileInRange）对翻转后的
    // 坐标同样成立，rectangle / tilingScheme 与瓦片几何无关、不受影响。
    // 行数取自 tilingScheme（t37）：内置方案恒为 2^level（与 t30 公式等价），
    // proj4 自定义网格按其实际行数翻转。
    const rows = this.tilingScheme.getNumberOfYTilesAtLevel(level);
    const fileY = this.tms ? rows - 1 - y : y;
    const url = this.resolveTileUrl(`${level}/${x}/${fileY}`, { x, y: fileY, level });
    const loader = this.loadImage ?? (fetchImage as XyzTileImageLoader);
    const target = url ?? TRANSPARENT_PNG_DATA_URL;
    return loader(target).catch(() => loader(TRANSPARENT_PNG_DATA_URL)) as Promise<ImageryTypes>;
  }

  /**
   * 计算某瓦片的最终 URL（模板模式）或读取映射（tiles / tileBlobs）；
   * 不可用（映射缺失、层级/坐标越界、file:// 被禁）返回 undefined → 透明 PNG。
   *
   * 模板模式的越界判定（**返回空而不是报错**）：
   * - level 不在 [minLevel, maxLevel] 内；
   * - x / y 不是整数或不在 `[0, 2^level - 1]`（Cesium 正常不会请求，防御性校验）。
   */
  resolveTileUrl(
    key: string,
    tile?: { x: number; y: number; level: number },
  ): string | undefined {
    const direct = this.tiles.get(key);
    if (direct !== undefined) {
      if (isFileUrl(direct) && !this.allowFileUrls) return undefined;
      return direct;
    }
    const blob = this.tileBlobs?.get(key);
    if (blob) return this.lazyObjectUrlFor(key, blob);
    if (!this.urlTemplate || !tile) return undefined;
    if (!this.isTileInRange(tile.x, tile.y, tile.level)) return undefined;
    return buildXyzTileUrl(
      this.urlTemplate,
      { zoom: tile.level, x: tile.x, y: tile.y },
      this.subdomains,
      this.token,
    );
  }

  /** 模板模式的范围校验（层级 + 瓦片坐标；行列上限取自 tilingScheme，兼容 proj4 网格） */
  isTileInRange(x: number, y: number, level: number): boolean {
    if (!Number.isInteger(level) || level < this.minLevel || level > this.maxLevel) return false;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
    const cols = this.tilingScheme.getNumberOfXTilesAtLevel(level);
    const rows = this.tilingScheme.getNumberOfYTilesAtLevel(level);
    return x >= 0 && y >= 0 && x < cols && y < rows;
  }

  /** 懒加载对象 URL（LRU）：只有真正被请求的瓦片才创建 */
  private lazyObjectUrlFor(key: string, blob: Blob): string {
    const cached = this.lazyObjectUrls.get(key);
    if (cached !== undefined) return cached;
    const url = URL.createObjectURL(blob);
    this.lazyObjectUrls.set(key, url);
    if (this.lazyObjectUrls.size > this.maxLazyObjectUrls) {
      const oldest = this.lazyObjectUrls.keys().next();
      if (!oldest.done) {
        const staleUrl = this.lazyObjectUrls.get(oldest.value);
        if (staleUrl) URL.revokeObjectURL(staleUrl);
        this.lazyObjectUrls.delete(oldest.value);
      }
    }
    return url;
  }

  getTileCredits(): Credit[] {
    return [];
  }

  /** 已建立的懒加载对象 URL 数量（诊断/测试用） */
  get lazyObjectUrlCount(): number {
    return this.lazyObjectUrls.size;
  }

  /** 释放懒加载创建的全部对象 URL（图层移除后调用，避免泄漏；可重复调用） */
  dispose(): void {
    for (const url of this.lazyObjectUrls.values()) URL.revokeObjectURL(url);
    this.lazyObjectUrls.clear();
  }
}

/**
 * 瓦片图像加载器（模板模式 / 映射模式统一出口）。
 * 默认实现为 URL 解码（失败回退透明 PNG）；测试可注入计数实现以断言「按需请求」。
 */
export type XyzTileImageLoader = (url: string) => Promise<ImageryTypes>;

export interface LocalXyzProviderOptions {
  /** 预建好的瓦片 URL 映射（blob URL / http(s) / data；相对路径由调用方解析） */
  tiles?: Map<string, string>;
  /** 懒加载模式：瓦片 Blob 映射（与 tiles 二选一或并用，tiles 优先） */
  tileBlobs?: Map<string, Blob>;
  /**
   * 模板模式（t25）：`{z}/{x}/{y}` 瓦片 URL 模板（可选 `{s}` 子域 / `{token}` 令牌）。
   * 与 tiles / tileBlobs 并存，优先级最低（显式数据优先）；**导入期不发任何请求**，
   * URL 在 Cesium 首次请求该瓦片时才计算并加载，因此适合百万文件级 / GB 级缓存。
   */
  urlTemplate?: string;
  /** 模板模式：`{s}` 子域列表（缺省 a/b/c） */
  subdomains?: readonly string[];
  /** 模板模式：`{token}` 令牌（代入时做 URL 编码） */
  token?: string;
  /**
   * TMS（t30）：瓦片文件名 y 自南向北（Y 轴翻转），默认 false（标准 XYZ）。
   * 只影响文件查找 / URL 代入的 y 值；瓦片几何（grid/rectangle）不受影响。
   */
  tms?: boolean;
  /**
   * 可选请求范围 [minLon, minLat, maxLon, maxLat]：只对指定矩形发瓦片请求
   * （模板模式常配合使用，避免对全世界拉不存在的瓦片）。
   */
  bounds?: readonly [number, number, number, number];
  minLevel: number;
  maxLevel: number;
  hasAlphaChannel?: boolean;
  tilingMode?: XyzTilingMode;
  /**
   * proj4 任意投影 CRS（t37）：给定时切片方案用 Proj4TilingScheme（2^z 方格均分
   * validBounds、origin 默认左上），tilingMode 不再生效；bounds 退化为 validBounds
   * 内的请求子范围。metadata.crs 即本结构（自包含，随场景往返）。
   */
  crs?: XyzLayerCrs;
  credit?: string;
  /** 是否校验 tiles 值协议（默认 true）；file:// 等不可加载协议直接抛可读错误 */
  validateTileUrls?: boolean;
  /** 是否允许 file:// 瓦片 URL（默认 false；Electron webSecurity:false 场景可开） */
  allowFileUrls?: boolean;
  /** 懒加载对象 URL LRU 上限（默认 512） */
  maxLazyObjectUrls?: number;
  /** 图像加载器（默认 URL 解码；测试注入以断言按需请求次数） */
  loadImage?: XyzTileImageLoader;
}

/**
 * 从 FlattenedFile[] 构建 {z/x/y → blob URL} 映射（不直接注册图层，给 UI 提供入口）。
 *
 * 注意：这是**同步、急切**版本，会为每张瓦片立刻 `createObjectURL`；
 * 十万级以上瓦片请改用 `buildXyzTileMapAsync`（切片 + 进度）或
 * `buildXyzTileBlobMap`（懒加载对象 URL，不预建 blob URL）。
 */
export function buildXyzTileMap(items: FlattenedFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const info = parseXyzPath(item.relPath);
    if (!info) continue;
    const key = `${info.level}/${info.x}/${info.y}`;
    // 同 key 已有：保留首次（重复文件大概率内容相同）
    if (map.has(key)) continue;
    map.set(key, URL.createObjectURL(item.file));
  }
  return map;
}

// ---------------------------------------------------------------------------
// 切片（异步）+ 进度：大目录导入不让出事件循环会锁死渲染进程主线程（t18）
// ---------------------------------------------------------------------------

export interface BuildXyzTileMapOptions {
  /** 每处理多少条让出一次事件循环（默认 2000） */
  batchSize?: number;
  /** 进度回调（单调不减，单位：已处理文件数） */
  onProgress?: (processed: number, total: number) => void;
  /** 取消检查：返回 true 时抛「本地缓存导入已取消」 */
  shouldCancel?: () => boolean;
  /** 取消信号 */
  signal?: AbortSignal;
}

const DEFAULT_BATCH_SIZE = 2000;

/**
 * 异步切片构建 {z/x/y → blob URL} 映射（语义同 `buildXyzTileMap`）。
 * 每 `batchSize` 条让出一次事件循环并上报进度，保证 UI 可刷新、可取消。
 */
export async function buildXyzTileMapAsync(
  items: FlattenedFile[],
  options: BuildXyzTileMapOptions = {},
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await forEachSlice(items, options, (item) => {
    const info = parseXyzPath(item.relPath);
    if (!info) return;
    const key = `${info.level}/${info.x}/${info.y}`;
    if (map.has(key)) return;
    map.set(key, URL.createObjectURL(item.file));
  });
  return map;
}

/**
 * 异步切片构建 {z/x/y → Blob} 映射（**不**预建对象 URL，t18 默认路径）。
 * 内存只保留瓦片 Blob 句柄，对象 URL 由提供者在真正请求时按需创建（LRU 上限）。
 */
export async function buildXyzTileBlobMap(
  items: FlattenedFile[],
  options: BuildXyzTileMapOptions = {},
): Promise<Map<string, Blob>> {
  const map = new Map<string, Blob>();
  await forEachSlice(items, options, (item) => {
    const info = parseXyzPath(item.relPath);
    if (!info) return;
    const key = `${info.level}/${info.x}/${info.y}`;
    if (map.has(key)) return;
    map.set(key, item.file);
  });
  return map;
}

/** 逐条处理并在批次边界让出事件循环（内部共用） */
async function forEachSlice(
  items: FlattenedFile[],
  options: BuildXyzTileMapOptions,
  visit: (item: FlattenedFile) => void,
): Promise<void> {
  const total = items.length;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  let processed = 0;
  options.onProgress?.(0, total);
  for (const item of items) {
    if (options.signal?.aborted || options.shouldCancel?.()) {
      throw new Error('本地缓存导入已取消');
    }
    visit(item);
    processed++;
    if (processed % batchSize === 0) {
      options.onProgress?.(processed, total);
      await yieldToEventLoop();
    }
  }
  options.onProgress?.(total, total);
}

/** 让出事件循环（宏任务，确保浏览器有机会渲染/响应取消） */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 探测 ZIP 缓存目录（detect.detectXyzTiles 的便捷入口） */
export { detectXyzTiles, flattenDirectoryFiles };

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 解码 URL 为 Cesium 期望的 HTMLImageElement。
 *
 * t18：**永不返回 undefined** —— 解码失败（协议不可加载、文件损坏、file:// 被拒绝）
 * 时回退 1x1 透明 PNG，避免 Cesium 拿到空图像后反复重试（观测为「导入卡死」）。
 */
async function fetchImage(url: string): Promise<HTMLImageElement> {
  const decoded = await tryDecodeImage(url);
  if (decoded) return decoded;
  const fallback = await tryDecodeImage(TRANSPARENT_PNG_DATA_URL);
  // 透明 PNG 是内联 data URL，解码失败只可能发生在本环境没有 Image/解码器（如 node 单测）；
  // 此时返回惰性占位（仍不返回 undefined、也绝不抛，避免 Cesium 侧变成 reject/重试风暴）。
  return fallback ?? createStandaloneImage();
}

/** 无 Image 构造器的环境返回惰性占位（绝不抛） */
function createStandaloneImage(): HTMLImageElement {
  try {
    return new Image();
  } catch {
    return undefined as unknown as HTMLImageElement;
  }
}

/** 尝试解码单个 URL；失败返回 undefined */
async function tryDecodeImage(url: string): Promise<HTMLImageElement | undefined> {
  try {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = url;
    const ok = await image.decode().then(
      () => true,
      () => false,
    );
    return ok ? image : undefined;
  } catch {
    return undefined;
  }
}

void ImageryProvider;

/** 为发布打包/UI 提供：把 XYZ 导入结果（不含 Cesium 引用）的轻量元数据抽出 */
export function extractXyzMetadata(
  items: FlattenedFile[],
  rootDir: string,
  _options: XyzCacheImportOptions,
): LocalCacheMetadata {
  const xyz = detectXyzTiles(items);
  let totalBytes = 0;
  for (const it of items) totalBytes += it.size;
  return {
    cacheKind: 'xyz',
    files: items.map((it) => ({ path: normalizeRelativePath(it.relPath), size: it.size })),
    totalBytes,
    rootDir,
    detection: {
      xyzTemplate: xyz?.template,
      xyzExt: xyz?.ext,
      maxLevel: xyz?.maxLevel,
      tileCount: xyz?.tileCount,
    },
  };
}