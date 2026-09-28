/**
 * editor/core · localCache/localCache —— 本地缓存图层统一导入入口
 *
 * importLocalCache(files, layers, options)：webkitdirectory 选中的 File[] →
 * - 探测缓存类型（3D Tiles / XYZ）
 * - 准备预览（重写 tileset.json / 构建 z/x/y → blob 或 blob URL 映射）
 * - 注册到 LayerManager（图层元数据 = LocalCacheMetadata，供后续打包消费）
 *
 * importLocalCacheFromPath(pathOrUrl, layers, options)（t18）：file:// 路径 / http(s) 地址 →
 * 读目录内清单（index.json / tiles.json / manifest.json，或调用方显式给定 tiles）→
 * 按并发拉取瓦片为 Blob → 复用同一套提供者/图层链路。浏览器无法枚举本地目录，
 * 因此目录内无清单时给出可读错误并指向「本地 XYZ 缓存目录」选择入口。
 *
 * t18 卡死修复（用户报告 file:///home/nuanyang/tiles 导入卡死；实测该目录 242 万文件 / 15GB）：
 * - `maxFiles`（默认 200000）在**任何重活之前**按 files.length 做 O(1) 校验，超限抛可读错误；
 * - XYZ 映射构建改为异步切片 + 单调进度（`onProgress`），不再长时间独占主线程；
 * - 默认「懒加载对象 URL」（`lazyTileUrls`），不再为每张瓦片预建 blob URL。
 */
import type { LayerManager } from './layer-manager';
import { readBrowserEnv } from './browser-env';
import type {
  LocalCacheImportOptions,
  LocalCacheMetadata,
  LocalCacheProgress,
  XyzLayerCrs,
  XyzTilingMode,
  XyzUrlImportOptions,
} from './types';

import {
  detectCacheKind,
  flattenDirectoryFiles,
  hasUrlScheme,
  levelRangeOfKeys,
  urlProtocolOf,
  xyzKeyFromUrl,
} from './detect';
import {
  buildXyzTileBlobMap,
  buildXyzTileMapAsync,
  extractXyzMetadata,
  LocalXyzImageryProvider,
} from './xyz-cache';
import type { XyzTileImageLoader } from './xyz-cache';
import { boundsFromTileKeys } from './bounds';
import { deriveXyzTemplate, validateXyzTemplate, xyzTemplateExt } from './tile-url';
import {
  extractTilesetMetadata,
  prepareLocalTileset,
} from './tileset-cache';

/** 单次导入允许的最大文件数量（默认）：百万级目录必然卡死/OOM，超限直接给可读错误 */
export const DEFAULT_MAX_LOCAL_CACHE_FILES = 200_000;

/**
 * Firefox 下 `file://` 的额外提示（t23）。
 *
 * Firefox 对 `file://` 有更严的同源/隐私策略（即使页面本身是 file://，
 * FF68+ 也按「唯一源」处理），因此目录内清单存在也读不到；Chromium 同样会拒绝，
 * 但错误文案与规避方式不同，这里只对 Firefox 追加**可操作**的指引。
 * Electron 桌面端（webSecurity:false）不受此限，故不追加。
 */
function firefoxFileUrlHint(): string {
  const env = readBrowserEnv();
  if (!env.isFirefox) return '';
  return (
    ' Firefox 安全策略下 file:// 基本不可用（清单存在也会被拒绝）：' +
    '请改用 ① http(s) 地址（例如在缓存目录上起一个静态服务）、' +
    '② Electron 桌面端，或 ③ 小体量目录用「添加数据 → 本地 XYZ 缓存目录」选择导入。'
  );
}

/**
 * Firefox 下 `webkitRelativePath` 缺失时的额外提示（t23）。
 *
 * Firefox 虽已支持 `webkitdirectory`，但目录选择结果在部分版本/场景下
 * 不提供相对路径（或提供反斜杠分隔符），导致所有文件被判定为「无相对路径」
 * 而全部跳过 —— 这时给出可操作的下一步，而不是让用户对着空目录反复重试。
 */
function firefoxRelativePathHint(): string {
  const env = readBrowserEnv();
  if (!env.isFirefox) return '';
  return (
    ' Firefox 的目录选择在部分版本不提供 webkitRelativePath（或使用反斜杠分隔符），' +
    '请确认选择的是**目录本身**而非目录内的文件，或改用 Chrome/Edge、Electron 桌面端，' +
    '以及「本地 XYZ 缓存目录（URL/file://）…」按清单导入。'
  );
}

