/**
 * @geolibre/xyz-cache —— XYZ / 3D Tiles 本地缓存子系统（移植自 gis-full editor core/localCache）
 *
 * - xyz-cache：XYZ 瓦片目录导入（z/x/y → blob URL 映射 + 自定义 ImageryProvider）；
 *   同一 provider 还支持 `urlTemplate` 免枚举模板模式（按需拉取，导入期零请求）
 * - local-cache：统一导入入口 importLocalCache（探测缓存类型 + 注册到 LayerManager）；
 *   另有 importLocalXyzByTemplate（模板 + 层级范围，免枚举 / 零下载）
 * - tile-url：`{z}/{x}/{y}` 模板代入与校验（generate-2d 与 xyz-cache 共用）
 * - tileset-cache：3D Tiles 缓存目录导入（tileset.json 内部 URI 重写为 blob URL）
 * - zip-bundle：把缓存文件清单打包为 zip
 * - generate-3d：三维模型（OBJ / STL）→ 3D Tiles 1.1 缓存生成
 * - generate-2d：GeoJSON 矢量 → XYZ PNG 瓦片缓存生成
 * - export-cache：本地缓存图层导出为 ZIP（浏览器下载 / 桌面端另存为）
 * - bounds / rebuild-xyz / scale：范围推算、图层在线重建、超大场景护栏
 * - crs-registry / proj4-tiling-scheme：CRS 注册表与 proj4 任意投影切片方案
 * - xyz-disk：磁盘瓦片管线（有界扫描 / 流式导出），IO 经可注入的 CacheStorage
 */
export * from './types';
export * from './detect';
export * from './tileset-rewrite';
export * from './zip-bundle';
export * from './xyz-cache';
export * from './tileset-cache';
export * from './local-cache';
export * from './generate-3d';
export * from './generate-2d';
export * from './export-cache';
export * from './bounds';
export * from './rebuild-xyz';
export * from './scale';
export * from './crs-registry';
export * from './proj4-tiling-scheme';
// tileUrl 的 buildXyzTileUrl / DEFAULT_XYZ_SUBDOMAINS 已由 generate-2d 显式 re-export
// （避免 `export *` 重名冲突），这里只补充模板推导/校验工具。
export {
  DEFAULT_XYZ_TILE_EXT,
  deriveXyzTemplate,
  hasXyzPlaceholders,
  validateXyzTemplate,
  xyzTemplateExt,
} from './tile-url';
// 图层管理器最小结构契约（宿主按结构实现）
export type {
  AddLayerOptions,
  DataLayerType,
  LayerInfo,
  LayerManager,
  LayerSource,
  LayerStyle,
  TilesetLayerOptions,
  XyzTilesLayerOptions,
} from './layer-manager';
// 浏览器引擎识别（local-cache 的 Firefox 提示复用）
export * from './browser-env';
// 字节数可读化（scale 的文案复用）
export { formatBytes } from './format-bytes';
// 磁盘 IO 抽象与 Node 实现
export type {
  CacheBuffer,
  CacheDir,
  CacheDirent,
  CacheFileHandle,
  CacheReadStreamOptions,
  CacheStats,
  CacheStorage,
} from './cache-storage';
// xyz-disk / node-cache-storage 为 Node 专属模块（node:fs/node:crypto），
// 已移至 Node 入口 `@geolibre/xyz-cache/node`——浏览器 bundle 不应引用；
