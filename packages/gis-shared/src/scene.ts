/**
 * @gis/shared · 场景文档 schema
 *
 * SceneDocument 是编辑器保存、服务端存储与发布、加载回放的统一场景描述。
 * 角度字段（lon/lat/heading/pitch/roll）一律为「度」，高度为「米」；
 * Cesium 内部使用弧度，由编辑器引擎层负责换算。
 */

import type { GeoJSONData, SceneLayerType } from './types.js';

// ---------------------------------------------------------------------------
// 相机
// ---------------------------------------------------------------------------

/** 初始视角：经纬度（度）、高度（米）、姿态角（度） */
export interface SceneCamera {
  /** 经度（度） */
  lon: number;
  /** 纬度（度） */
  lat: number;
  /** 高度（米） */
  height: number;
  /** 偏航角（度，0 = 正北） */
  heading: number;
  /** 俯仰角（度，-90 = 垂直向下） */
  pitch: number;
  /** 翻滚角（度） */
  roll: number;
}

// ---------------------------------------------------------------------------
// 图层
// ---------------------------------------------------------------------------

/** 图层数据来源方式：内嵌数据 / URL 引用 / 已上传资产 id 引用 */
export type SceneLayerSourceKind = 'inline' | 'url' | 'assetId';

export interface SceneLayerSource {
  kind: SceneLayerSourceKind;
  /** kind='url'：数据地址；imagery 瓦片可用 XYZ 模板（含 {z}/{x}/{y} 占位符） */
  url?: string;
  /** kind='assetId'：POST /api/assets 上传后返回的资产 id */
  assetId?: string;
  /** kind='assetId' 时的原始文件名（用于拼接资产 URL / 推断格式） */
  filename?: string;
}

/** 图层样式 */
export interface SceneLayerStyle {
  /** CSS 颜色，如 #ff0000、rgba(255,0,0,0.5) */
  color?: string;
  /** 线宽（像素） */
  width?: number;
  /** 高度（米）：GLB 模型放置高程或几何拉伸高度 */
  height?: number;
  /** 不透明度 0~1，默认 1 */
  opacity?: number;
  /** 可见性，默认 true */
  visibility?: boolean;
}

/** 配准/放置变换 */
export interface SceneLayerTransform {
  /**
   * 平移量：geojson 等矢量配准为 CRS 单位偏移；
   * glb 模型放置为 x=经度偏移（度）、y=纬度偏移（度）、z=高程偏移（米）。
   */
  translate?: { x?: number; y?: number; z?: number };
  /** 等比缩放因子，默认 1 */
  scale?: number;
  /** 绕 Z 轴旋转（度） */
  rotateZ?: number;
}

/** proj4 配准信息：源 CRS、目标 CRS 与配准变换 */
export interface SceneLayerProjection {
  /** 源数据 CRS：EPSG 代码（如 EPSG:4326）或 proj4 定义字符串 */
  crs?: string;
  /** 配准目标 CRS，默认 EPSG:4326（WGS84 经纬度） */
  targetCrs?: string;
  /** 配准/放置变换 */
  transform?: SceneLayerTransform;
}

