/*
  scene-document 单测：SceneDocument → 工程的反向转换
  （URL 嗅探、相机互逆、内嵌 GeoJSON 归一化、skipped 语义、底图还原）。
*/
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SceneDocument, SceneLayer } from "@geolibre/gis-shared";

import {
  sceneCameraToViewState,
  sceneDocumentToProject,
  sniffUrlLayerType,
} from "../apps/geolibre-desktop/src/lib/scene-document";

const EARTH_CIRCUMFERENCE = 40075016.686;

function sceneLayer(overrides: Partial<SceneLayer>): SceneLayer {
  return {
    id: "layer-1",
    name: "图层",
    type: "imagery",
    source: { kind: "url", url: "https://tiles.example/{z}/{x}/{y}.png" },
    ...overrides,
  };
}

test("sceneCameraToViewState：与正向 zoom→height 公式互逆", () => {
  const lat = 40;
  const height = 500000;
  const expectedZoom = Math.log2(
    (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / height,
  );
  const view = sceneCameraToViewState({
    lon: 116.4,
    lat,
    height,
    heading: 35,
    pitch: -60,
    roll: 0,
  });
  assert.ok(view);
  assert.deepEqual(view.center, [116.4, lat]);
  assert.ok(Math.abs(view.zoom - expectedZoom) < 0.01, `${view.zoom} vs ${expectedZoom}`);
  assert.equal(view.bearing, 35);
  assert.equal(view.pitch, 60); // 正向 -pitch 存储，反向取负
});

test("sceneCameraToViewState：pitch 取负并夹取、异常高度兜底", () => {
  const view = sceneCameraToViewState({
    lon: 0,
    lat: 0,
    height: 1,
    heading: 0,
    pitch: -95,
    roll: 0,
  });
  assert.ok(view);
  assert.equal(view.pitch, 85);
  assert.ok(view.zoom >= 1 && view.zoom <= 22);
  assert.equal(sceneCameraToViewState(undefined), null);
});

test("sniffUrlLayerType：xyz/wms/wmts/vector-tiles 四类", () => {
  assert.equal(sniffUrlLayerType("https://t.example/{z}/{x}/{y}.png"), "xyz");
  assert.equal(
    sniffUrlLayerType("https://w.example/wms?SERVICE=WMS&REQUEST=GetMap"),
    "wms",
  );
  assert.equal(
    sniffUrlLayerType("https://w.example/WMTS?SERVICE=WMTS&tileMatrix={z}"),
    "wmts",
  );
  assert.equal(sniffUrlLayerType("https://v.example/tiles/{z}/{x}/{y}.pbf"), "vector-tiles");
  assert.equal(sniffUrlLayerType("https://v.example/style.json"), "vector-tiles");
});

test("sceneDocumentToProject：inline geojson / imagery 嗅探 / 3dtiles / skipped", () => {
  const fc = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { name: "a" },
        geometry: { type: "Point" as const, coordinates: [116, 40] },
      },
    ],
  };
  const doc: SceneDocument = {
    version: 1,
    name: "测试场景",
    camera: { lon: 116, lat: 40, height: 300, heading: 0, pitch: -90, roll: 0 },
    layers: [
      sceneLayer({
        id: "g1",
        name: "内嵌矢量",
        type: "geojson",
        source: { kind: "inline" },
        features: fc,
      }),
      sceneLayer({ id: "w1", name: "WMS", type: "imagery", source: { kind: "url", url: "https://w/wms?SERVICE=WMS" } }),
      sceneLayer({ id: "t1", name: "三维瓦片", type: "3dtiles", source: { kind: "url", url: "https://x/tileset.json" } }),
      sceneLayer({ id: "m1", name: "模型", type: "glb", source: { kind: "inline" } }),
      sceneLayer({ id: "k1", name: "KML", type: "kml", source: { kind: "inline" } }),
    ],
  };
  const result = sceneDocumentToProject(doc, "http://127.0.0.1:8080");
  assert.equal(result.layers.length, 3);
  assert.equal(result.layers[0]?.type, "geojson");
  assert.deepEqual(result.layers[0]?.geojson?.features[0]?.geometry, fc.features[0]?.geometry);
  assert.equal(result.layers[1]?.type, "wms");
  assert.equal(result.layers[2]?.type, "3d-tiles");
  assert.deepEqual(
    result.skipped.map((item) => item.name),
    ["模型", "KML"],
  );
  // 相机：height=300 在 lat 40 → 较高 zoom
  assert.ok(result.camera && result.camera.zoom > 10);
});

test("sceneDocumentToProject：裸几何内嵌包装为单要素集合；assetId 还原资产 URL", () => {
  const doc: SceneDocument = {
    version: 1,
    name: "s",
    layers: [
      sceneLayer({
        id: "p1",
        type: "geojson",
        source: { kind: "inline" },
        features: { type: "Point", coordinates: [116, 40] } as never,
      }),
      sceneLayer({
        id: "a1",
        type: "geojson",
        source: { kind: "assetId", assetId: "ast-9", filename: "points.geojson" },
      }),
    ],
  };
  const result = sceneDocumentToProject(doc, "http://127.0.0.1:8080/");
  assert.equal(result.layers[0]?.geojson?.type, "FeatureCollection");
  assert.equal(result.layers[0]?.geojson?.features.length, 1);
  const assetLayer = result.layers[1];
  assert.ok(assetLayer);
  const sourceUrl = (assetLayer.source as { url?: string }).url;
  assert.equal(sourceUrl, "http://127.0.0.1:8080/api/assets/ast-9/points.geojson");
});

test("sceneDocumentToProject：激活底图（custom XYZ 模板）还原，preset 无模板不还原", () => {
  const base: SceneDocument = {
    version: 1,
    name: "s",
    layers: [],
  };
  const withCustom: SceneDocument = {
    ...base,
    basemap: {
      activeId: "custom-1",
      items: [
        {
          id: "custom-1",
          kind: "custom",
          label: "我的底图",
          urlTemplate: "https://m.example/{z}/{x}/{y}.png",
          isActive: true,
        },
      ],
    } as never,
  };
  const result = sceneDocumentToProject(withCustom, "http://x");
  assert.equal(result.basemapUrl, "https://m.example/{z}/{x}/{y}.png");
  const withPreset: SceneDocument = {
    ...base,
    basemap: {
      activeId: "osm",
      items: [{ id: "osm", kind: "preset", label: "OSM", urlTemplate: "", isActive: true }],
    } as never,
  };
  assert.equal(sceneDocumentToProject(withPreset, "http://x").basemapUrl, null);
});
