/**
 * editor/core · localCache/generate2d —— 二维矢量（GeoJSON）→ XYZ 瓦片缓存生成
 *
 * 场景：编辑器内把 GeoJSON（Point/MultiPoint/LineString/MultiLineString/
 * Polygon/MultiPolygon + Feature/FeatureCollection）按 Web Mercator XYZ 切片
 * 规则渲染为 PNG 瓦片缓存，与本地 XYZ 缓存导入（xyzCache）形态一致：
 * 预览（LocalXyzImageryProvider）→ 注册图层（LayerManager）
 * → zip 打包（zipCacheBundle）→ 发布（publishScenePackage）。
 *
 * 产物（zip 内相对路径，rootDir 为空即包根）：
 * - `{z}/{x}/{y}.png`：与标准 Web Mercator XYZ 一致（z0 单瓦片、
 *   x 自西向东、y 自北向南），可被 Cesium UrlTemplateImageryProvider 直接使用
 *
 * 设计要点：
 * - 切片换算（lonToTileX / latToTileY / tileXToLon / tileYToLat）为纯函数，
 *   与像素投影 projectLonLatToTilePixel 共用同一套公式，保证瓦片对齐。
 * - 只生成「有内容」的瓦片：先按要素 bbox 与瓦片可见窗口（x ∈ [左边缘, 右边缘)、
 *   y ∈ (南边缘, 北边缘]，与 floor 语义一致）求交预筛，绘制后再检查透明像素
 *   （hasVisibleInk），全透明瓦片不产出文件。
 * - 渲染用浏览器 Canvas：OffscreenCanvas 优先，回退 document.createElement；
 *   画布工厂可注入（单测/无 DOM 环境使用假画布做结构性断言）。
 * - 与发布链路的桥接：GeneratedCache 直接复用 generate3d 导出的
 *   generatedCacheToZipInputs / zipGeneratedCache（按 kind 无关实现）。
 * - 预览桥接 importGeneratedXyzToLayers 与 t12 importGeneratedCacheToLayers
 *   对称；后者已按 kind 分发，UI 可统一从 importGeneratedCacheToLayers 进入。
 *
 * 区域生成（t20）generateXyzFromRegion：输入不是 GeoJSON 而是
 * `{bbox, minZoom, maxZoom, tileSize, source}`，按 source 取数据：
 * - source='basemap'：把 t19 底图注册表当前激活项的 URL 模板 + token 逐瓦片
 *   fetch（CORS）→ drawImage 到画布 → 重编码 PNG（底图瓦片多为 jpg，统一 png
 *   以与既有 XYZ 缓存链路同构）；404/204 与全透明瓦片都按空瓦片剔除，401/403
 *   抛可读的令牌指引；连续失败且无产物时提前中止，避免无网络空转。
 * - source='selectedVector'：复用本模块既有矢量渲染管线（点/线/面 + 样式），
 *   bounds 用调用方给定的 bbox（可小于数据 extent）。
 * 产物与 generateXyzFromGeoJSON 完全同构，因此发布/预览链路零改动。
 *
 * 已知取舍：
 * - 跨 antimeridian（±180°）的线段不拆分重投，直接断开绘制（避免横穿整图）；
 *   跨带多边形不做几何拆分。
 * - 每瓦片对要素做 bbox 预筛（O(瓦片数 × 要素数)），不建空间索引；
 *   编辑器场景数据量下足够，超大粒度数据请控制 maxZoom。
 */
import type { GeoJSONData } from '@geolibre/gis-shared';

import type { LayerManager } from './layer-manager';
import { normalizeRelativePath, parseXyzPath } from './detect';
import type { LocalCacheMetadata } from './types';
import type { GeneratedCache } from './generate-3d';
import { boundsFromTileKeys } from './bounds';
import { LocalXyzImageryProvider } from './xyz-cache';

// ---------------------------------------------------------------------------
// 契约类型（t14 UI 消费；命名与 t12 契约风格一致，不得改名）
// ---------------------------------------------------------------------------

/** 经纬度范围 [minLon, minLat, maxLon, maxLat]（十进制度，WGS84） */
export type GeoBounds = [number, number, number, number];

/** 矢量渲染样式（可选项缺省用 DEFAULT_XYZ_STYLE） */
export interface XyzGenerateStyle {
  /** 点半径（像素，默认 4） */
  pointRadius?: number;
  /** 点填充色（默认 '#ff4d4f'） */
  pointColor?: string;
  /** 线颜色（默认 '#1890ff'；面轮廓同色） */
  lineColor?: string;
  /** 线宽（像素，默认 2；面轮廓同宽） */
  lineWidth?: number;
  /** 面填充色（默认 '#ffb020'） */
  fillColor?: string;
  /** 面填充不透明度 0~1（默认 0.35） */
  fillOpacity?: number;
}

/** XYZ 生成选项 */
export interface XyzGenerateOptions {
  /** 最小缩放级别（含） */
  minZoom: number;
  /** 最大缩放级别（含，≤22） */
  maxZoom: number;
  /** 瓦片边长（像素，默认 256） */
  tileSize?: number;
  /** 生成范围 [minLon, minLat, maxLon, maxLat]，缺省取 GeoJSON extent */
  bounds?: GeoBounds;
  /** 渲染样式 */
  style?: XyzGenerateStyle;
  /** 进度回调（0~1，单调不减） */
  onProgress?: (ratio: number) => void;
  /** 画布工厂（测试/无 DOM 环境注入；缺省 OffscreenCanvas → DOM canvas 回退） */
  canvasFactory?: TileCanvasFactory;
}

// ---------------------------------------------------------------------------
// 区域生成契约类型（t20 UI 消费）：bbox + 数据源（底图影像 / 选中矢量）
// ---------------------------------------------------------------------------

