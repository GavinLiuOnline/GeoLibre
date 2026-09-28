/**
 * editor/core · localCache/types —— 本地缓存图层相关类型
 */

/** 本地缓存图层类型 */
export type LocalCacheKind = '3dtiles' | 'xyz';

/**
 * 缓存文件清单条目。相对路径相对缓存目录根（webkitdirectory 选中目录）。
 * `path` 使用 POSIX 风格分隔符（'/'）。
 */
export interface CacheFileEntry {
  /** 相对路径（POSIX 分隔符），如 "tileset.json"、"Tiles/0/0/0.b3dm" */
  path: string;
  /** 文件字节数 */
  size: number;
}

/** 本地缓存图层的元数据（写入 LayerManager.source.metadata 供后续发布打包消费） */
export interface LocalCacheMetadata {
  /** 缓存类型 */
  cacheKind: LocalCacheKind;
  /** 文件清单（相对路径 + 字节数） */
  files: CacheFileEntry[];
  /** 全部字节数（冗余记录，便于 UI 显示） */
  totalBytes: number;
  /**
   * 缓存根目录的目录名（webkitRelativePath 的第一段），供发布打包 zip
   * 时保持目录结构（与 services 约定：3D Tiles 数据集根或一层目录内含
   * tileset.json；XYZ 包按 {z}/{x}/{y}.ext）
   */
  rootDir: string;
  /**
   * 缓存来源（可选，向后兼容）：
   * - 'imported'：用户导入的目录缓存（缺省语义，既有导入路径不写该字段）
   * - 'generated'：编辑器内由三维模型（generate3d）或矢量（t13）生成
   * 供 UI 区分展示与发布链路诊断，服务端原样保存。
   */
  cacheSource?: 'imported' | 'generated';
  /**
   * 切片模式（t30，仅 cacheKind='xyz'）：'web-mercator'（默认）| 'geographic'。
   * 缺省视为 'web-mercator'（与既有行为一致）；属性面板可改，应用后重建 provider。
   */
  tilingMode?: XyzTilingMode;
  /**
   * TMS（t30，仅 cacheKind='xyz'）：true = 瓦片文件名 y 自南向北（Y 轴翻转），
   * 请求时按 y' = 2^z - 1 - y 换算。缺省 false（标准 XYZ，既有行为）。
   */
  tms?: boolean;
  /**
   * 地理范围（t30，仅 cacheKind='xyz'）：[minLon, minLat, maxLon, maxLat]（度，WGS84）。
   * 来源优先级：用户指定 > 瓦片键集合推算 > 缺省全球。注册时传给
   * provider.rectangle（限定请求范围 + zoomTo 定位），并随场景保存/打开往返。
   */
  bounds?: [number, number, number, number];
  /**
   * proj4 任意投影 CRS（t37，仅 cacheKind='xyz'）。存在时**优先于 tilingMode**：
   * provider 用自定义 Proj4TilingScheme（2^z 方格均分 validBounds、origin 默认左上），
   * 瓦片键 {z}/{x}/{y} 即该 CRS 网格的行列号。删除该字段即回退内置切片方案
   * （tilingMode：web-mercator/geographic）。自包含（proj4 字符串 + validBounds），
   * 随场景保存/打开整包往返，不依赖注册表演化。
   */
  crs?: XyzLayerCrs;
  /** 探测结果（仅诊断用） */
  detection?: {
    /** 命中的 3D Tiles 入口文件名（仅 cacheKind='3dtiles'） */
    tilesetPath?: string;
    /** XYZ 模板（仅 cacheKind='xyz'） */
    xyzTemplate?: string;
    /** XYZ 瓦片后缀（仅 cacheKind='xyz'） */
    xyzExt?: string;
    /** 探测到的最大 z */
    maxLevel?: number;
    /** 探测到的瓦片数量 */
    tileCount?: number;
    /**
     * 最小层级（t25：模板模式按 {minLevel, maxLevel} 校验请求范围；
     * 目录导入的探测路径不写该字段）
     */
    minLevel?: number;
    /**
     * 数据来源模式（t25）：
     * - 'files'：有文件清单（目录导入 / 生成缓存 / 清单式 URL 导入）→ 可打包发布；
     * - 'template'：**免枚举模板模式**（t25）→ `files` 为空、无内容可打包，
     *   发布侧应引导改用服务端目录托管，而不是报「缓存文件不可用」。
     * 缺省（undefined）表示历史数据，按 'files' 语义处理。
     */
    sourceMode?: 'files' | 'template';
    /**
     * 磁盘来源目录（t35，绝对路径）：Electron 桌面端「导入本机瓦片目录（桌面原生）」
     * 导入的图层记录其源目录，导出时据此分流到主进程流式导出（zip / 目录直拷，
     * 恒定内存、支持 bounds + 层级裁剪、无渲染进程内存上限）。服务端托管 / URL 模板
     * 图层没有该字段（无本地磁盘路径可流式读取）。
     */
    sourceDir?: string;
  };
}