/** 按 URL/路径导入时的瓦片数量上限（默认） */
export const DEFAULT_MAX_URL_TILES = 50_000;

/** 按 URL/路径导入时的默认并发 */
const DEFAULT_FETCH_CONCURRENCY = 8;

/** 清单探测用的候选文件名 */
const MANIFEST_CANDIDATES = ['index.json', 'tiles.json', 'manifest.json'];

export interface ImportLocalCacheResult {
  kind: '3dtiles' | 'xyz';
  layerId: string;
  /** 图层元数据（含文件清单 + 探测结果），供发布打包 zip 复用 */
  metadata: LocalCacheMetadata;
  /** 缓存根目录名 */
  rootDir: string;
  /** 探测到的瓦片/入口统计（UI 显示用） */
  info: {
    fileCount: number;
    totalBytes: number;
    tilesetPath?: string;
    xyzTemplate?: string;
    xyzExt?: string;
    maxLevel?: number;
    tileCount?: number;
  };
}

/**
 * 一站式导入本地缓存目录为编辑器图层（自带预览渲染）。
 *
 * 适用 webkitdirectory 模式：files[].webkitRelativePath 必有。
 * 大目录保护：`options.maxFiles`（默认 200000）超限时**在探测/建映射之前**抛可读错误，
 * 传 `Number.POSITIVE_INFINITY` 可显式关闭（导入仍按异步切片执行，UI 不冻结）。
 */
export async function importLocalCache(
  files: File[],
  layers: LayerManager,
  options: LocalCacheImportOptions = {},
): Promise<ImportLocalCacheResult> {
  const total = files.length;
  assertFileCountWithinLimit(total, options.maxFiles);

  const report = createProgressReporter(options.onProgress);
  report('detect', 0, total);

  const items = flattenDirectoryFiles(files);
  if (items.length === 0) {
    throw new Error(
      '目录中没有可识别的文件（webkitdirectory 模式应保证文件带 webkitRelativePath）' +
        firefoxRelativePathHint(),
    );
  }
  report('detect', items.length, total);

  const rootDir = items[0]?.rootDir ?? '';
  const detection = detectCacheKind(items);
  const wantedKind = options.cacheKind;

  if (!detection && !wantedKind) {
    throw new Error(
      '无法识别缓存目录结构：未找到 tileset.json 也未发现 {z}/{x}/{y}.<ext> 瓦片；' +
        '请确认选择了完整目录（含 tileset.json 或瓦片子目录）',
    );
  }

  const kind: '3dtiles' | 'xyz' =
    wantedKind ?? detection?.kind ?? '3dtiles';

  if (kind === '3dtiles') {
    return importLocalTileset(items, rootDir, layers, options, report);
  }
  return importLocalXyz(items, rootDir, layers, options, report);
}

// ---------------------------------------------------------------------------
// 3D Tiles
// ---------------------------------------------------------------------------