/** 区域生成的数据源类别 */
export type XyzRegionSourceKind = 'basemap' | 'selectedVector';

/**
 * 底图瓦片源（source='basemap'）：来自 t19 底图注册表当前激活项的解析结果。
 * URL 模板必须含 {z}/{x}/{y}；可选 {s}（子域）/ {token}（令牌）由本模块代入。
 */
export interface XyzRegionBasemapSource {
  /** XYZ URL 模板 */
  urlTemplate: string;
  /** 子域列表（模板含 {s} 时按瓦片编号轮转代入；缺省 a/b/c） */
  subdomains?: string[];
  /** 访问令牌（模板含 {token} 时代入） */
  token?: string;
  /** 该底图的最大可用层级（超出部分无瓦片；按此钳制 maxZoom） */
  maximumLevel?: number;
  /** 展示名（诊断/错误文案用） */
  label?: string;
}

/** 可绘制到瓦片画布的图像（默认加载器给出 ImageBitmap / HTMLImageElement） */
export type XyzTileImage = CanvasImageSource;

/** 单张底图瓦片请求 */
export interface XyzTileRequest {
  zoom: number;
  x: number;
  y: number;
  /** 已代入 {z}/{x}/{y}/{s}/{token} 的完整 URL */
  url: string;
}

/** 底图瓦片加载器：返回 undefined 表示该瓦片不存在（按空瓦片跳过，不产出文件） */
export type XyzTileLoader = (request: XyzTileRequest) => Promise<XyzTileImage | undefined>;

/** 区域生成选项（t20 契约；不得改字段名） */
export interface XyzRegionGenerateOptions {
  /** 生成范围 [minLon, minLat, maxLon, maxLat]（必填；候选瓦片按此范围求） */
  bbox: GeoBounds;
  minZoom: number;
  maxZoom: number;
  /** 瓦片边长（像素，默认 256；需与底图瓦片实际边长一致） */
  tileSize?: number;
  /** 数据源：'basemap' 当前底图影像 / 'selectedVector' 选中的矢量数据 */
  source: XyzRegionSourceKind;
  /** source='selectedVector'：矢量数据（GeoJSON 对象或 File） */
  data?: GeoJSONData | File;
  /** source='basemap'：底图瓦片源 */
  basemap?: XyzRegionBasemapSource;
  /** 矢量渲染样式（仅 source='selectedVector'） */
  style?: XyzGenerateStyle;
  /** 底图瓦片加载器（默认 fetch + ImageBitmap；测试 / 自定义鉴权可注入） */
  loadTile?: XyzTileLoader;
  /** 底图拉取并发数（默认 6，钳制到 1~32） */
  concurrency?: number;
  /** 进度回调（0~1，单调不减） */
  onProgress?: (ratio: number) => void;
  /** 画布工厂（测试/无 DOM 环境注入） */
  canvasFactory?: TileCanvasFactory;
}

/** 底图瓦片拉取默认并发 */
export const DEFAULT_TILE_CONCURRENCY = 6;

/** 底图瓦片连续失败上限（全失败且尚无产物时提前中止，避免无网络空转） */
export const BASEMAP_FAILURE_LIMIT = 12;

/**
 * `{z}/{x}/{y}` 模板代入/校验已抽出到 `./tileUrl`（t25：xyzCache 的模板模式复用同一实现，
 * 避免二次实现与循环依赖）。这里 import 供本模块使用，并原样 re-export 保持公开 API 不变。
 */
import { buildXyzTileUrl } from './tile-url';
export { DEFAULT_XYZ_SUBDOMAINS, buildXyzTileUrl } from './tile-url';

// ---------------------------------------------------------------------------
// Web Mercator XYZ 切片换算（纯函数，与像素投影共用公式）
// ---------------------------------------------------------------------------

/** Web Mercator 有效纬度上限（atan(sinh(π))） */
export const MERCATOR_MAX_LAT = 85.0511287798066;

/** 生成允许的最大缩放级别 */
export const MAX_GENERATE_ZOOM = 22;

/** 经度 → 瓦片 x（floor 语义：边界经度归属东侧瓦片）；结果钳制到 [0, 2^z-1] */
export function lonToTileX(lon: number, zoom: number): number {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  return Math.min(n - 1, Math.max(0, x));
}

