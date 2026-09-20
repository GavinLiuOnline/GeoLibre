/**
 * @gis/shared · 通用类型
 *
 * GeoJSON（RFC 7946 常用子集）、图层类型联合、发布清单（PublishManifest）、
 * 资产上传结果等跨包类型。服务端 / 编辑器 / 桌面端一律从本包导入，禁止重复定义。
 */

import type { SceneDocument } from './scene.js';

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

/** GeoJSON 坐标位置 [lon, lat] 或 [lon, lat, height]（十进制度 / 米） */
export type GeoJSONPosition = [number, number] | [number, number, number];

export interface GeoJSONPoint {
  type: 'Point';
  coordinates: GeoJSONPosition;
}

export interface GeoJSONMultiPoint {
  type: 'MultiPoint';
  coordinates: GeoJSONPosition[];
}

export interface GeoJSONLineString {
  type: 'LineString';
  coordinates: GeoJSONPosition[];
}

export interface GeoJSONMultiLineString {
  type: 'MultiLineString';
  coordinates: GeoJSONPosition[][];
}

export interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: GeoJSONPosition[][];
}

export interface GeoJSONMultiPolygon {
  type: 'MultiPolygon';
  coordinates: GeoJSONPosition[][][];
}

export type GeoJSONGeometry =
  | GeoJSONPoint
  | GeoJSONMultiPoint
  | GeoJSONLineString
  | GeoJSONMultiLineString
  | GeoJSONPolygon
  | GeoJSONMultiPolygon;

export type GeoJSONGeometryName = GeoJSONGeometry['type'];

/** GeoJSON 要素（P 为属性对象类型，默认任意属性表） */
export interface GeoJSONFeature<P = Record<string, unknown>> {
  type: 'Feature';
  id?: string | number;
  geometry: GeoJSONGeometry | null;
  properties: P | null;
}

/** GeoJSON 要素集合 */
export interface GeoJSONFeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: GeoJSONFeature<P>[];
  bbox?:
    | [number, number, number, number]
    | [number, number, number, number, number, number];
}

/** 任意 GeoJSON 数据（几何 / 要素 / 要素集合），用于场景文档内嵌或引用判断 */
export type GeoJSONData = GeoJSONGeometry | GeoJSONFeature | GeoJSONFeatureCollection;

// ---------------------------------------------------------------------------
// 图层
// ---------------------------------------------------------------------------

/** 场景图层类型：影像底图 / 地形 / GeoJSON 矢量 / KML / GLB 模型 / 3D Tiles */
export type SceneLayerType = 'imagery' | 'terrain' | 'geojson' | 'kml' | 'glb' | '3dtiles';

// ---------------------------------------------------------------------------
// 发布
// ---------------------------------------------------------------------------

/** 发布产物类型：GeoJSON 静态文件 / XYZ 瓦片 / 3D Tiles tileset / GLB 模型 */
export type PublishArtifactKind = 'geojson' | 'tiles' | 'tileset' | 'glb';

export interface PublishArtifact {
  kind: PublishArtifactKind;
  /**
   * 产物 URL：
   * - 常规产物为服务端根相对路径，如 `/published/<slug>/tileset.json`；
   * - `tiles` 产物为 XYZ 模板 URL，含 `{z}/{x}/{y}` 占位符，
   *   如 `/published/<slug>/tiles/{z}/{x}/{y}.png`。
   */
  url: string;
  /** 产物显示名（图层名 / 源文件名） */
  name?: string;
  /** 文件格式（png / json / glb / geojson…） */
  format?: string;
}

/** 发布清单：一次场景发布生成的全部产物汇总（服务端落盘 manifest.json，并作为发布接口返回值） */
export interface PublishManifest {
  /** 场景 id */
  sceneId: string;
  /** 发布目录标识（URL 友好 slug，默认由场景名生成） */
  slug: string;
  /** 场景名快照 */
  name?: string;
  /** 发布时间（ISO 8601） */
  publishedAt: string;
  /** 全部产物列表 */
  artifacts: PublishArtifact[];
}

// ---------------------------------------------------------------------------
// 场景包发布（multipart 一次性上传：scene.json + 本地缓存 zip + 零散资产）
// ---------------------------------------------------------------------------

