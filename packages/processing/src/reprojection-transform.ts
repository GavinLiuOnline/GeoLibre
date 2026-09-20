/**
 * editor/core · reprojection/transform —— GeoJSON 坐标配准（proj4js）
 *
 * - transformGeoJSON：批量递归转换 GeoJSON 全部坐标位（支持内置 EPSG 或自定义 proj4 定义）
 * - sampleTransform：给定若干源坐标返回转换前后对照（供 UI 预览配准效果）
 * - applySevenParameter：可选七参数布尔莎模型（作用于源坐标，经 ECEF 中转）
 *
 * 约定：
 * - 七参数单位：dx/dy/dz 米；rx/ry/rz 角秒（arc-seconds）；scale 百万分之一（ppm）
 * - 旋转采用布尔莎/坐标框架约定：
 *     X' = dx + (1+m)(X - εz·Y + εy·Z)
 *     Y' = dy + (1+m)(εz·X + Y - εx·Z)
 *     Z' = dz + (1+m)(-εy·X + εx·Y + Z)
 * - Cesium 使用 WGS84，默认目标为 EPSG:4326；keepHeight 默认 true（第三维高度原样传递）
 */
import proj4 from 'proj4';
import type { GeoJSONData, GeoJSONPosition } from '@geolibre/gis-shared';

import { mapGeoJSONCoordinates } from './geojson-utils';
import { resolveCrs } from './reprojection-crs';

// ---------------------------------------------------------------------------
// 七参数（布尔莎模型）
// ---------------------------------------------------------------------------

/** 七参数：平移（米）+ 旋转（角秒）+ 尺度（ppm）；缺省为 0（恒等） */
export interface SevenParameter {
  dx?: number;
  dy?: number;
  dz?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  scale?: number;
}

/** WGS84 椭球常数（七参数 ECEF 中转使用） */
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** 角秒 → 弧度 */
const ARCSEC_TO_RAD = Math.PI / (180 * 3600);

/** 经纬高（度/米）→ 地心直角坐标 ECEF（米） */
export function lonLatHeightToEcef(lonDeg: number, latDeg: number, height: number): [number, number, number] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (n + height) * Math.cos(lat) * Math.cos(lon),
    (n + height) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - WGS84_E2) + height) * sinLat,
  ];
}

/** 地心直角坐标 ECEF（米）→ 经纬高（度/米），迭代收敛纬度 */
export function ecefToLonLatHeight(x: number, y: number, z: number): [number, number, number] {
  const p = Math.hypot(x, y);
  if (p === 0) {
    // 极轴点：经度取 0，纬度由 z 符号决定
    const lat = Math.atan2(z, 0);
    return [0, (lat * 180) / Math.PI, Math.abs(z) - WGS84_A * (1 - WGS84_F)];
  }
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  let n = WGS84_A;
  for (let i = 0; i < 5; i++) {
    const sinLat = Math.sin(lat);
    n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    lat = Math.atan2(z, p - WGS84_E2 * n * Math.cos(lat));
  }
  const height = p / Math.cos(lat) - n;
  const lon = Math.atan2(y, x);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI, height];
}

/**
 * 对单个经纬高坐标应用七参数（布尔莎模型，经 ECEF 中转）。
 * 返回新坐标，不修改输入。
 */
export function applySevenParameter(position: GeoJSONPosition, params: SevenParameter): GeoJSONPosition {
  const [lon, lat, height = 0] = position;
  if (!hasSevenParameter(params)) return [...position] as GeoJSONPosition;

  const [x, y, z] = lonLatHeightToEcef(lon, lat, height);
  const m = (params.scale ?? 0) * 1e-6;
  const ex = (params.rx ?? 0) * ARCSEC_TO_RAD;
  const ey = (params.ry ?? 0) * ARCSEC_TO_RAD;
  const ez = (params.rz ?? 0) * ARCSEC_TO_RAD;

  const x2 = (params.dx ?? 0) + (1 + m) * (x - ez * y + ey * z);
  const y2 = (params.dy ?? 0) + (1 + m) * (ez * x + y - ex * z);
  const z2 = (params.dz ?? 0) + (1 + m) * (-ey * x + ex * y + z);

  const [lon2, lat2, h2] = ecefToLonLatHeight(x2, y2, z2);
  const result: GeoJSONPosition = position.length >= 3 ? [lon2, lat2, h2] : [lon2, lat2];
  return result;
}