/** 纬度 → 瓦片 y（floor 语义：边界纬度归属南侧瓦片）；纬度与结果均钳制到有效范围 */
export function latToTileY(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  const clamped = Math.min(MERCATOR_MAX_LAT, Math.max(-MERCATOR_MAX_LAT, lat));
  const latRad = (clamped * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  return Math.min(n - 1, Math.max(0, y));
}

/** 瓦片 x → 西边缘经度 */
export function tileXToLon(x: number, zoom: number): number {
  return (x / 2 ** zoom) * 360 - 180;
}

/** 瓦片 y → 北边缘纬度（南边缘为 tileYToLat(y + 1)） */
export function tileYToLat(y: number, zoom: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** zoom);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** 经纬度 → 瓦片内像素坐标（[0, tileSize) 内表示可见；与切片换算同一公式） */
export function projectLonLatToTilePixel(
  lon: number,
  lat: number,
  zoom: number,
  x: number,
  y: number,
  tileSize: number,
): [number, number] {
  const world = tileSize * 2 ** zoom;
  const px = ((lon + 180) / 360) * world - x * tileSize;
  const clamped = Math.min(MERCATOR_MAX_LAT, Math.max(-MERCATOR_MAX_LAT, lat));
  const latRad = (clamped * Math.PI) / 180;
  const py = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * world - y * tileSize;
  return [px, py];
}

/** 某缩放级别下的候选瓦片范围（含两端） */
export interface TileRange {
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
}

/**
 * extent → 候选瓦片范围（只做范围裁剪，不做要素级判断）。
 *
 * 纬度自动钳制到 Web Mercator 有效范围；extent 与墨卡托世界无交时返回
 * undefined。边界值语义与 floor 切片一致（如 maxLon 恰在瓦片边界时，
 * 该边界瓦片仍入选，空瓦片由后续要素预筛剔除）。
 */
export function tileRangeForExtent(bounds: GeoBounds, zoom: number): TileRange | undefined {
  const [minLon, minLat, maxLon, maxLat] = bounds;
  if (minLon > maxLon || maxLon < -180 || minLon > 180) return undefined;
  const n = 2 ** zoom;
  const south = Math.max(minLat, -MERCATOR_MAX_LAT);
  const north = Math.min(maxLat, MERCATOR_MAX_LAT);
  // 允许退化区间（点数据 north === south），只剔除与世界完全无交的纬度带
  if (north < south) return undefined;
  const clamp = (v: number): number => Math.min(n - 1, Math.max(0, v));
  const minTileX = clamp(lonToTileX(minLon, zoom));
  const maxTileX = clamp(lonToTileX(maxLon, zoom));
  const minTileY = clamp(latToTileY(north, zoom));
  const maxTileY = clamp(latToTileY(south, zoom));
  if (maxTileX < minTileX || maxTileY < minTileY) return undefined;
  return { minTileX, maxTileX, minTileY, maxTileY };
}

// ---------------------------------------------------------------------------
// GeoJSON 归一化
// ---------------------------------------------------------------------------

/** 归一化后的可渲染要素（坐标均为有效的 [lon, lat]） */
export interface VectorFeature {
  kind: 'point' | 'line' | 'polygon';
  /**
   * 环集合：point → 每环一个点；line → 每环一条线；polygon → 外环 + 内环（洞）
   */
  rings: [number, number][][];
  /** 要素 bbox（按有效坐标计算） */
  bbox: GeoBounds;
}

const SUPPORTED_GEOJSON_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'Feature',
  'FeatureCollection',
]);

/** 校验输入为受支持的 GeoJSON（Geometry / Feature / FeatureCollection） */
export function assertSupportedGeoJSON(data: unknown): asserts data is GeoJSONData {
  const type = (data as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !SUPPORTED_GEOJSON_TYPES.has(type)) {
    throw new Error(
      `数据类型不受支持：${String(type)}（应为 GeoJSON Point/MultiPoint/LineString/` +
        'MultiLineString/Polygon/MultiPolygon/Feature/FeatureCollection）',
    );
  }
}

/** GeoJSON → 全部要素 bbox（无任何有效坐标时返回 undefined） */
export function geojsonExtent(data: GeoJSONData): GeoBounds | undefined {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const feature of normalizeGeoJSONFeatures(data)) {
    const [fMinLon, fMinLat, fMaxLon, fMaxLat] = feature.bbox;
    minLon = Math.min(minLon, fMinLon);
    minLat = Math.min(minLat, fMinLat);
    maxLon = Math.max(maxLon, fMaxLon);
    maxLat = Math.max(maxLat, fMaxLat);
    found = true;
  }
  return found ? [minLon, minLat, maxLon, maxLat] : undefined;
}

/**
 * GeoJSON → 扁平可渲染要素列表。
 *
 * 无效坐标（非有限值）被跳过；退化环（点环 0 点、线环 <2 点、面环 <3 点）
 * 被丢弃；geometry 为 null 的 Feature 忽略。要素数无硬上限。
 */
export function normalizeGeoJSONFeatures(data: GeoJSONData): VectorFeature[] {
  const geometries: Exclude<GeoJSONData, { type: 'Feature' | 'FeatureCollection' }>[] = [];
  if (data.type === 'FeatureCollection') {
    for (const feature of data.features) {
      if (feature.geometry) geometries.push(feature.geometry);
    }
  } else if (data.type === 'Feature') {
    if (data.geometry) geometries.push(data.geometry);
  } else {
    geometries.push(data);
  }

  const out: VectorFeature[] = [];
  for (const geometry of geometries) {
    const kind = geometryKind(geometry.type);
    if (!kind) continue;
    const rings = geometryRings(geometry, kind);
    if (rings.length === 0) continue;
    out.push({ kind, rings, bbox: ringsBbox(rings) });
  }
  return out;
}

function geometryKind(type: string): VectorFeature['kind'] | undefined {
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  if (type === 'LineString' || type === 'MultiLineString') return 'line';
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon';
  return undefined;
}