async function importLocalTileset(
  items: ReturnType<typeof flattenDirectoryFiles>,
  rootDir: string,
  layers: LayerManager,
  options: LocalCacheImportOptions,
  report: ProgressReporter,
): Promise<ImportLocalCacheResult> {
  const { tileset, tilesetPath } = await prepareLocalTileset(items, {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.tileset ?? {}),
  });

  const metadata = extractTilesetMetadata(items, rootDir, tilesetPath);
  report('register', metadata.files.length, items.length);
  const layer = await layers.add3DTilesInstance(
    options.name ?? rootDir,
    tileset,
    {
      url: tilesetPath,
      filename: tilesetPath,
      metadata: metadata as unknown as Record<string, unknown>,
    },
    {
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.show !== undefined ? { show: options.show } : {}),
      ...(options.opacity !== undefined ? { opacity: options.opacity } : {}),
      ...(options.tileset?.maximumScreenSpaceError !== undefined
        ? { maximumScreenSpaceError: options.tileset.maximumScreenSpaceError }
        : {}),
    },
  );

  return {
    kind: '3dtiles',
    layerId: layer.id,
    metadata,
    rootDir,
    info: {
      fileCount: metadata.files.length,
      totalBytes: metadata.totalBytes,
      ...(metadata.detection?.tilesetPath ? { tilesetPath: metadata.detection.tilesetPath } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// XYZ
// ---------------------------------------------------------------------------

async function importLocalXyz(
  items: ReturnType<typeof flattenDirectoryFiles>,
  rootDir: string,
  layers: LayerManager,
  options: LocalCacheImportOptions,
  report: ProgressReporter,
): Promise<ImportLocalCacheResult> {
  const xyzOptions = options.xyz ?? {};
  const lazy = options.lazyTileUrls !== false;
  const builderOptions = {
    onProgress: (processed: number, total: number) =>
      report(lazy ? 'scan' : 'build', processed, total),
  };

  // 懒加载模式：只登记 Blob 句柄，对象 URL 由提供者在瓦片真正被请求时按需创建（LRU 上限）。
  // 急切模式：异步切片构建 blob URL 映射（兼容旧行为，UI 仍不会被独占）。
  const tileBlobs = lazy ? await buildXyzTileBlobMap(items, builderOptions) : undefined;
  const tileMap = lazy ? undefined : await buildXyzTileMapAsync(items, builderOptions);

  const size = tileBlobs?.size ?? tileMap?.size ?? 0;
  if (size === 0) {
    throw new Error('XYZ 缓存目录未发现任何 {z}/{x}/{y}.<ext> 瓦片');
  }

  const { min: minLevel, max: maxLevel } = levelRangeOfKeys((tileBlobs ?? tileMap)!.keys());

  // t30：由瓦片键集合推算地理范围（用户显式给定的 bounds 优先），写入 metadata 并传给
  // provider.rectangle —— 注册后即可 zoomTo 定位到数据处（修复「视野停在 0,0」）。
  // t37：crs 给定时瓦片键按该 CRS 网格换算（tilingMode 不参与），并写 metadata.crs
  //（与 tilingMode 互斥——与 rebuildXyz 的写入约定一致）。
  const crs = xyzOptions.crs;
  const tilingMode = xyzOptions.tilingMode ?? 'web-mercator';
  const tms = xyzOptions.tms === true;
  const resolvedBounds = xyzOptions.bounds
    ?? boundsFromTileKeys((tileBlobs ?? tileMap)!.keys(), { tilingMode, tms, ...(crs ? { crs } : {}) });

  const provider = new LocalXyzImageryProvider({
    ...(tileMap ? { tiles: tileMap } : {}),
    ...(tileBlobs ? { tileBlobs } : {}),
    minLevel: xyzOptions.levelRange?.[0] ?? minLevel,
    maxLevel: xyzOptions.levelRange?.[1] ?? maxLevel,
    hasAlphaChannel: xyzOptions.hasAlphaChannel ?? true,
    tilingMode,
    tms,
    ...(resolvedBounds ? { bounds: resolvedBounds } : {}),
    ...(crs ? { crs } : {}),
  });

  const metadata = extractXyzMetadata(items, rootDir, xyzOptions);
  metadata.tms = tms;
  if (crs) {
    metadata.crs = crs;
    delete metadata.tilingMode;
  } else {
    metadata.tilingMode = tilingMode;
  }
  if (resolvedBounds) metadata.bounds = [...resolvedBounds] as [number, number, number, number];
  report('register', metadata.files.length, items.length);
  const layer = layers.addImageryLayerInstance(
    options.name ?? rootDir,
    provider,
    {
      url: metadata.detection?.xyzTemplate ?? '{z}/{x}/{y}.png',
      filename: rootDir,
      metadata: metadata as unknown as Record<string, unknown>,
    },
    {
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.show !== undefined ? { show: options.show } : {}),
      ...(options.opacity !== undefined ? { opacity: options.opacity } : {}),
      maximumLevel: metadata.detection?.maxLevel ?? maxLevel,
    },
  );

  return {
    kind: 'xyz',
    layerId: layer.id,
    metadata,
    rootDir,
    info: {
      fileCount: metadata.files.length,
      totalBytes: metadata.totalBytes,
      xyzTemplate: metadata.detection?.xyzTemplate,
      xyzExt: metadata.detection?.xyzExt,
      maxLevel: metadata.detection?.maxLevel,
      tileCount: metadata.detection?.tileCount,
    },
  };
}

// ---------------------------------------------------------------------------
// file:// 路径 / URL 回退路径（t18）
// ---------------------------------------------------------------------------

/**
 * 按本地路径（`file:///home/x/tiles`、`/home/x/tiles`、`C:\x\tiles`）
 * 或 http(s) 地址导入 XYZ 缓存。
 *
 * 与 `importLocalCache`（webkitdirectory）的差别：这里没有 File[]，
 * 只能依赖**目录内的瓦片清单**：
 * 1. `options.tiles`（显式清单）优先；
 * 2. 否则读 `options.manifestUrl`；
 * 3. 否则依次探测 `<base>/index.json`、`<base>/tiles.json`、`<base>/manifest.json`（最多 3 次请求，不重试）；
 * 4. 都没有 → 抛可读错误，指引改用「导入 → 本地 XYZ 缓存目录」选择目录。
 *
 * 清单格式：`string[]` 或 `{ "tiles": string[] }`（元素为相对 base 或绝对 URL 的瓦片路径）。
 *
 * 全程有界：并发上限（默认 8）、瓦片数上限（默认 50000，超限直接报错）、单瓦片失败跳过不重试，
 * 因此不存在「卡死」路径。
 */
export async function importLocalCacheFromPath(
  input: string,
  layers: LayerManager,
  options: XyzUrlImportOptions = {},
): Promise<ImportLocalCacheResult> {
  const path = String(input ?? '').trim();
  if (!path) {
    throw new Error('未提供缓存路径：请传入 file:// URL 或本地目录路径');
  }
  const base = resolveCacheBaseUrl(path);
  const fetchImpl = options.fetchImpl ?? globalThisFetch();
  const report = createProgressReporter(options.onProgress);

  const maxTiles = options.maxTiles ?? DEFAULT_MAX_URL_TILES;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_FETCH_CONCURRENCY));

  // 1) 瓦片清单
  let refs = options.tiles;
  if (!refs || refs.length === 0) {
    const manifestUrl = options.manifestUrl ?? (await findManifestUrl(base, fetchImpl));
    if (!manifestUrl) {
      throw new Error(
        `无法枚举目录内容：${base}。浏览器不允许列出本地目录，请改用以下任一方式：` +
          '① 用「导入 → 本地 XYZ 缓存目录」选择该目录（webkitdirectory，直接读取文件）；' +
          `② 在目录内提供 ${MANIFEST_CANDIDATES.join(' / ')} 清单（形如 {"tiles": ["0/0/0.jpg"]}）后重试；` +
          '③ 改为 http(s) 服务地址。' +
          firefoxFileUrlHint(),
      );
    }
    refs = await readManifestTiles(manifestUrl, fetchImpl, maxTiles);
  } else if (refs.length > maxTiles) {
    throw new Error(
      `瓦片清单过大：${refs.length} 条（上限 ${maxTiles}）。请拆分缓存或提高 options.maxTiles。`,
    );
  }

  report('scan', 0, refs.length);
  const urls = refs.map((ref) => resolveTileUrl(base, ref));

  // 2) 并卡拉取（有界、失败跳过、进度单调）
  const blobs = await fetchTilesAsBlobs(urls, {
    fetchImpl,
    concurrency,
    report,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (blobs.size === 0) {
    throw new Error(
      `未能加载任何瓦片：${base}。请确认清单中的路径正确、瓦片可访问` +
        '（file:// 直连在浏览器中会被拒绝，桌面端/本地服务不受此限）。' +
        firefoxFileUrlHint(),
    );
  }

  // 3) 注册图层（与目录导入同一套提供者，懒加载对象 URL）
  const { min: minLevel, max: maxLevel } = levelRangeOfKeys(blobs.keys());
  const ext = detectTileExt(urls);
  // t30：范围推算 + 切片模式/TMS 与目录导入同一套口径；t37：crs 同样透传
  const crs = options.xyz?.crs;
  const tilingMode = options.xyz?.tilingMode ?? 'web-mercator';
  const tms = options.xyz?.tms === true;
  const resolvedBounds = options.xyz?.bounds
    ?? boundsFromTileKeys(blobs.keys(), { tilingMode, tms, ...(crs ? { crs } : {}) });
  const provider = new LocalXyzImageryProvider({
    tileBlobs: blobs,
    minLevel: options.xyz?.levelRange?.[0] ?? minLevel,
    maxLevel: options.xyz?.levelRange?.[1] ?? maxLevel,
    hasAlphaChannel: options.xyz?.hasAlphaChannel ?? true,
    tilingMode,
    tms,
    ...(resolvedBounds ? { bounds: resolvedBounds } : {}),
    ...(crs ? { crs } : {}),
  });

  let totalBytes = 0;
  for (const blob of blobs.values()) totalBytes += blob.size;
  const rootDir = rootDirOf(base);
  const metadata: LocalCacheMetadata = {
    cacheKind: 'xyz',
    files: [...blobs.entries()].map(([key, blob]) => ({ path: `${key}.${ext}`, size: blob.size })),
    totalBytes,
    rootDir,
    ...(crs ? { crs } : { tilingMode }),
    tms,
    ...(resolvedBounds ? { bounds: [...resolvedBounds] as [number, number, number, number] } : {}),
    detection: {
      xyzTemplate: `{z}/{x}/{y}.${ext}`,
      xyzExt: ext,
      maxLevel,
      tileCount: blobs.size,
    },
  };

  report('register', blobs.size, blobs.size);
  const layer = layers.addImageryLayerInstance(
    options.name ?? rootDir,
    provider,
    {
      url: `${base}/{z}/{x}/{y}.${ext}`,
      filename: rootDir,
      metadata: metadata as unknown as Record<string, unknown>,
    },
    {
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.show !== undefined ? { show: options.show } : {}),
      ...(options.opacity !== undefined ? { opacity: options.opacity } : {}),
      maximumLevel: maxLevel,
    },
  );

  return {
    kind: 'xyz',
    layerId: layer.id,
    metadata,
    rootDir,
    info: {
      fileCount: blobs.size,
      totalBytes,
      xyzTemplate: metadata.detection?.xyzTemplate,
      xyzExt: ext,
      maxLevel,
      tileCount: blobs.size,
    },
  };
}

// ---------------------------------------------------------------------------
// 「模板 + 层级范围」免枚举导入（t25）
// ---------------------------------------------------------------------------

/** 模板模式导入选项（`importLocalXyzByTemplate`） */
export interface TemplateImportOptions {
  /** 完整瓦片模板（含 {z}/{x}/{y}，可选 {s}/{token}）；与 baseUrl 至少给一个 */
  template?: string;
  /** 基准地址（http(s) / file:// / 裸路径）；给 template 时忽略 */
  baseUrl?: string;
  /** 由基准地址推导模板时的瓦片后缀（默认 jpg，与用户实测的本地 XYZ 缓存一致） */
  ext?: string;
  /** 最小层级（默认 0） */
  minZoom?: number;
  /** 最大层级（默认 18） */
  maxZoom?: number;
  /** 切片模式（默认 web-mercator） */
  tilingMode?: XyzTilingMode;
  /** TMS：瓦片文件名 y 自南向北（Y 轴翻转；默认 false，t30） */
  tms?: boolean;
  /**
   * proj4 任意投影 CRS（t37，可选）：给定时切片方案用 Proj4TilingScheme（瓦片键即该
   * CRS 网格行列号，tilingMode 失效）；写入 metadata.crs（与 tilingMode 互斥）。
   */
  crs?: XyzLayerCrs;
  /** 图层名（缺省用基准目录名或模板） */
  name?: string;
  /** 初始可见性 / 不透明度 / 指定图层 id */
  show?: boolean;
  opacity?: number;
  id?: string;
  hasAlphaChannel?: boolean;
  /** 模板含 {s} 时的子域列表 */
  subdomains?: readonly string[];
  /** 模板含 {token} 时的令牌 */
  token?: string;
  /** 请求范围 [minLon, minLat, maxLon, maxLat]（可选；只对该矩形发请求） */
  bounds?: readonly [number, number, number, number];
  /** 是否允许 file:// 模板（默认 false；Electron webSecurity:false 场景可开） */
  allowFileUrls?: boolean;
  /**
   * 磁盘来源目录（t35，绝对路径；可选）：Electron 桌面原生导入时记录源目录到
   * `metadata.detection.sourceDir`，导出时据此分流到主进程流式导出。URL/托管模板
   * 图层不传（无本地磁盘路径）。
   */
  sourceDir?: string;
  /** 图像加载器（测试注入以断言「导入期零请求」与按需请求次数） */
  loadImage?: XyzTileImageLoader;
}

/** 模板模式导入结果（在通用结果上额外给出 provider，便于诊断/测试按需请求） */
export interface TemplateImportResult extends ImportLocalCacheResult {
  kind: 'xyz';
  /** 已注册的提供者（图层内部持有同一实例） */
  provider: LocalXyzImageryProvider;
  /** 实际使用的瓦片模板 */
  template: string;
  /** 层级范围 */
  minZoom: number;
  maxZoom: number;
}

/**
 * 「模板 + 层级范围」免枚举导入（t25）：**不枚举目录、不下载任何瓦片**，
 * 只注册一个按 `{z}/{x}/{y}` 现算 URL 的 imagery 图层，瓦片由 Cesium 按需请求。
 *
 * 适用场景（用户实测）：`file:///home/nuanyang/tiles`（2,426,811 文件 / 15GB，
 * `{z}/{x}/{y}.jpg`，无清单）——枚举 / 清单 / 全量下载三条路都不可行，模板模式
 * 可立即出图，且只在实际浏览到的区域请求瓦片。
 *
 * 约束与取舍：
 * - 图层 `metadata.files` 为**空数组**（模板模式无文件清单）→ **不可参与 zip 发布打包**；
 *   发布请改用服务端目录托管（见 `planCacheBundles` 的可读提示）；
 * - `metadata.detection.sourceMode === 'template'` 是可判定标记（配合空 files 判定）；
 * - file:// 模板默认拒绝（浏览器无法从页面加载本地瓦片），Electron 可传 `allowFileUrls: true`。
 */
export async function importLocalXyzByTemplate(
  layers: LayerManager,
  options: TemplateImportOptions,
): Promise<TemplateImportResult> {
  const minZoom = options.minZoom ?? 0;
  const maxZoom = options.maxZoom ?? 18;
  assertZoomRangeLoose(minZoom, maxZoom);

  const baseUrl = options.baseUrl?.trim();
  const template = (options.template?.trim() || (baseUrl ? deriveXyzTemplate(baseUrl, options.ext) : ''));
  const validation = validateXyzTemplate(template);
  if (!validation.ok) {
    throw new Error(
      `${validation.error}。可用「基准地址」自动推导（如 http://localhost:8090 → http://localhost:8090/{z}/{x}/{y}.jpg）`,
    );
  }
  const ext = options.ext?.replace(/^\./, '').trim() || xyzTemplateExt(template);

  const provider = new LocalXyzImageryProvider({
    urlTemplate: template,
    minLevel: minZoom,
    maxLevel: maxZoom,
    hasAlphaChannel: options.hasAlphaChannel ?? true,
    tilingMode: options.tilingMode ?? 'web-mercator',
    tms: options.tms === true,
    ...(options.subdomains ? { subdomains: options.subdomains } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.bounds ? { bounds: options.bounds } : {}),
    ...(options.crs ? { crs: options.crs } : {}),
    ...(options.allowFileUrls !== undefined ? { allowFileUrls: options.allowFileUrls } : {}),
    ...(options.loadImage ? { loadImage: options.loadImage } : {}),
  });

  const rootDir = templateRootDir(baseUrl, template);
  const templateTilingMode = options.tilingMode ?? 'web-mercator';
  const templateTms = options.tms === true;
  const metadata: LocalCacheMetadata = {
    cacheKind: 'xyz',
    // 模板模式没有文件清单：既省内存，也让发布侧能明确判定「无内容可打包」
    files: [],
    totalBytes: 0,
    rootDir: '',
    cacheSource: 'imported',
    // t37：crs 与 tilingMode 互斥（provider 内 crs 优先；rebuildXyz 同一约定）
    ...(options.crs ? { crs: options.crs } : { tilingMode: templateTilingMode }),
    tms: templateTms,
    ...(options.bounds ? { bounds: [...options.bounds] as [number, number, number, number] } : {}),
    detection: {
      xyzTemplate: template,
      xyzExt: ext,
      minLevel: minZoom,
      maxLevel: maxZoom,
      tileCount: 0,
      sourceMode: 'template',
      // t35：桌面原生导入记录磁盘来源目录（导出分流到主进程流式导出的依据）
      ...(options.sourceDir ? { sourceDir: options.sourceDir } : {}),
    },
  };

  const layer = layers.addImageryLayerInstance(
    options.name ?? rootDir,
    provider,
    {
      url: template,
      filename: rootDir,
      metadata: metadata as unknown as Record<string, unknown>,
    },
    {
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.show !== undefined ? { show: options.show } : {}),
      ...(options.opacity !== undefined ? { opacity: options.opacity } : {}),
      maximumLevel: maxZoom,
    },
  );

  return {
    kind: 'xyz',
    layerId: layer.id,
    provider,
    template,
    minZoom,
    maxZoom,
    metadata,
    rootDir,
    info: {
      fileCount: 0,
      totalBytes: 0,
      xyzTemplate: template,
      xyzExt: ext,
      maxLevel: maxZoom,
      tileCount: 0,
    },
  };
}