/**
 * 场景包发布请求结构（仅文档化，便于编辑器 / 桌面端统一构造 FormData）：
 *
 *  multipart/form-data 字段
 *  -----------------------
 *  - `scene`               JSON 字段名，值为 SceneDocument 的 JSON 字符串（必填）
 *  - `bundles[<layerId>]`  zip 字段名（必填至少一个或允许为空数组），每个 zip 内含
 *                          一个本地缓存图层：
 *                          - kind='xyz'  → XYZ 瓦片树（z/x/y.<ext>），解压到
 *                            /published/<slug>/tiles/；
 *                          - kind='3dtiles' → 3D Tiles 数据集（内含 tileset.json），
 *                            解压并把 tileset.json 提升到 /published/<slug>/。
 *                          FormData 字段名按 `bundles[<layerId>]` 命名，并随附同
 *                          名 JSON 字段 `bundleMeta` 描述数组：`{ layerId, kind }[]`
 *  - `assets[]`            零散资产文件（glb/gltf/geojson/kml...），落到
 *                          /published/<slug>/models/。
 *
 *  bundle 与 layer 的对应关系
 *  --------------------------
 *  FormData 同时附带 JSON 字段 `bundleMeta`：`[{ layerId, kind }, ...]`，
 *  服务端按下标匹配 `bundles[<layerId>]` 文件（顺序敏感，缺失即 400）。
 */
export interface PublishPackageBundle {
  /** 对应场景图层 id（SceneDocument.layers[].id） */
  layerId: string;
  /** 缓存类型：xyz 瓦片树 / 3D Tiles 数据集 */
  kind: 'xyz' | '3dtiles';
  /** zip 数据（编辑器 File / Blob 或字节数组） */
  zip: Blob | File | ArrayBuffer | ArrayBufferView;
  /** zip 文件名（默认 layerId + .zip） */
  filename?: string;
}

/** 零散资产（GLB/GLTF/GeoJSON/KML 等），落到发布包 /models/ */
export interface PublishPackageAsset {
  /** 文件内容 */
  data: Blob | File | ArrayBuffer | ArrayBufferView;
  /** 保存到 /models/ 的文件名 */
  filename: string;
  /** MIME 类型（可选） */
  contentType?: string;
}