/** 位置有效性：有限值且两维齐备 */
function validPosition(p: unknown): [number, number] | undefined {
  if (!Array.isArray(p) || p.length < 2) return undefined;
  const lon = Number(p[0]);
  const lat = Number(p[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  return [lon, lat];
}

/** 按要素类型抽环：point 每环 1 点、line 每环 ≥2 点、polygon 每环 ≥3 点 */
function geometryRings(
  geometry: Exclude<GeoJSONData, { type: 'Feature' | 'FeatureCollection' }>,
  kind: VectorFeature['kind'],
): [number, number][][] {
  const coords = (geometry as { coordinates: unknown }).coordinates;
  const minLen = kind === 'point' ? 1 : kind === 'line' ? 2 : 3;
  if (kind === 'point') {
    if (geometry.type === 'Point') {
      const v = validPosition(coords);
      return v ? [[v]] : [];
    }
    // MultiPoint：每个点独立成环
    const rings: [number, number][][] = [];
    for (const p of coords as unknown[]) {
      const v = validPosition(p);
      if (v) rings.push([v]);
    }
    return rings;
  }
  // 统一为「环数组」：LineString → [ring]；MultiLineString / Polygon → rings；
  // MultiPolygon → 展平为 rings（外环与洞一视同仁，evenodd 填充处理洞）
  const ringSources: unknown[][] =
    geometry.type === 'LineString'
      ? [coords as unknown[]]
      : geometry.type === 'MultiLineString' || geometry.type === 'Polygon'
        ? (coords as unknown[][])
        : (coords as unknown[][][]).flat();
  const rings: [number, number][][] = [];
  for (const ringSource of ringSources) {
    if (!Array.isArray(ringSource)) continue;
    const ring: [number, number][] = [];
    for (const p of ringSource) {
      const v = validPosition(p);
      if (v) ring.push(v);
    }
    if (ring.length >= minLen) rings.push(ring);
  }
  return rings;
}

/** 环集合 → bbox */
function ringsBbox(rings: [number, number][][]): GeoBounds {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

// ---------------------------------------------------------------------------
// Canvas 抽象（OffscreenCanvas 优先，DOM canvas 回退；可注入假画布）
// ---------------------------------------------------------------------------

/** 2D 绘图上下文（DOM / Offscreen 兼容） */
export type TileContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** 生成用画布抽象（屏蔽 OffscreenCanvas 与 DOM canvas 的 Blob 导出差异） */
export interface TileCanvas {
  readonly context: TileContext2D;
  /** 导出为 PNG Blob */
  toPngBlob(): Promise<Blob>;
}

export type TileCanvasFactory = (width: number, height: number) => TileCanvas;

/** 默认画布工厂：OffscreenCanvas 优先，回退 document.createElement('canvas') */
export function createTileCanvas(width: number, height: number): TileCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 OffscreenCanvas 2D 上下文');
    return {
      context,
      toPngBlob: () => canvas.convertToBlob({ type: 'image/png' }),
    };
  }
  if (typeof document === 'undefined') {
    throw new Error('当前环境不支持 Canvas 渲染（缺少 OffscreenCanvas 与 document）');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建 Canvas 2D 上下文');
  return {
    context,
    toPngBlob: () =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob 返回空 Blob'))),
          'image/png',
        );
      }),
  };
}

/** 默认渲染样式 */
export const DEFAULT_XYZ_STYLE: Required<XyzGenerateStyle> = {
  pointRadius: 4,
  pointColor: '#ff4d4f',
  lineColor: '#1890ff',
  lineWidth: 2,
  fillColor: '#ffb020',
  fillOpacity: 0.35,
};

/**
 * 把要素绘制到瓦片上下文（像素坐标经 projectLonLatToTilePixel 投影）。
 *
 * - 点：按 pointRadius/pointColor 填充圆
 * - 线：按 lineColor/lineWidth 描边（跨 ±180° 的线段断开，不横穿瓦片）
 * - 面：fillColor+fillOpacity 按 evenodd 填充（支持洞），再按线样式描边
 *
 * 超出瓦片可见范围的坐标交给画布裁剪；调用方负责先做 bbox 预筛。
 */
export function drawFeaturesOnTileContext(
  context: TileContext2D,
  features: VectorFeature[],
  tile: { zoom: number; x: number; y: number },
  tileSize: number,
  style: XyzGenerateStyle = {},
): void {
  const resolved: Required<XyzGenerateStyle> = { ...DEFAULT_XYZ_STYLE, ...style };
  const world = tileSize * 2 ** tile.zoom;
  context.lineJoin = 'round';
  context.lineCap = 'round';

  for (const feature of features) {
    if (feature.kind === 'point') {
      context.fillStyle = resolved.pointColor;
      for (const ring of feature.rings) {
        const [lon, lat] = ring[0]!;
        const [px, py] = projectLonLatToTilePixel(lon, lat, tile.zoom, tile.x, tile.y, tileSize);
        context.beginPath();
        context.arc(px, py, resolved.pointRadius, 0, Math.PI * 2);
        context.fill();
      }
      continue;
    }
    context.beginPath();
    for (const ring of feature.rings) {
      appendRingPath(context, ring, tile, tileSize, world, feature.kind === 'polygon');
    }
    if (feature.kind === 'polygon') {
      context.globalAlpha = resolved.fillOpacity;
      context.fillStyle = resolved.fillColor;
      context.fill('evenodd');
      context.globalAlpha = 1;
    }
    context.strokeStyle = resolved.lineColor;
    context.lineWidth = resolved.lineWidth;
    context.stroke();
  }
}

/** 追加一条环到当前路径；跨 ±180° 断开为 moveTo；polygon 环自动 closePath */
function appendRingPath(
  context: TileContext2D,
  ring: [number, number][],
  tile: { zoom: number; x: number; y: number },
  tileSize: number,
  world: number,
  close: boolean,
): void {
  let prevPx = Number.NaN;
  for (let i = 0; i < ring.length; i++) {
    const [lon, lat] = ring[i]!;
    const [px, py] = projectLonLatToTilePixel(lon, lat, tile.zoom, tile.x, tile.y, tileSize);
    const jump = i > 0 && Math.abs(px - prevPx) > world / 2;
    if (i === 0 || jump) context.moveTo(px, py);
    else context.lineTo(px, py);
    prevPx = px;
  }
  if (close) context.closePath();
}

/**
 * 瓦片是否有任何非透明像素（「空瓦片不产出文件」的精确判定）。
 *
 * 上下文不支持 getImageData 或读取异常时保守返回 true（保留瓦片，
 * 退化为仅 bbox 预筛的语义）。
 */