/**
 * 是否为「模板 + 层级范围」免枚举图层（无文件清单，不可打包发布）。
 * UI / publishCollect 用它给出可读提示，避免一键发布时报出难懂的错误。
 * 实现位于 `./types`（唯一真源，UI 侧无需引入 Cesium），此处原样 re-export。
 */
export { isTemplateXyzLayer } from './types';

/** 模板模式的层级范围校验（0~30 整数，min ≤ max；与生成侧 22 上限解耦） */
function assertZoomRangeLoose(minZoom: number, maxZoom: number): void {
  if (
    !Number.isInteger(minZoom) ||
    !Number.isInteger(maxZoom) ||
    minZoom < 0 ||
    maxZoom < minZoom ||
    maxZoom > 30
  ) {
    throw new Error(
      `层级范围非法：minZoom/maxZoom 应为 0~30 的整数且 minZoom ≤ maxZoom（实际 ${minZoom}~${maxZoom}）`,
    );
  }
}

/** 图层名 / rootDir：优先基准地址末段，其次模板末段 */
function templateRootDir(baseUrl: string | undefined, template: string): string {
  const source = (baseUrl && baseUrl.replace(/\/+$/, '')) || template;
  const last = source.split('/').pop() ?? '';
  const cleaned = last.replace(/\{.*\}/g, '').replace(/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i, '');
  try {
    return decodeURIComponent(cleaned) || 'tiles';
  } catch {
    return cleaned || 'tiles';
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 进度上报器：单调不减、异常不影响主流程 */
type ProgressReporter = (phase: LocalCacheProgress['phase'], processed: number, total: number) => void;

function createProgressReporter(onProgress?: (progress: LocalCacheProgress) => void): ProgressReporter {
  const last = new Map<LocalCacheProgress['phase'], number>();
  return (phase, processed, total) => {
    if (!onProgress) return;
    const bounded = Math.max(0, Math.min(processed, total));
    const previous = last.get(phase) ?? 0;
    const monotonic = Math.max(previous, bounded);
    last.set(phase, monotonic);
    try {
      onProgress({ phase, processed: monotonic, total });
    } catch {
      // 进度回调异常不影响导入
    }
  };
}

/** 文件数量上限校验（O(1)，在任何重活之前执行） */
function assertFileCountWithinLimit(count: number, maxFiles?: number): void {
  const limit = maxFiles ?? DEFAULT_MAX_LOCAL_CACHE_FILES;
  if (!Number.isFinite(limit)) return; // 显式关闭保护（Number.POSITIVE_INFINITY）
  if (count > limit) {
    throw new Error(
      `缓存目录文件数量过大：${count} 个文件（上限 ${limit}）。` +
        '为避免渲染进程卡死/OOM，已中止导入。建议：' +
        '① 按层级或范围把缓存拆成多个目录分批导入；' +
        '② 把缓存通过服务端发布后用「打开已发布场景」加载；' +
        '③ 确需尝试可显式提高 options.maxFiles（导入按异步切片执行，UI 不会冻结，但仍受浏览器内存限制）。',
    );
  }
}

/** 取全局 fetch（不存在时抛可读错误） */
function globalThisFetch(): typeof fetch {
  const impl = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof impl !== 'function') {
    throw new Error('当前环境不支持 fetch，无法按路径/URL 导入缓存');
  }
  return impl;
}

/**
 * 把用户给的路径 / URL 归一化为可 fetch 的基准地址。
 * - `file:///home/x/tiles` → 原样（去尾斜杠）
 * - `/home/x/tiles`、`C:\x\tiles` → `file:///...`
 * - `http(s)://…` → 原样
 * - `blob:` / `data:` / 其它协议 → 可读错误
 */
function resolveCacheBaseUrl(input: string): string {
  const trimmed = input.trim();
  const protocol = urlProtocolOf(trimmed);
  if (protocol && protocol !== 'file:' && protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(
      `不支持的缓存地址协议：${protocol}（仅支持 file:// 本地路径与 http(s) 地址）。` +
        '本地目录请用「导入 → 本地 XYZ 缓存目录」选择。',
    );
  }
  if (protocol) {
    try {
      const url = new URL(trimmed);
      url.hash = '';
      url.search = '';
      return url.href.replace(/\/+$/, '');
    } catch {
      throw new Error(`缓存地址格式不正确：${input}`);
    }
  }
  // 无 scheme：按本地文件系统路径处理
  const posix = trimmed.replace(/\\/g, '/');
  const withSlash = /^[a-zA-Z]:\//.test(posix) ? `/${posix}` : posix.startsWith('/') ? posix : `/${posix}`;
  try {
    return new URL(`file://${withSlash.replace(/\/+$/, '')}`).href;
  } catch {
    throw new Error(`本地路径格式不正确：${input}`);
  }
}

/** 目录基准名（图层的 rootDir/名称） */
function rootDirOf(baseUrl: string): string {
  const withoutSlash = baseUrl.replace(/\/+$/, '');
  const last = withoutSlash.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last) || 'tiles';
  } catch {
    return last || 'tiles';
  }
}