/** publishScenePackage 调用选项 */
export interface PublishPackageOptions {
  /**
   * 覆盖默认基础地址（仅本次调用生效）；
   * 不传则用 client.baseUrl。
   */
  baseUrl?: string;
  /**
   * 覆盖或临时注入 Token（仅本次调用生效）；
   * 缺省时使用 client 当前的 token。
   */
  token?: string;
  /** XHR 风格进度回调（仅在浏览器 fetch 支持时可用） */
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * publishScenePackage 返回值：托管场景地址 + 清单 + 改写后的 SceneDocument。
 *
 * 编辑器拿到 hostedScene（或 GET hostedSceneUrl）后可直接还原：
 * - hostedScene.layers[*].source.url 已是服务端 URL（XYZ 模板或 tileset.json）；
 * - editorUi 拿这套 SceneDocument → serverSync.loadSceneIntoLayers 即可加载。
 */
export interface PublishPackageResult {
  /** 发布清单（与 POST /api/scenes/:id/publish 同结构） */
  manifest: PublishManifest;
  /** 托管场景的根相对 URL（GET /published/<slug>/scene.json） */
  hostedSceneUrl: string;
  /** 改写后的 SceneDocument：图层 source 已是服务端 URL，可直接加载 */
  hostedScene: SceneDocument;
}

/**
 * 服务实例（服务注册表条目，GET /api/services 返回）。
 * 一个 slug 即一个对外服务实例：场景发布或 3D Tiles 数据集 zip 直接发布都会注册。
 */
export interface ServiceEntry {
  /** 发布目录标识；slug 规则：<名称 slugified>-<短id>，同场景/同资产重复发布覆盖同 slug */
  slug: string;
  /** 来源场景 id；由资产直接发布的服务为 ''（无场景来源） */
  sceneId: string;
  /** 来源场景名（或资产文件名）快照 */
  sceneName: string;
  /** 产物类型去重集合（geojson/tiles/tileset/glb），多于一种即为混合服务 */
  types: PublishArtifactKind[];
  /** 全部产物列表 */
  artifacts: PublishArtifact[];
  /** 首次发布时间（ISO 8601） */
  publishedAt: string;
  /** 最近（重新）发布时间（ISO 8601） */
  updatedAt: string;
  /** 由资产直接发布时记录来源资产 id（重新发布用），场景发布无此字段 */
  assetId?: string;
  /**
   * 目录托管服务的源目录绝对路径（t26，realpath 规范化后）。
   * 仅 `POST /api/services/host-directory` 注册的服务带此字段：
   * 服务端直接按路径托管该目录（免上传），注销服务**不会删除**源目录任何文件。
   */
  hostDir?: string;
  /** 目录托管类型（t26）：'xyz' 瓦片目录 / '3dtiles' 数据集目录 */
  hostKind?: 'xyz' | '3dtiles';
  /** 发布者（来自 Bearer Token 对应的 AUTH_USER，默认 anonymous） */
  createdBy?: string;
}

// ---------------------------------------------------------------------------
// 目录托管（t26：POST /api/services/host-directory）
// ---------------------------------------------------------------------------

/** 目录托管类型：XYZ 瓦片目录 / 3D Tiles 数据集目录 */
export type HostDirectoryKind = 'xyz' | '3dtiles';

/** XYZ 目录的轻量扫描结果（服务端有界扫描，不读取瓦片内容） */
export interface HostDirectoryXyzScan {
  kind: 'xyz';
  /** 顶层 z 目录层级（升序） */
  levels: number[];
  /** 每层瓦片数（有界；达到上限即停止并置 truncated） */
  tileCounts: Record<string, number>;
  /** 计数是否被上限截断 */
  truncated: boolean;
  /** 抽样探测到的扩展名（升序） */
  extensions: string[];
  /** 主扩展名 */
  primaryExt: string;
  /** 统计到的瓦片总数（有界） */
  totalTiles: number;
  /** 扫描过的条目数（诊断用） */
  scannedEntries: number;
  /** 是否读取了瓦片内容（恒为 false） */
  contentRead: false;
}

/** 3D Tiles 目录的轻量扫描结果 */
export interface HostDirectoryTilesetScan {
  kind: '3dtiles';
  /** tileset.json 相对数据集根的路径 */
  tilesetPath: string;
  /** 数据集根（相对托管根） */
  datasetRoot: string;
  /** tileset.json 的 asset.version */
  assetVersion?: string;
  geometricError?: number;
  /** 顶层 root 的直接子节点数（若有） */
  rootChildren?: number;
  /** 有界统计的条目数 */
  scannedEntries: number;
  truncated: boolean;
  extensions: string[];
}

/** 目录托管扫描结果 */
export type HostDirectoryScan = HostDirectoryXyzScan | HostDirectoryTilesetScan;

/** 托管访问信息（服务端给出的只读访问入口） */
export interface HostDirectoryAccess {
  /** 根相对 URL（XYZ 为含 {z}/{x}/{y} 占位符的模板；3D Tiles 为 tileset.json） */
  url: string;
  kind: 'tiles' | 'tileset';
  /** 服务端说明（未复制/未上传任何文件等） */
  note: string;
}

/** POST /api/services/host-directory 返回 */
export interface HostDirectoryResult {
  /** 服务注册表条目（含 hostDir / hostKind） */
  entry: ServiceEntry;
  scan: HostDirectoryScan;
  access: HostDirectoryAccess;
}

/** POST /api/services/host-directory 请求体 */
export interface HostDirectoryInput {
  /** 本机目录绝对路径（必须落在 GIS_HOST_DIR_ROOTS 白名单内） */
  dir: string;
  kind: HostDirectoryKind;
  /** 自定义 slug（可选；缺省由目录名推导） */
  slug?: string;
  /** 服务显示名（可选；缺省用目录名） */
  title?: string;
}

/** DELETE /api/services/:slug 返回（204 时无响应体） */
export interface DeleteServiceResult {
  slug: string;
  /** 'hosted'：目录托管（只移除映射）；'published'：发布包目录 */
  mode: 'hosted' | 'published';
  /** 是否删除了生成的发布包文件 */
  removedGeneratedFiles: boolean;
  /** mode='hosted' 时的源目录（未被删除/修改） */
  sourceDir?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// 资产上传
// ---------------------------------------------------------------------------

/** POST /api/assets 上传结果 */
export interface AssetUploadResult {
  /** 资产 id（场景图层 source.assetId 引用） */
  assetId: string;
  /** 访问资产的根相对 URL（/assets/<assetId>/<filename>） */
  url: string;
  /** 字节数 */
  size: number;
  /** 保存到服务端的文件名 */
  filename?: string;
  /** MIME 类型 */
  contentType?: string;
}

// ---------------------------------------------------------------------------
// 服务端健康检查
// ---------------------------------------------------------------------------

/** GET /api/health 返回 */
export interface HealthStatus {
  status: string;
  uptime?: number;
  version?: string;
}