export function hasVisibleInk(context: TileContext2D, width: number, height: number): boolean {
  try {
    if (typeof context.getImageData !== 'function') return true;
    const data = context.getImageData(0, 0, width, height).data;
    for (let i = 3; i < data.length; i += 4) {
      if ((data[i] ?? 0) > 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// 生成入口（契约 API）
// ---------------------------------------------------------------------------

/** 校验缩放级别区间（0~MAX_GENERATE_ZOOM 的整数，min ≤ max） */
function assertZoomRange(minZoom: number, maxZoom: number): void {
  if (
    !Number.isInteger(minZoom) ||
    !Number.isInteger(maxZoom) ||
    minZoom < 0 ||
    maxZoom < minZoom ||
    maxZoom > MAX_GENERATE_ZOOM
  ) {
    throw new Error(
      `缩放级别非法：minZoom/maxZoom 应为 0~${MAX_GENERATE_ZOOM} 的整数且 minZoom ≤ maxZoom` +
        `（实际 ${minZoom}~${maxZoom}）`,
    );
  }
}

/** 校验瓦片边长（1~4096 的整数） */
function assertTileSize(tileSize: number): void {
  if (!Number.isInteger(tileSize) || tileSize < 1 || tileSize > 4096) {
    throw new Error(`瓦片边长非法：应为 1~4096 的整数（实际 ${tileSize}）`);
  }
}

/** 校验生成范围（有限值 + 顺序 + 经纬度有效区间） */
function assertBounds(bounds: GeoBounds): void {
  const [minLon, minLat, maxLon, maxLat] = bounds;
  if (
    ![minLon, minLat, maxLon, maxLat].every((v) => Number.isFinite(v)) ||
    minLon > maxLon ||
    minLat > maxLat ||
    minLon < -180 ||
    maxLon > 180 ||
    minLat < -90 ||
    maxLat > 90
  ) {
    throw new Error(
      `bounds 非法：应为 [-180~180, -90~90] 内的 [minLon, minLat, maxLon, maxLat]` +
        `（实际 ${JSON.stringify(bounds)}）`,
    );
  }
}

/** 逐层求候选瓦片范围；与 Web Mercator 世界无交时抛可读错误 */
function collectZoomRanges(
  bounds: GeoBounds,
  minZoom: number,
  maxZoom: number,
): Array<{ zoom: number; range: TileRange }> {
  const perZoom: Array<{ zoom: number; range: TileRange }> = [];
  for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
    const range = tileRangeForExtent(bounds, zoom);
    if (!range) continue;
    perZoom.push({ zoom, range });
  }
  const total = perZoom.reduce(
    (sum, item) => sum + (item.range.maxTileX - item.range.minTileX + 1) * (item.range.maxTileY - item.range.minTileY + 1),
    0,
  );
  if (perZoom.length === 0 || total === 0) {
    throw new Error('生成范围与 Web Mercator 世界无交集，未产生任何候选瓦片');
  }
  return perZoom;
}

/** 候选瓦片总数（与 collectZoomRanges 同口径） */
function countCandidates(perZoom: ReadonlyArray<{ range: TileRange }>): number {
  return perZoom.reduce(
    (sum, item) => sum + (item.range.maxTileX - item.range.minTileX + 1) * (item.range.maxTileY - item.range.minTileY + 1),
    0,
  );
}

/** 生成文件条目（与 generate3d 的 GeneratedCacheFile 结构一致） */
interface GeneratedCacheFileLite {
  path: string;
  blob: Blob;
}

/**
 * 产物收尾：文件清单 → GeneratedCache（kind='xyz'，entry=''，cacheSource='generated'）。
 * 无任何文件时抛可读错误。
 */
function finalizeXyzCache(files: GeneratedCacheFileLite[], statsMaxZoom: number): GeneratedCache {
  if (files.length === 0) {
    throw new Error(
      '未生成任何 XYZ 瓦片：所有候选瓦片均无有效渲染内容（请检查数据与 bounds/maxZoom 是否匹配）',
    );
  }
  const totalBytes = files.reduce((sum, f) => sum + f.blob.size, 0);
  const metadata: LocalCacheMetadata = {
    cacheKind: 'xyz',
    files: files.map((f) => ({ path: f.path, size: f.blob.size })),
    totalBytes,
    rootDir: '',
    cacheSource: 'generated',
    detection: {
      xyzTemplate: '{z}/{x}/{y}.png',
      xyzExt: 'png',
      maxLevel: statsMaxZoom,
      tileCount: files.length,
    },
  };

  return {
    kind: 'xyz',
    files,
    entry: '',
    metadata,
    stats: {
      fileCount: files.length,
      totalBytes,
      maxZoom: statsMaxZoom,
    },
  };
}

/**
 * GeoJSON → XYZ 瓦片缓存（Web Mercator PNG）。
 *
 * @param data GeoJSON 数据对象或 .geojson/.json File
 * @param options minZoom/maxZoom 必填；tileSize/bounds/style/onProgress 可选
 * @returns kind='xyz' 的 GeneratedCache（entry=''，可直接交给
 *          importGeneratedCacheToLayers 预览或 zipGeneratedCache 打包）
 */
export async function generateXyzFromGeoJSON(
  data: GeoJSONData | File,
  options: XyzGenerateOptions,
): Promise<GeneratedCache> {
  const report = createProgressReporter(options.onProgress);
  report(0);

  const minZoom = options.minZoom;
  const maxZoom = options.maxZoom;
  assertZoomRange(minZoom, maxZoom);
  const tileSize = options.tileSize ?? 256;
  assertTileSize(tileSize);

  const geojson = await toGeoJSONData(data);
  assertSupportedGeoJSON(geojson);
  const features = normalizeGeoJSONFeatures(geojson);
  if (features.length === 0) {
    throw new Error('数据不含任何有效几何要素，无法生成瓦片');
  }

  const bounds = options.bounds ?? geojsonExtent(geojson);
  if (!bounds) throw new Error('无法确定生成范围：数据无有效坐标且未提供 bounds');
  assertBounds(bounds);
  report(0.02);

  // 逐层求候选瓦片范围（要素级内容判断延后到逐瓦片预筛）
  const perZoom = collectZoomRanges(bounds, minZoom, maxZoom);
  const totalCandidates = countCandidates(perZoom);

  const style = options.style ?? {};
  const canvasFactory = options.canvasFactory ?? createTileCanvas;
  const files: GeneratedCacheFileLite[] = [];
  let statsMaxZoom = minZoom;
  let processed = 0;

  for (const { zoom, range } of perZoom) {
    for (let x = range.minTileX; x <= range.maxTileX; x++) {
      for (let y = range.minTileY; y <= range.maxTileY; y++) {
        processed += 1;
        const hits = features.filter((f) => bboxHitsTile(f.bbox, zoom, x, y));
        if (hits.length === 0) {
          report(processed / totalCandidates);
          continue;
        }
        const canvas = canvasFactory(tileSize, tileSize);
        drawFeaturesOnTileContext(canvas.context, hits, { zoom, x, y }, tileSize, style);
        if (!hasVisibleInk(canvas.context, tileSize, tileSize)) {
          report(processed / totalCandidates);
          continue;
        }
        const blob = await canvas.toPngBlob();
        files.push({ path: `${zoom}/${x}/${y}.png`, blob });
        statsMaxZoom = Math.max(statsMaxZoom, zoom);
        report(processed / totalCandidates);
      }
    }
  }

  const result = finalizeXyzCache(files, statsMaxZoom);
  report(1);
  return result;
}

/** 要素 bbox 是否与瓦片可见窗口有交（x ∈ [左, 右)、y ∈ (南, 北]，与 floor 切片一致） */
function bboxHitsTile(bbox: GeoBounds, zoom: number, x: number, y: number): boolean {
  const lonLeft = tileXToLon(x, zoom);
  const lonRight = tileXToLon(x + 1, zoom);
  const latNorth = tileYToLat(y, zoom);
  const latSouth = tileYToLat(y + 1, zoom);
  const [fMinLon, fMinLat, fMaxLon, fMaxLat] = bbox;
  return (
    fMaxLon >= lonLeft &&
    fMinLon < lonRight &&
    fMaxLat > latSouth &&
    fMinLat <= latNorth
  );
}

/** File → 解析后的 GeoJSON 对象（对象输入原样返回） */
async function toGeoJSONData(data: GeoJSONData | File): Promise<GeoJSONData> {
  if (!(data instanceof File)) return data;
  const text = await data.text();
  try {
    return JSON.parse(text) as GeoJSONData;
  } catch {
    throw new Error(`GeoJSON 文件解析失败（非合法 JSON）：${data.name}`);
  }
}

/** 单调不减的进度上报（夹紧到 0~1，异常不打断主流程） */
function createProgressReporter(onProgress?: (ratio: number) => void): (ratio: number) => void {
  let last = 0;
  return (ratio: number) => {
    const clamped = Math.min(1, Math.max(last, Number.isFinite(ratio) ? ratio : last));
    last = clamped;
    if (!onProgress) return;
    try {
      onProgress(clamped);
    } catch {
      // 进度回调异常不影响生成
    }
  };
}

// ---------------------------------------------------------------------------
// 区域生成（t20）：bbox + 数据源（底图影像 / 选中矢量）→ XYZ 缓存
// ---------------------------------------------------------------------------

/** 把瓦片图像铺满瓦片画布（尺寸不一致时缩放；底图瓦片通常与 tileSize 一致） */
function drawTileImage(context: TileContext2D, image: XyzTileImage, tileSize: number): void {
  // 联合类型（DOM / Offscreen）的两个 drawImage 签名一致，这里按 DOM 上下文调用即可
  (context as CanvasRenderingContext2D).drawImage(image, 0, 0, tileSize, tileSize);
}

/** createImageBitmap 不可用或失败时，用 HTMLImageElement + object URL 解码 */
async function decodeTileWithImageElement(blob: Blob, url: string): Promise<XyzTileImage> {
  if (typeof Image === 'undefined') {
    throw new Error(`无法解码底图瓦片（当前环境缺少 ImageBitmap 与 Image）：${url}`);
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`底图瓦片解码失败（可能不是有效图片）：${url}`));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * 默认底图瓦片加载器：fetch（CORS）→ ImageBitmap（回退 HTMLImageElement）。
 *
 * 已知取舍：
 * - 必须走 CORS 拉取（底图服务需返回 Access-Control-Allow-Origin），否则画布会被
 *   跨域污染、无法 toBlob 导出；跨域被拒时抛可读错误，而不是静默产出空缓存。
 * - 404 / 204 视为「该瓦片不存在」→ 返回 undefined（按空瓦片剔除）。
 * - 401 / 403 抛错并提示检查令牌（天地图 Key / Cesium ion Token）。
 */
export async function loadTileViaFetch(request: XyzTileRequest): Promise<XyzTileImage | undefined> {
  let response: Response;
  try {
    response = await fetch(request.url, { credentials: 'omit' });
  } catch (err) {
    throw new Error(
      `底图瓦片拉取失败（网络不可达或被跨域策略拒绝）：${request.url}` +
        `（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  if (response.status === 404 || response.status === 204) return undefined;
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `底图服务拒绝访问（HTTP ${response.status}）：请检查底图访问令牌（天地图 Key / Cesium ion Token）` +
          `是否有效：${request.url}`,
      );
    }
    throw new Error(`底图瓦片请求失败（HTTP ${response.status}）：${request.url}`);
  }
  const blob = await response.blob();
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      // 回退 <img> 解码
    }
  }
  return decodeTileWithImageElement(blob, request.url);
}

/** 底图瓦片失败汇总文案（保留首个错误的可读原因） */
function basemapFailureError(firstError: Error, failures: number, total: number): Error {
  return new Error(`${firstError.message}（底图瓦片失败 ${failures}/${total} 张，未产出任何缓存文件）`);
}

/**
 * 区域（bbox）+ 数据源 → XYZ 瓦片缓存（t20）。
 *
 * 产物与 generateXyzFromGeoJSON 完全同构（kind='xyz'、`{z}/{x}/{y}.png`、
 * cacheSource='generated'），可直接 importGeneratedCacheToLayers 预览、
 * zipGeneratedCache 打包、publishScenePackage 发布；区别只在「数据从哪来」：
 * - source='basemap'：按 basemap 给出的 URL 模板逐瓦片拉取影像并重编码 PNG
 *   （并发受 concurrency 控制，默认 6）；瓦片缺失（loader → undefined）与全透明
 *   瓦片都按空瓦片剔除；连续失败且无任何产物时提前中止并抛可读错误。
 * - source='selectedVector'：复用既有矢量渲染管线（点/线/面 + 样式），
 *   bounds 用调用方给定的 bbox（可小于数据 extent，只产出覆盖 bbox 的瓦片）。
 *
 * 缺失数据源/非法输入一律抛可读错误（UI 直接展示）。
 */
export async function generateXyzFromRegion(
  options: XyzRegionGenerateOptions,
): Promise<GeneratedCache> {
  const report = createProgressReporter(options.onProgress);
  report(0);

  assertZoomRange(options.minZoom, options.maxZoom);
  assertBounds(options.bbox);
  const tileSize = options.tileSize ?? 256;
  assertTileSize(tileSize);

  const canvasFactory = options.canvasFactory ?? createTileCanvas;
  const files: GeneratedCacheFileLite[] = [];
  let statsMaxZoom = options.minZoom;

  // -------------------------------------------------------------------------
  // 数据源：选中的矢量数据（复用矢量渲染管线，bbox 用给定值）
  // -------------------------------------------------------------------------
  if (options.source === 'selectedVector') {
    if (!options.data) {
      throw new Error(
        '矢量数据源缺失：请选择一个含内嵌 GeoJSON 的矢量图层（或 GeoJSON 文件）作为数据源后重试',
      );
    }
    const geojson = await toGeoJSONData(options.data);
    assertSupportedGeoJSON(geojson);
    const features = normalizeGeoJSONFeatures(geojson);
    if (features.length === 0) {
      throw new Error('数据不含任何有效几何要素，无法生成瓦片');
    }
    report(0.02);

    const perZoom = collectZoomRanges(options.bbox, options.minZoom, options.maxZoom);
    const totalCandidates = countCandidates(perZoom);
    const style = options.style ?? {};
    let processed = 0;

    for (const { zoom, range } of perZoom) {
      for (let x = range.minTileX; x <= range.maxTileX; x++) {
        for (let y = range.minTileY; y <= range.maxTileY; y++) {
          processed += 1;
          const hits = features.filter((f) => bboxHitsTile(f.bbox, zoom, x, y));
          if (hits.length === 0) {
            report(processed / totalCandidates);
            continue;
          }
          const canvas = canvasFactory(tileSize, tileSize);
          drawFeaturesOnTileContext(canvas.context, hits, { zoom, x, y }, tileSize, style);
          if (!hasVisibleInk(canvas.context, tileSize, tileSize)) {
            report(processed / totalCandidates);
            continue;
          }
          files.push({ path: `${zoom}/${x}/${y}.png`, blob: await canvas.toPngBlob() });
          statsMaxZoom = Math.max(statsMaxZoom, zoom);
          report(processed / totalCandidates);
        }
      }
    }

    const result = finalizeXyzCache(files, statsMaxZoom);
    report(1);
    return result;
  }

  // -------------------------------------------------------------------------
  // 数据源：当前激活底图的影像瓦片（t19 底图注册表解析结果）
  // -------------------------------------------------------------------------
  const spec = options.basemap;
  if (!spec || typeof spec.urlTemplate !== 'string' || !spec.urlTemplate.trim()) {
    throw new Error(
      '底图数据源缺失：请先在「视图 → 底图管理…」中选择一个 URL 模板底图（如 OSM / ArcGIS 影像 / 天地图）后重试',
    );
  }
  const urlTemplate = spec.urlTemplate.trim();
  if (!/\{z\}/.test(urlTemplate) || !/\{x\}/.test(urlTemplate) || !/\{y\}/.test(urlTemplate)) {
    throw new Error(
      `底图 URL 模板非法：必须包含 {z}/{x}/{y} 占位符（实际「${urlTemplate}」）`,
    );
  }
  const label = spec.label ?? '当前底图';
  let maxZoom = options.maxZoom;
  if (spec.maximumLevel !== undefined && Number.isFinite(spec.maximumLevel)) {
    maxZoom = Math.min(maxZoom, spec.maximumLevel);
  }
  if (maxZoom < options.minZoom) {
    throw new Error(
      `底图「${label}」的最大层级为 z${spec.maximumLevel}，低于所选 minZoom z${options.minZoom}：` +
        '请降低最小缩放级别或更换底图',
    );
  }

  const loader = options.loadTile ?? loadTileViaFetch;
  const perZoom = collectZoomRanges(options.bbox, options.minZoom, maxZoom);
  const tasks: Array<{ zoom: number; x: number; y: number }> = [];
  for (const { zoom, range } of perZoom) {
    for (let x = range.minTileX; x <= range.maxTileX; x++) {
      for (let y = range.minTileY; y <= range.maxTileY; y++) {
        tasks.push({ zoom, x, y });
      }
    }
  }
  report(0.02);

  const concurrency = Number.isFinite(options.concurrency)
    ? Math.min(32, Math.max(1, Math.floor(options.concurrency as number)))
    : DEFAULT_TILE_CONCURRENCY;
  // 按下标写入，保证产物顺序与候选瓦片枚举顺序一致（并发不引入不确定性）
  const produced: Array<GeneratedCacheFileLite | undefined> = new Array(tasks.length);
  let cursor = 0;
  let done = 0;
  let failures = 0;
  let producedCount = 0;
  let firstError: Error | undefined;
  let stop = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop) return;
      const index = cursor++;
      if (index >= tasks.length) return;
      const tile = tasks[index]!;
      try {
        const url = buildXyzTileUrl(urlTemplate, tile, spec.subdomains, spec.token);
        const image = await loader({ zoom: tile.zoom, x: tile.x, y: tile.y, url });
        if (image) {
          const canvas = canvasFactory(tileSize, tileSize);
          drawTileImage(canvas.context, image, tileSize);
          if (hasVisibleInk(canvas.context, tileSize, tileSize)) {
            produced[index] = {
              path: `${tile.zoom}/${tile.x}/${tile.y}.png`,
              blob: await canvas.toPngBlob(),
            };
            producedCount += 1;
          }
        }
      } catch (err) {
        failures += 1;
        if (!firstError) firstError = err instanceof Error ? err : new Error(String(err));
        if (failures >= BASEMAP_FAILURE_LIMIT && producedCount === 0) stop = true;
      } finally {
        done += 1;
        report(done / tasks.length);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );

  if (stop && firstError) throw basemapFailureError(firstError, failures, tasks.length);
  for (const item of produced) {
    if (!item) continue;
    files.push(item);
    const level = Number(item.path.split('/')[0]);
    if (Number.isFinite(level)) statsMaxZoom = Math.max(statsMaxZoom, level);
  }
  if (files.length === 0 && firstError) {
    throw basemapFailureError(firstError, failures, tasks.length);
  }
  if (files.length === 0) {
    throw new Error(
      `未生成任何 XYZ 瓦片：底图「${label}」在所选范围/层级内没有可用影像` +
        '（请检查底图最大层级、生成范围与网络连通性）',
    );
  }

  const result = finalizeXyzCache(files, statsMaxZoom);
  report(1);
  return result;
}

// ---------------------------------------------------------------------------
// 预览桥接（与 t12 importGeneratedCacheToLayers 对称；后者按 kind 分发到此）
// ---------------------------------------------------------------------------

/** 已注册生成 XYZ 图层的 blob URL 表（供释放） */
const generatedXyzLayerUrlMaps = new Map<string, Map<string, string>>();

/**
 * 把生成的 XYZ 缓存注册为可预览的影像图层。
 *
 * 复用 xyzCache 的 LocalXyzImageryProvider（blob URL 映射 + 缺失瓦片回退
 * 透明 PNG），metadata 原样写入 LayerSource.metadata（含 cacheSource:'generated'）。
 *
 * @returns 图层 id
 */
export async function importGeneratedXyzToLayers(
  cache: GeneratedCache,
  layers: LayerManager,
  options: { name?: string } = {},
): Promise<string> {
  if (cache.kind !== 'xyz') {
    throw new Error(`importGeneratedXyzToLayers 仅支持 xyz 缓存（实际 kind：${cache.kind}）`);
  }
  const tiles = new Map<string, string>();
  let minLevel = Number.POSITIVE_INFINITY;
  let maxLevel = 0;
  for (const file of cache.files) {
    const info = parseXyzPath(normalizeRelativePath(file.path));
    if (!info) continue;
    const key = `${info.level}/${info.x}/${info.y}`;
    if (tiles.has(key)) continue;
    tiles.set(key, URL.createObjectURL(file.blob));
    if (info.level < minLevel) minLevel = info.level;
    if (info.level > maxLevel) maxLevel = info.level;
  }
  if (tiles.size === 0) {
    throw new Error('生成缓存不含任何可识别的 XYZ 瓦片（应为 {z}/{x}/{y}.png 路径）');
  }

  // t30：范围确定（瓦片键推算，生成缓存缺省 web-mercator + 非 TMS），写入 metadata 并传给
  // provider.rectangle —— 生成完成后 zoomTo 能直接飞到数据范围。
  const tilingMode = cache.metadata.tilingMode ?? 'web-mercator';
  const tms = cache.metadata.tms === true;
  const bounds =
    cache.metadata.bounds ?? boundsFromTileKeys(tiles.keys(), { tilingMode, tms });
  const metadata: LocalCacheMetadata = {
    ...cache.metadata,
    tilingMode,
    tms,
    ...(bounds ? { bounds: [...bounds] as [number, number, number, number] } : {}),
  };

  const provider = new LocalXyzImageryProvider({
    tiles,
    minLevel,
    maxLevel,
    tilingMode,
    tms,
    ...(bounds ? { bounds } : {}),
  });
  const name = options.name ?? '生成的 XYZ 瓦片缓存';
  const layer = layers.addImageryLayerInstance(
    name,
    provider,
    {
      url: cache.metadata.detection?.xyzTemplate ?? '{z}/{x}/{y}.png',
      filename: name,
      metadata: metadata as unknown as Record<string, unknown>,
    },
    { maximumLevel: maxLevel },
  );
  generatedXyzLayerUrlMaps.set(layer.id, tiles);
  return layer.id;
}

/** 释放某个生成 XYZ 图层持有的 blob URL（图层移除后调用，避免内存泄漏） */
export function revokeGeneratedXyzLayerUrls(layerId: string): void {
  const urlMap = generatedXyzLayerUrlMaps.get(layerId);
  if (!urlMap) return;
  for (const url of urlMap.values()) URL.revokeObjectURL(url);
  generatedXyzLayerUrlMaps.delete(layerId);
}
