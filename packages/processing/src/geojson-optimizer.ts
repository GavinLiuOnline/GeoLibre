/**
 * editor/core · optimizer/geojsonOptimizer —— GeoJSON 数据轻量化（纯函数）
 *
 * - Douglas-Peucker 抽稀（线/环容差可调，单位「度」；Point/MultiPoint 不做抽稀）
 * - 属性字段裁剪（keepProperties 白名单 / dropProperties 黑名单，可叠加）
 * - 可选要素数量上限（maxFeatures，超出时保留前 N 个要素）
 * - 返回 before/after 统计（要素数、坐标位数）
 */
import type { GeoJSONData, GeoJSONFeature, GeoJSONFeatureCollection, GeoJSONGeometry, GeoJSONPosition } from '@geolibre/gis-shared';

import { countGeoJSONPositions } from './geojson-utils';
import { simplifyPositions, simplifyRing } from './douglas-peucker';

export interface GeoJSONOptimizeOptions {
  /** Douglas-Peucker 抽稀容差（度），默认 0（不抽稀） */
  tolerance?: number;
  /** 属性字段白名单（只保留这些字段）；与 dropProperties 同给时，先白名单后黑名单 */
  keepProperties?: string[];
  /** 属性字段黑名单（剔除这些字段） */
  dropProperties?: string[];
  /** 要素数量上限（FeatureCollection 生效，超出保留前 N 个） */
  maxFeatures?: number;
}

export interface GeoJSONOptimizeResult {
  /** 轻量化后的 GeoJSON（新对象，不修改输入） */
  data: GeoJSONData;
  beforeFeatures: number;
  afterFeatures: number;
  beforeVertices: number;
  afterVertices: number;
}

export function optimizeGeoJSON(data: GeoJSONData, options: GeoJSONOptimizeOptions = {}): GeoJSONOptimizeResult {
  const beforeFeatures = countFeatures(data);
  const beforeVertices = countGeoJSONPositions(data);
  const tolerance = options.tolerance ?? 0;

  // 1. 几何抽稀
  let result: GeoJSONData = tolerance > 0 ? simplifyData(data, tolerance) : cloneShallow(data);

  // 2. 要素上限
  if (options.maxFeatures !== undefined && result.type === 'FeatureCollection') {
    const fc = result as GeoJSONFeatureCollection;
    if (fc.features.length > options.maxFeatures) {
      result = { ...fc, features: fc.features.slice(0, options.maxFeatures) };
    }
  }

  // 3. 属性裁剪
  if (options.keepProperties || options.dropProperties) {
    result = clipProperties(result, options.keepProperties, options.dropProperties);
  }

  return {
    data: result,
    beforeFeatures,
    afterFeatures: countFeatures(result),
    beforeVertices,
    afterVertices: countGeoJSONPositions(result),
  };
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

function countFeatures(data: GeoJSONData): number {
  return data.type === 'FeatureCollection' ? data.features.length : 1;
}

function cloneShallow(data: GeoJSONData): GeoJSONData {
  if (data.type === 'FeatureCollection') {
    return { ...data, features: data.features.map(cloneFeature) };
  }
  if (data.type === 'Feature') return cloneFeature(data);
  return { ...data, coordinates: data.coordinates } as GeoJSONData;
}

function cloneFeature(feature: GeoJSONFeature): GeoJSONFeature {
  return { ...feature, geometry: feature.geometry ? { ...feature.geometry } : null };
}

function simplifyData(data: GeoJSONData, tolerance: number): GeoJSONData {
  if (data.type === 'FeatureCollection') {
    return { ...data, features: data.features.map((f) => simplifyFeature(f, tolerance)) };
  }
  if (data.type === 'Feature') {
    return simplifyFeature(data, tolerance);
  }
  return {
    ...data,
    coordinates: simplifyCoordinates(data.type, data.coordinates, tolerance),
  } as GeoJSONData;
}

function simplifyFeature(feature: GeoJSONFeature, tolerance: number): GeoJSONFeature {
  return {
    ...feature,
    geometry: feature.geometry
      ? ({
          ...feature.geometry,
          coordinates: simplifyCoordinates(feature.geometry.type, feature.geometry.coordinates, tolerance),
        } as GeoJSONGeometry)
      : null,
  };
}

/** 按几何类型对坐标序列/环应用抽稀（Point/MultiPoint 原样保留） */
function simplifyCoordinates(
  type: GeoJSONGeometry['type'],
  coordinates: unknown,
  tolerance: number,
): unknown {
  switch (type) {
    case 'Point':
    case 'MultiPoint':
      return coordinates;
    case 'LineString':
      return simplifyPositions(coordinates as GeoJSONPosition[], tolerance);
    case 'MultiLineString':
      return (coordinates as GeoJSONPosition[][]).map((line) =>
        simplifyPositions(line, tolerance),
      );
    case 'Polygon':
      return (coordinates as GeoJSONPosition[][]).map((ring) => simplifyRing(ring, tolerance));
    case 'MultiPolygon':
      return (coordinates as GeoJSONPosition[][][]).map((polygon) =>
        polygon.map((ring) => simplifyRing(ring, tolerance)),
      );
    default: {
      const never: never = type;
      throw new Error(`不支持的几何类型：${String(never)}`);
    }
  }
}

function clipProperties(
  data: GeoJSONData,
  keep?: string[],
  drop?: string[],
): GeoJSONData {
  if (data.type === 'FeatureCollection') {
    return { ...data, features: data.features.map((f) => clipFeatureProperties(f, keep, drop)) };
  }
  if (data.type === 'Feature') {
    return clipFeatureProperties(data, keep, drop);
  }
  return data;
}

function clipFeatureProperties(
  feature: GeoJSONFeature,
  keep?: string[],
  drop?: string[],
): GeoJSONFeature {
  const props = feature.properties;
  if (!props || typeof props !== 'object') return feature;
  const filtered: Record<string, unknown> = {};
  const keepSet = keep ? new Set(keep) : undefined;
  const dropSet = drop ? new Set(drop) : undefined;
  for (const [key, value] of Object.entries(props)) {
    if (keepSet && !keepSet.has(key)) continue;
    if (dropSet && dropSet.has(key)) continue;
    filtered[key] = value;
  }
  return { ...feature, properties: filtered };
}
