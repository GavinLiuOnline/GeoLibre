/**
 * editor/core · importer/kml —— KML → GeoJSON（@tmcw/togeojson）
 *
 * 服务端发布链路走 GeoJSON：KML 导入时除 Cesium.KmlDataSource 显示外，
 * 用 togeojson 同步转出一份 GeoJSON 表示存入场景文档图层（inline source），
 * 保证 KML 图层保存/发布后不丢数据。
 */
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import type { GeoJSONFeatureCollection } from '@geolibre/gis-shared';

/** 解析 KML 文本为 GeoJSON FeatureCollection（浏览器端 DOMParser；解析失败抛错） */
export function parseKmlToGeoJSON(text: string): GeoJSONFeatureCollection {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('KML 解析失败：XML 格式错误');
  }
  return kmlToGeoJSON(doc) as GeoJSONFeatureCollection;
}