/** ImageryProvider 模式：地理（lon/lat）还是 Web 墨卡托 */
export type XyzTilingMode = 'web-mercator' | 'geographic';

/**
 * proj4 CRS 的瓦片网格形态（t37）：
 * - 'square-2^z'（默认）：每层 2^z × 2^z 方格均分 validBounds（投影类 CRS 的标准 XYZ）；
 * - 'geodetic-2x1'：每层 2^(z+1) × 2^z（level 0 有 2×1 个根瓦片）——经纬度直方格缓存的
 *   通用约定（与 Cesium GeographicTilingScheme / GeoServer EPSG4326 GridSet 一致），
 *   内置 4326/4490 别名走该网格。
 */
export type XyzCrsTileMatrix = 'square-2^z' | 'geodetic-2x1';

/**
 * XYZ 缓存图层的 proj4 坐标系描述（t37；写入 LocalCacheMetadata.crs，随场景往返）。
 * 自包含：`proj4` 为**解析后的定义字符串**（注册表命中时也是展开值），重载不依赖注册表。
 */
export interface XyzLayerCrs {
  /** 固定 'proj4'（保留扩展位；内置 3857/4326 简写不写该对象，走 tilingMode） */
  kind: 'proj4';
  /** proj4 定义字符串（如 '+proj=tmerc +lon_0=105 ... +ellps=GRS80 +units=m +no_defs'） */
  proj4: string;
  /** 有效范围 [minLon, minLat, maxLon, maxLat]（度）——2^z 方格均分的网格范围 */
  validBounds: [number, number, number, number];
  /** 瓦片原点（缺省 'top-left' = XYZ 标准，y 自北向南） */
  origin?: 'top-left' | 'bottom-left';
  /** 网格形态（缺省 'square-2^z'） */
  tileMatrix?: XyzCrsTileMatrix;
  /** 注册表来源 id（如 'EPSG:4544'；仅展示/回显用，不影响行为） */
  id?: string;
  /** 显示名（如 'CGCS2000 / 3-degree Gauss-Kruger CM 105E'；仅展示用） */
  label?: string;
}

/**
 * 是否为「模板 + 层级范围」免枚举图层（t25）。
 *
 * 判定口径（发布 / UI 共用的唯一真源）：
 * - 显式标记：`detection.sourceMode === 'template'`（`importLocalXyzByTemplate` 产物）；
 * - 兼容兜底：`detection.xyzTemplate` 存在且 `files` 为空（历史/手工 metadata）。
 *
 * 这类图层**没有文件清单**，无法参与 zip 发布打包；发布侧据此给出可读引导
 * （见 `stores/publishCollect.planCacheBundles`）。放在 types.ts 里是为了让
 * UI / 发布逻辑无需引入 Cesium 即可判定。
 */
export function isTemplateXyzLayer(
  metadata: LocalCacheMetadata | Record<string, unknown> | undefined,
): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const meta = metadata as Pick<LocalCacheMetadata, 'cacheKind' | 'files' | 'detection'>;
  if (meta.cacheKind !== 'xyz') return false;
  if (meta.detection?.sourceMode === 'template') return true;
  return !!meta.detection?.xyzTemplate && Array.isArray(meta.files) && meta.files.length === 0;
}

/** XYZ 缓存导入选项 */
export interface XyzCacheImportOptions {
  /** 图层名（缺省用目录名） */
  name?: string;
  /** 瓦片编号切片范围 [zMin, zMax]，缺省探测得到 */
  levelRange?: [number, number];
  /** 影像 alpha 通道（true = 含透明） */
  hasAlphaChannel?: boolean;
  /** 模式：web-mercator（默认）或 geographic（CGCS2000 经纬度直方格） */
  tilingMode?: XyzTilingMode;
  /** TMS：瓦片文件名 y 自南向北（Y 轴翻转；默认 false，t30） */
  tms?: boolean;
  /** 用户指定的地理范围 [minLon, minLat, maxLon, maxLat]（度；缺省由瓦片键推算，t30） */
  bounds?: [number, number, number, number];
  /**
   * proj4 任意投影 CRS（t37，可选）：给定时瓦片网格按该 CRS 的 2^z 方格均分
   * validBounds 计算（tilingMode 失效）；缺省沿用 tilingMode 内置方案。
   */
  crs?: XyzLayerCrs;
  /** 初始可见性 */
  show?: boolean;
  /** 初始不透明度 */
  opacity?: number;
  /** 指定图层 id */
  id?: string;
}

