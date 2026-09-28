/**
 * editor/core · GeoJSON 结构遍历工具
 *
 * 供 reprojection / optimizer / importer 复用的坐标级与几何级遍历。
 * 只处理 @geolibre/gis-shared 的 GeoJSON 常用子集（Point/MultiPoint/LineString/
 * MultiLineString/Polygon/MultiPolygon + Feature/FeatureCollection）。
 */
import type {
  GeoJSONData,
  GeoJSONFeature,
  GeoJSONFeatureCollection,
  GeoJSONGeometry,
  GeoJSONPosition,
} from '@geolibre/gis-shared';

/** 坐标映射：返回新坐标数组（原对象不被修改） */
export type PositionMapper = (position: GeoJSONPosition) => GeoJSONPosition;

/** 深拷贝并把全部坐标位应用 mapper（递归处理所有几何嵌套层级） */
export function mapGeoJSONCoordinates<T extends GeoJSONData>(data: T, map: PositionMapper): T {
  if (data.type === 'FeatureCollection') {
    const fc = data as GeoJSONFeatureCollection;
    return {
      ...fc,
      features: fc.features.map((feature) => mapGeoJSONCoordinates(feature, map)),
    } as T;
  }
  if (data.type === 'Feature') {
    const feature = data as GeoJSONFeature;
    return {
      ...feature,
      geometry: feature.geometry
        ? mapGeoJSONCoordinates(feature.geometry, map)
        : null,
    } as T;
  }
  return mapGeometryCoordinates(data as GeoJSONGeometry, map) as T;
}

/** 几何坐标映射（保持几何类型不变） */
export function mapGeometryCoordinates<G extends GeoJSONGeometry>(
  geometry: G,
  map: PositionMapper,
): G {
  switch (geometry.type) {
    case 'Point':
      return { ...geometry, coordinates: map(geometry.coordinates) } as G;
    case 'MultiPoint':
    case 'LineString':
      return { ...geometry, coordinates: geometry.coordinates.map(map) } as G;
    case 'MultiLineString':
    case 'Polygon':
      return { ...geometry, coordinates: geometry.coordinates.map((line) => line.map(map)) } as G;
    case 'MultiPolygon':
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((line) => line.map(map)),
        ),
      } as G;
    default: {
      const never: never = geometry;
      throw new Error(`不支持的 GeoJSON 几何类型：${JSON.stringify(never)}`);
    }
  }
}

/** 统计几何中坐标位数量（ Feature / FeatureCollection 递归累加） */
export function countGeoJSONPositions(data: GeoJSONData): number {
  if (data.type === 'FeatureCollection') {
    return data.features.reduce((sum, feature) => sum + countGeoJSONPositions(feature), 0);
  }
  if (data.type === 'Feature') {
    return data.geometry ? countGeometryPositions(data.geometry) : 0;
  }
  return countGeometryPositions(data);
}

export function countGeometryPositions(geometry: GeoJSONGeometry): number {
  switch (geometry.type) {
    case 'Point':
      return 1;
    case 'MultiPoint':
    case 'LineString':
      return geometry.coordinates.length;
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates.reduce((sum, line) => sum + line.length, 0);
    case 'MultiPolygon':
      return geometry.coordinates.reduce(
        (sum, polygon) => sum + polygon.reduce((s, line) => s + line.length, 0),
        0,
      );
    default: {
      const never: never = geometry;
      throw new Error(`不支持的 GeoJSON 几何类型：${JSON.stringify(never)}`);
    }
  }
}