/** 是否设置了任何非零七参数 */
export function hasSevenParameter(params: SevenParameter | undefined): boolean {
  if (!params) return false;
  return (
    (params.dx ?? 0) !== 0 ||
    (params.dy ?? 0) !== 0 ||
    (params.dz ?? 0) !== 0 ||
    (params.rx ?? 0) !== 0 ||
    (params.ry ?? 0) !== 0 ||
    (params.rz ?? 0) !== 0 ||
    (params.scale ?? 0) !== 0
  );
}

// ---------------------------------------------------------------------------
// 坐标转换
// ---------------------------------------------------------------------------

export interface TransformOptions {
  /** 可选七参数（布尔莎模型），作用于**源坐标**（投影转换之前） */
  seven?: SevenParameter;
  /** 保持第三维高度原样传递（默认 true）；false 时把第三维交给 proj4 处理（仅少数投影有意义） */
  keepHeight?: boolean;
}

function createConverter(fromDef: string, toDef: string): proj4.Converter {
  const from = resolveCrs(fromDef);
  const to = resolveCrs(toDef);
  return proj4(from.def, to.def);
}

/** 转换单个坐标位（不修改输入） */
export function transformPosition(
  position: GeoJSONPosition,
  fromDef: string,
  toDef: string,
  options: TransformOptions = {},
): GeoJSONPosition {
  const converter = createConverter(fromDef, toDef);
  return convertPosition(position, converter, options);
}

function convertPosition(
  position: GeoJSONPosition,
  converter: proj4.Converter,
  options: TransformOptions,
): GeoJSONPosition {
  let source: GeoJSONPosition = position;
  if (options.seven && hasSevenParameter(options.seven)) {
    source = applySevenParameter(position, options.seven);
  }
  const keepHeight = options.keepHeight ?? true;
  const z = source.length >= 3 ? (source as [number, number, number])[2] : undefined;
  // keepHeight=true（默认）：高度原样传递；false：把第三维交给 proj4 处理
  const passHeightToProj = z !== undefined && !keepHeight;
  const output = converter.forward(passHeightToProj ? [source[0], source[1], z] : [source[0], source[1]]);
  const outZ = passHeightToProj && output.length >= 3 ? output[2] : z;
  if (outZ !== undefined) return [output[0], output[1], outZ];
  return [output[0], output[1]];
}

/**
 * 批量转换 GeoJSON 全部坐标（递归处理 Point/MultiPoint/LineString/MultiLineString/
 * Polygon/MultiPolygon/Feature/FeatureCollection），返回新对象（不改输入）。
 * fromDef/toDef 可为内置 EPSG 代码（如 'EPSG:4326'）或自定义 proj4 定义字符串。
 */
export function transformGeoJSON<T extends GeoJSONData>(
  data: T,
  fromDef: string,
  toDef: string,
  options: TransformOptions = {},
): T {
  const converter = createConverter(fromDef, toDef);
  const mapped = mapGeoJSONCoordinates(data, (position) =>
    convertPosition(position, converter, options),
  );
  // bbox 未随坐标重算，直接去掉避免留下过期包围盒
  if (mapped && typeof mapped === 'object' && 'bbox' in mapped) {
    const { bbox: _bbox, ...rest } = mapped as T & { bbox?: unknown };
    return rest as T;
  }
  return mapped;
}

/** 转换前后对照样例（供 UI 预览） */
export interface TransformSample {
  source: GeoJSONPosition;
  target: GeoJSONPosition;
}

/**
 * 预览接口：给定若干源坐标，返回逐点转换前后对照。
 * fromDef/toDef 可为内置 EPSG 代码或自定义 proj4 定义字符串。
 */
export function sampleTransform(
  samples: GeoJSONPosition[],
  fromDef: string,
  toDef: string,
  options: TransformOptions = {},
): TransformSample[] {
  const converter = createConverter(fromDef, toDef);
  return samples.map((source) => ({
    source,
    target: convertPosition(source, converter, options),
  }));
}