/** 3D Tiles 缓存导入选项 */
export interface TilesetCacheImportOptions {
  /** 图层名（缺省用目录名） */
  name?: string;
  /** 强制指定 tileset.json 路径（相对缓存根），缺省自动探测 */
  tilesetPath?: string;
  /** 最大屏幕空间误差 */
  maximumScreenSpaceError?: number;
  /** 初始可见性 */
  show?: boolean;
  /** 初始不透明度 */
  opacity?: number;
  /** 指定图层 id */
  id?: string;
}

/** 本地缓存导入进度（单调不减，供 UI 显示进度/取消） */
export interface LocalCacheProgress {
  /** 阶段：detect 探测 / scan 扫描文件 / build 构建映射 / fetch 拉取瓦片 / register 注册图层 */
  phase: 'detect' | 'scan' | 'build' | 'fetch' | 'register';
  /** 已处理数量（0 ≤ processed ≤ total） */
  processed: number;
  /** 总数量 */
  total: number;
}

/** 通用本地缓存导入选项 */
export interface LocalCacheImportOptions {
  /** 图层名（缺省用目录名） */
  name?: string;
  /** 指定缓存类型；缺省自动探测（先 3D Tiles，再 XYZ） */
  cacheKind?: LocalCacheKind;
  /** 3D Tiles 特定选项 */
  tileset?: TilesetCacheImportOptions;
  /** XYZ 特定选项 */
  xyz?: XyzCacheImportOptions;
  /** 初始可见性 */
  show?: boolean;
  /** 初始不透明度 */
  opacity?: number;
  /** 指定图层 id */
  id?: string;
  /**
   * 文件数量上限（默认 200000，防超大目录把渲染进程拖死/OOM）。
   * 探测前按 `files.length` 做 O(1) 校验，超限直接抛可读错误；
   * 传 `Number.POSITIVE_INFINITY` 可显式关闭该保护（导入改为异步切片，UI 不冻结）。
   */
  maxFiles?: number;
  /** 进度回调（单调不减）；异常不会打断导入 */
  onProgress?: (progress: LocalCacheProgress) => void;
  /**
   * XYZ 图层是否用「懒加载对象 URL」（默认 true）：只在 Cesium 真正请求某瓦片时
   * 才 createObjectURL，避免十万级瓦片一次性注册 blob URL 卡死渲染进程。
   */
  lazyTileUrls?: boolean;
}

/**
 * XYZ「路径 / URL」导入选项（t18：file:// 路径回退路径）。
 * 浏览器无法枚举本地目录，因此目录清单必须由目录内的清单文件提供
 * （index.json / tiles.json / manifest.json，或调用方显式给定 `tiles`/`manifestUrl`）。
 */
export interface XyzUrlImportOptions extends LocalCacheImportOptions {
  /** 显式瓦片清单（相对 base 或绝对 URL），缺省从清单文件读取 */
  tiles?: string[];
  /** 清单文件 URL；缺省依次探测 `${base}/index.json`、`tiles.json`、`manifest.json` */
  manifestUrl?: string;
  /** 拉取瓦片并发数（默认 8） */
  concurrency?: number;
  /** 瓦片数量上限（默认 50000，超限抛可读错误） */
  maxTiles?: number;
  /** 取消信号（拉取过程中可中止） */
  signal?: AbortSignal;
  /** 注入 fetch（测试用）；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 目录选择得到的文件清单（webkitdirectory 模式） */
export interface DirectoryFile extends File {
  /** webkitRelativePath 必有（webkitdirectory 强制） */
  webkitRelativePath: string;
}

/**
 * zipCacheBundle 选项
 */
export interface ZipBundleOptions {
  /** 压缩级别 0~9（默认 6） */
  compressionLevel?: number;
  /** 压缩方法：STORE / DEFLATE（默认 DEFLATE） */
  compressionMethod?: 'STORE' | 'DEFLATE';
  /** 文件 mime 类型探测（按后缀），写入 zip 时携带 */
  detectMime?: boolean;
  /**
   * 压缩生成进度（JSZip generateAsync 阶段，`percent` 0~100）。
   * 仅作为**只读观察**用途：不传时行为与旧版完全一致；回调异常被吞掉，不影响打包。
   */
  onProgress?: (progress: { percent: number; currentFile?: string | null }) => void;
}

/** zipCacheBundle 返回 */
export interface ZipBundleResult {
  /** 压缩后的 Blob（application/zip） */
  zip: Blob;
  /** 文件数量 */
  fileCount: number;
  /** 原始总字节数 */
  totalBytes: number;
}