export interface SceneLayer {
  /** 图层 id（场景内唯一） */
  id: string;
  /** 图层显示名 */
  name: string;
  /** 图层类型 */
  type: SceneLayerType;
  /** 数据来源（内嵌 / URL / 资产 id） */
  source: SceneLayerSource;
  /** 图层样式 */
  style?: SceneLayerStyle;
  /** proj4 配准信息（矢量数据源 CRS 与变换） */
  projection?: SceneLayerProjection;
  /** 模型/要素锚点（经纬高）：GLB 等模型的放置参数 */
  position?: { lon: number; lat: number; height?: number };
  /**
   * 内嵌 GeoJSON 数据：type='geojson' 且 source.kind='inline' 时有效；
   * 其余情况通过 source（url / assetId）引用，不内嵌。
   */
  features?: GeoJSONData;
  /**
   * 扩展元数据（编辑器自定义信息，服务端原样保存/回传）。
   *
   * 本地缓存图层用它携带 cacheKind / files / template 等发布打包所需信息：
   * 服务端场景包发布（POST /api/scenes/publish-package）会保留该字段原样写入
   * 托管版 SceneDocument，编辑器据此还原本地缓存图层的展示与再次发布。
   */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 底图（basemap registry，t19）
// ---------------------------------------------------------------------------

/**
 * 底图注册表条目（编辑器「底图管理」的持久化单元）。
 *
 * 底图与用户图层严格分离：底图不进入 SceneLayer[]、不参与发布打包；
 * 激活项（isActive === true，全局唯一）决定 viewer.imageryLayers 的第一层。
 */
export interface SceneBasemapItem {
  /** 底图 id（注册表内唯一；内置底图 id 固定，自定义底图为 `custom-N`） */
  id: string;
  /** preset：内置/预设底图（不可删除）；custom：用户自定义 URL 模板 */
  kind: 'preset' | 'custom';
  /** 显示名（列表与菜单展示） */
  label: string;
  /** XYZ URL 模板（含 {z}/{x}/{y}；天地图 / Cesium ion 用 {token} 占位） */
  urlTemplate: string;
  /** 访问令牌（天地图 key / Cesium ion token） */
  token?: string;
  /** 版权署名（影像 credit） */
  attribution?: string;
  /** 是否内置底图（内置底图不可删除） */
  isBuiltin: boolean;
  /** 是否为当前激活底图（注册表内唯一） */
  isActive: boolean;
  /** 叠加在底图之上的注记层模板（天地图 vec 的 cva_w 注记） */
  annotationUrlTemplate?: string;
  /** {s} 子域占位符候选值（天地图 t0..t7） */
  subdomains?: string[];
  /** 最大层级（默认由引擎给出，天地图 18 / OSM 19） */
  maximumLevel?: number;
  /** 是否需要 token 才能加载（天地图 / Cesium ion） */
  requiresToken?: boolean;
  /** 影像提供者类型：urlTemplate（默认）/ ion（Cesium ion REST API） */
  provider?: 'urlTemplate' | 'ion';
  /** provider='ion' 时的 Cesium ion 资产 id */
  ionAssetId?: number;
  /** 显示开关（false 时对应影像层 show=false），默认 true */
  visible?: boolean;
}

/**
 * 场景文档中的底图状态：注册表快照 + 当前激活项。
 * 快照里带上用户自定义底图，保证「保存 → 打开」后底图列表与激活项都能还原。
 */
export interface SceneBasemapState {
  /** 当前激活底图 id（写入时与 id 保持一致；读取时优先本字段） */
  activeId: string;
  /** 当前激活底图 id（兼容字段，与 activeId 同义） */
  id?: string;
  /** 底图注册表快照（含用户自定义底图） */
  items: SceneBasemapItem[];
}

// ---------------------------------------------------------------------------
// 场景文档
// ---------------------------------------------------------------------------

/** 当前场景文档 schema 版本 */
export const SCENE_FORMAT_VERSION = 1 as const;

/** 场景文档：编辑器 ↔ 服务端 的统一场景描述 */
export interface SceneDocument {
  /** 场景文档 schema 版本（当前为 1） */
  version: number;
  /** 场景 id：服务端保存时生成；新建未保存的文档可缺省 */
  id?: string;
  /** 场景名 */
  name: string;
  /** 场景描述 */
  description?: string;
  /** 初始视角 */
  camera?: SceneCamera;
  /** 图层列表 */
  layers: SceneLayer[];
  /** 场景级内嵌 GeoJSON（可选，与图层内嵌 features 并存的另一种组织方式） */
  features?: GeoJSONData;
  /** 扩展元数据（编辑器自定义信息） */
  metadata?: Record<string, unknown>;
  /**
   * 底图状态（可选，t19）：激活底图 + 底图注册表快照。
   * 底图不属于用户图层，不参与发布打包，仅用于编辑器打开场景后还原底图列表与激活项。
   */
  basemap?: SceneBasemapState;
  /** 服务端维护：创建时间（ISO 8601） */
  createdAt?: string;
  /** 服务端维护：最近更新时间（ISO 8601） */
  updatedAt?: string;
  /** 服务端维护：创建者（来自 Bearer Token 对应的 AUTH_USER，默认 anonymous） */
  createdBy?: string;
  /** 服务端维护：最近更新者（来自 Bearer Token 对应的 AUTH_USER） */
  updatedBy?: string;
}

/** 场景列表项（GET /api/scenes 返回，不含图层明细） */
export interface SceneSummary {
  id: string;
  name: string;
  description?: string;
  /** 图层数量 */
  layerCount?: number;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  updatedBy?: string;
}