/** 相对/绝对瓦片引用 → 绝对 URL */
function resolveTileUrl(baseUrl: string, ref: string): string {
  const trimmed = String(ref ?? '').trim();
  if (!trimmed) return baseUrl;
  if (hasUrlScheme(trimmed)) return trimmed;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  try {
    return new URL(trimmed.replace(/^\.?\//, '').replace(/\\/g, '/'), base).href;
  } catch {
    return `${base}${trimmed.replace(/\\/g, '/')}`;
  }
}

/** 依次探测清单文件（最多 3 次请求，任一失败即跳过，不重试） */
async function findManifestUrl(baseUrl: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  // baseUrl 本身指向清单文件时直接用
  if (/\.json(\?|#|$)/i.test(baseUrl)) return baseUrl;
  for (const name of MANIFEST_CANDIDATES) {
    const candidate = `${baseUrl}/${name}`;
    try {
      const res = await fetchImpl(candidate);
      if (res && res.ok) return candidate;
    } catch {
      // 忽略：继续探测下一个候选
    }
  }
  return undefined;
}

/** 读清单并取出瓦片引用列表 */
async function readManifestTiles(
  manifestUrl: string,
  fetchImpl: typeof fetch,
  maxTiles: number,
): Promise<string[]> {
  let text: string;
  try {
    const res = await fetchImpl(manifestUrl);
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? '?'}`);
    text = await res.text();
  } catch (error) {
    throw new Error(
      `读取瓦片清单失败：${manifestUrl}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`瓦片清单不是合法 JSON：${manifestUrl}`);
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : (parsed as { tiles?: unknown })?.tiles;
  if (!Array.isArray(raw)) {
    throw new Error(`瓦片清单格式不受支持：${manifestUrl}（应为 string[] 或 { "tiles": string[] }）`);
  }
  const tiles = raw.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  if (tiles.length === 0) {
    throw new Error(`瓦片清单为空：${manifestUrl}`);
  }
  if (tiles.length > maxTiles) {
    throw new Error(
      `瓦片清单过大：${tiles.length} 条（上限 ${maxTiles}）。请拆分缓存或提高 options.maxTiles。`,
    );
  }
  return tiles;
}

/** 有界并发拉取瓦片为 Blob（单瓦片失败跳过；进度单调；支持取消） */
async function fetchTilesAsBlobs(
  urls: string[],
  options: {
    fetchImpl: typeof fetch;
    concurrency: number;
    report: ProgressReporter;
    signal?: AbortSignal;
  },
): Promise<Map<string, Blob>> {
  const blobs = new Map<string, Blob>();
  const total = urls.length;
  let next = 0;
  let done = 0;
  options.report('fetch', 0, total);

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) throw new Error('缓存导入已取消');
      const index = next++;
      if (index >= total) return;
      const url = urls[index]!;
      const key = xyzKeyFromUrl(url);
      try {
        const res = await options.fetchImpl(url);
        if (res && res.ok && key) {
          const blob = await res.blob();
          if (!blobs.has(key)) blobs.set(key, blob);
        }
      } catch {
        // 单瓦片失败：跳过（不重试、不阻塞整体）
      }
      done++;
      options.report('fetch', done, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, Math.max(1, total)) }, () => worker()),
  );
  return blobs;
}

/** 已知瓦片影像后缀（用于模板展示；避免把域名 `.com` 之类误判成后缀） */
const TILE_IMAGE_EXT_PATTERN = /\.(png|jpe?g|webp|gif|bmp|tiff?)(?:[?#]|$)/i;

/** 由瓦片 URL 推断后缀（缺省 png） */
function detectTileExt(urls: string[]): string {
  for (const url of urls) {
    const match = TILE_IMAGE_EXT_PATTERN.exec(url);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return 'png';
}

/** 给发布打包消费：把 LocalCacheMetadata 转成 zip 输入（保留相对路径 + rootDir） */
export function metadataToZipInputs(
  metadata: LocalCacheMetadata,
  fetchFile: (path: string) => Blob | File | undefined,
): { rootDir: string; entries: Array<{ path: string; data: Blob }> } {
  return {
    rootDir: metadata.rootDir,
    entries: metadata.files
      .map((f) => {
        const data = fetchFile(f.path);
        if (!data) return undefined;
        return { path: f.path, data };
      })
      .filter((e): e is { path: string; data: Blob } => e !== undefined),
  };
}