/**
 * @geolibre/xyz-cache · layer-manager —— 图层管理器最小结构契约
 *
 * 从 gis-full editor `core/LayerManager.ts` 抽出的**结构性子集**：本包的导入 /
 * 重建 / 生成链路只按结构消费这些成员（注册影像图层、注册 3D Tiles、读取图层
 * 快照 / 来源 / provider、移除图层）。宿主应用（编辑器 / 桌面端）传入自己的
 * LayerManager 实例即可——鸭子类型，不引入 Cesium Viewer 依赖。
 */

/** 图层类型（对齐 gis-full `DataLayerType`，本包只用 imagery / 3dtiles 两种） */
export type DataLayerType = 'imagery' | 'geojson' | 'kml' | 'glb' | '3dtiles';

/** 图层样式（编辑器内部表示的字段子集） */
export interface LayerStyle {
  color?: string;
  width?: number;
  height?: number;
  pointSize?: number;
}

/** 图层快照信息（纯数据） */
export interface LayerInfo {
  id: string;
  name: string;
  type: DataLayerType;
  show: boolean;
  /** 不透明度 0~1 */
  opacity: number;
  /** 当前样式（geojson / kml 要素图层适用） */
  style?: LayerStyle;
}

/** 图层数据来源记录（供场景序列化、发布打包等读取） */
export interface LayerSource {
  /** 数据地址（url 来源 / GLB 模型 / XYZ 模板 / blob URL） */
  url?: string;
  /** 内嵌 GeoJSON 数据（inline 来源） */
  geojson?: unknown;
  /** 模型放置位置（glb） */
  position?: { lon: number; lat: number; height: number };
  /** 模型缩放（glb） */
  modelScale?: number;
  /** 模型绕 Z 旋转（度，glb） */
  modelHeading?: number;
  /** 原始文件名（导入时记录） */
  filename?: string;
  /** 扩展元数据（本地缓存图层等：cacheKind / files / template 等） */
  metadata?: Record<string, unknown>;
  /** 已上传到服务端的资产 id */
  assetId?: string;
}

/** 通用新增图层选项 */
export interface AddLayerOptions {
  /** 指定图层 id；缺省自动生成 */
  id?: string;
  /** 初始可见性，默认 true */
  show?: boolean;
  /** 初始不透明度 0~1，默认 1 */
  opacity?: number;
  /** 附加数据来源信息（传入字段优先） */
  source?: Partial<LayerSource>;
}

/** 3D Tiles 图层选项 */
export interface TilesetLayerOptions extends AddLayerOptions {
  /** 最大屏幕空间误差，默认 16 */
  maximumScreenSpaceError?: number;
}

/** XYZ 影像图层选项 */
export interface XyzTilesLayerOptions extends AddLayerOptions {
  /** 最大层级 */
  maximumLevel?: number;
  /** 瓦片署名信息 */
  credit?: string;
}

/**
 * 图层管理器最小结构（本包消费面）：
 * - `addImageryLayerInstance` / `add3DTilesInstance`：注册已构建的 provider / tileset；
 * - `get` / `getLayerSource` / `getImageryProvider` / `remove`：图层快照与生命周期。
 *
 * provider / tileset 参数按 `unknown` 接收（鸭子类型：LocalXyzImageryProvider、
 * Cesium3DTileset 或测试替身均可），由宿主实现负责具体装载。
 */
export interface LayerManager {
  /** 读取单个图层快照 */
  get(id: string): LayerInfo | undefined;
  /** 读取图层数据来源记录 */
  getLayerSource(id: string): LayerSource | undefined;
  /** 读取影像图层的 ImageryProvider 实例（非 imagery 图层返回 undefined） */
  getImageryProvider(id: string): unknown;
  /** 移除图层 */
  remove(id: string): void;
  /** 直接注册一个 ImageryProvider 为影像图层 */
  addImageryLayerInstance(
    name: string,
    provider: unknown,
    source?: LayerSource,
    options?: XyzTilesLayerOptions,
  ): LayerInfo;
  /** 直接注册一个已构建的 3D Tiles tileset 为图层 */
  add3DTilesInstance(
    name: string,
    tileset: unknown,
    source?: LayerSource,
    options?: TilesetLayerOptions,
  ): Promise<LayerInfo>;
}
