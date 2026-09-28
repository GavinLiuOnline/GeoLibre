/**
 * editor/core · importer/topojson —— TopoJSON → GeoJSON（topojson-client）
 */
import { feature } from 'topojson-client';
import type { GeoJSONFeature, GeoJSONFeatureCollection } from '@geolibre/gis-shared';

/** 把 TopoJSON topology 转为 GeoJSON FeatureCollection：
 * 遍历 topology.objects，逐个调用 topojson-client feature() 并合并
 * （GeometryCollection 转换结果为 FeatureCollection，展开合并）。
 */
export function topoToGeoJSON(topology: unknown): GeoJSONFeatureCollection {
  const objects = (topology as { objects?: Record<string, unknown> }).objects;
  if (!objects || typeof objects !== 'object') {
    throw new Error('不是合法的 TopoJSON：缺少 objects 字段');
  }
  const topo = topology as Parameters<typeof feature>[0];
  const features = Object.values(objects).map(
    (obj) => feature(topo, obj as never) as unknown as GeoJSONFeature | GeoJSONFeatureCollection,
  );
  const list = features.flatMap((item) =>
    item.type === 'FeatureCollection' ? item.features : [item],
  );
  return { type: 'FeatureCollection', features: list };
}
