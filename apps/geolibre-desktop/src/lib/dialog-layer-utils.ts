/*
  lib/dialog-layer-utils —— 面板对话框共用的图层筛选助手

  getVectorLayers：返回含内嵌 GeoJSON 的图层（重投影 / 缓存生成等
  纯客户端矢量链路的候选输入），按名称排序保持列表稳定。
*/
import type { GeoLibreLayer } from "@geolibre/core";

export function getVectorLayers(layers: readonly GeoLibreLayer[]): GeoLibreLayer[] {
  return layers
    .filter((l) => Boolean(l.geojson) && (l.geojson?.features.length ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}
