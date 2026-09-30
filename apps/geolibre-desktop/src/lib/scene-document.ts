/*
  lib/scene-document —— 服务端 SceneDocument → 编辑器工程的反向转换

  与 PublishDialog.buildSceneDocument（正向）对称：
  - 'geojson' + inline → geojson 图层（features 原样回填）
  - 'imagery' / 'geojson' + url → 按 URL 特征嗅探回 xyz / wms / wmts /
    vector-tiles（正向把四类 URL 图层都写成 type='imagery'，只能反向嗅探）
  - '3dtiles' + url → 3d-tiles 图层
  - assetId 引用 → 还原为服务端资产 URL（/api/assets/<id>/<filename>）
  - 'kml' / 'glb' / 'terrain' / 无 source 的图层 → 记入 skipped（不静默丢弃）
  - camera：SceneCamera.height → MapViewState.zoom（与正向 40075016.686·cos(lat)/2^z 互逆）
  - basemap：激活底图项的 URL 含 {z} 时还原 basemapStyleUrl
*/
import type { SceneDocument, SceneLayer } from "@geolibre/gis-shared";

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type MapViewState } from "@geolibre/core";

export interface SceneOpenResult {
  layers: GeoLibreLayer[];
  camera: MapViewState | null;
  basemapUrl: string | null;
  skipped: { name: string; reason: string }[];
}

const EARTH_CIRCUMFERENCE = 40075016.686;

/** 与正向 zoom→height 互逆：zoom = log2(C·cos(lat) / height) */
export function sceneCameraToViewState(
  camera: SceneDocument["camera"],
): MapViewState | null {
  if (!camera) return null;
  const height = Math.max(300, camera.height || 300);
  const cos = Math.max(0.01, Math.cos((camera.lat * Math.PI) / 180));
  const zoom = Math.min(
    22,
    Math.max(1, Math.log2((EARTH_CIRCUMFERENCE * cos) / height)),
  );
  return {
    center: [camera.lon, camera.lat],
    zoom: Number(zoom.toFixed(2)),
    bearing: camera.heading || 0,
    pitch: Math.min(85, Math.max(0, -(camera.pitch || 0))),
  };
}

/** URL 特征 → 编辑器图层类型（正向 imagery 的反向嗅探） */
export function sniffUrlLayerType(
  url: string,
): "xyz" | "wms" | "wmts" | "vector-tiles" {
  const upper = url.toUpperCase();
  if (upper.includes("SERVICE=WMS")) return "wms";
  if (upper.includes("SERVICE=WMTS") || /\/WMTS\b/i.test(url)) return "wmts";
  if (/\.(pbf|pbf\?|json)(\?|$)/i.test(url) || upper.includes("STYLE.JSON")) {
    return "vector-tiles";
  }
  return "xyz";
}

function assetUrl(base: string, layer: SceneLayer): string | null {
  const id = layer.source.assetId;
  if (!id) return null;
  const filename = layer.source.filename ?? "asset.bin";
  return `${base.replace(/\/$/, "")}/api/assets/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`;
}

/**
 * GeoJSONData（几何/要素/集合三态）→ 编辑器 Layer.geojson 要求的 FeatureCollection。
 * 非集合形态包装为单要素集合；无法识别返回 null（记入 skipped）。
 */
function normalizeToFeatureCollection(data: SceneLayer["features"]): GeoLibreLayer["geojson"] {
  if (!data) return undefined;
  const asRecord = data as unknown as Record<string, unknown>;
  if (asRecord.type === "FeatureCollection") return data as GeoLibreLayer["geojson"];
  if (asRecord.type === "Feature") {
    return { type: "FeatureCollection", features: [data as never] };
  }
  if (typeof asRecord.type === "string") {
    // 裸几何
    return {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: data as never }],
    };
  }
  return undefined;
}

function convertLayer(layer: SceneLayer, base: string): GeoLibreLayer | null {
  const url = layer.source.kind === "url" ? layer.source.url : assetUrl(base, layer);
  switch (layer.type) {
    case "geojson": {
      if (layer.source.kind === "inline" && layer.features) {
        const normalized = normalizeToFeatureCollection(layer.features);
        if (!normalized) return null;

        return {
          id: layer.id,
          name: layer.name,
          type: "geojson",
          source: { ...layer.source } as GeoLibreLayer["source"],
          visible: true,
          opacity: 1,
          style: structuredClone(DEFAULT_LAYER_STYLE),
          geojson: normalized,
          metadata: { fromScene: true, sceneMetadata: layer.metadata },
        };
      }
      if (url) {
        // URL GeoJSON（发布时 geojson+url 的少见组合）
        return {
          id: layer.id,
          name: layer.name,
          type: "geojson",
          source: { url } as GeoLibreLayer["source"],
          visible: true,
          opacity: 1,
          style: structuredClone(DEFAULT_LAYER_STYLE),
          metadata: { fromScene: true },
        };
      }
      return null;
    }
    case "3dtiles": {
      if (!url) return null;
      const sourceId = (layer.metadata?.sourceId as string) ?? `scene-${layer.id}`;
      return {
        id: layer.id,
        name: layer.name,
        type: "3d-tiles",
        source: { type: "3d-tiles", sourceId, url } as GeoLibreLayer["source"],
        visible: true,
        opacity: 1,
        style: structuredClone(DEFAULT_LAYER_STYLE),
        metadata: { fromScene: true, sceneMetadata: layer.metadata },
      };
    }
    case "imagery": {
      if (!url) return null;
      const sniffed = sniffUrlLayerType(url);
      if (sniffed === "xyz") {
        return {
          id: layer.id,
          name: layer.name,
          type: "xyz",
          source: { tiles: [url] } as GeoLibreLayer["source"],
          visible: true,
          opacity: 1,
          style: structuredClone(DEFAULT_LAYER_STYLE),
          metadata: { fromScene: true, sceneMetadata: layer.metadata },
        };
      }
      return {
        id: layer.id,
        name: layer.name,
        type: sniffed,
        source: { url } as GeoLibreLayer["source"],
        visible: true,
        opacity: 1,
        style: structuredClone(DEFAULT_LAYER_STYLE),
        metadata: { fromScene: true, sceneMetadata: layer.metadata },
      };
    }
    default:
      // kml / glb / terrain 及未知类型：显式跳过
      return null;
  }
}

export function sceneDocumentToProject(
  doc: SceneDocument,
  base: string,
): SceneOpenResult {
  const layers: GeoLibreLayer[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const layer of doc.layers ?? []) {
    const converted = convertLayer(layer, base);
    if (converted) {
      layers.push(converted);
    } else {
      const reason =
        layer.source.kind === "assetId" && !layer.source.assetId
          ? "资产引用缺少 id"
          : `暂不支持还原类型「${layer.type}」（${layer.source.kind}）`;
      skipped.push({ name: layer.name, reason });
    }
  }
  const basemapActive = doc.basemap?.items?.find?.((item) => item.isActive);
  const basemapUrl =
    basemapActive && basemapActive.urlTemplate.includes("{z}")
      ? basemapActive.urlTemplate
      : null;
  return {
    layers,
    camera: sceneCameraToViewState(doc.camera),
    basemapUrl,
    skipped,
  };
}
