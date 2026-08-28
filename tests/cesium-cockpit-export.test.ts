import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmptyProject, DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  buildCockpitExport,
  buildCockpitGlobeHtml,
  buildCockpitIndexHtml,
  cacheTilesetTree,
  COCKPIT_MESSAGE_SOURCE,
  serializeCockpitConfigJs,
} from "../apps/geolibre-desktop/src/lib/cesium-cockpit-export";

const encoder = new TextEncoder();

function geojsonLayer(): GeoLibreLayer {
  return {
    id: "cities",
    name: "Cities",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, fillColor: "#22c55e" },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Shanghai", pop: 24 },
          geometry: { type: "Point", coordinates: [121.47, 31.23] },
        },
      ],
    },
  };
}

describe("Cesium cockpit export", () => {
  it("builds a HUD index.html that frames globe.html over postMessage", () => {
    const html = buildCockpitIndexHtml("Harbor survey");
    assert.match(html, /<title>Harbor survey · 数字孪生驾驶舱<\/title>/);
    assert.match(html, /id="project-title">Harbor survey/);
    assert.match(html, /iframe id="globe-frame" src="globe.html"/);
    assert.doesNotMatch(html, /Cesium\.js/);
    assert.match(html, /config\.js/);
    assert.match(html, /全景总览/);
    assert.match(html, /目标详情/);
    assert.match(html, new RegExp(COCKPIT_MESSAGE_SOURCE));
    assert.match(html, /data\.type === "pick"/);
  });

  it("builds globe.html with Cesium picks posted to the parent", () => {
    const html = buildCockpitGlobeHtml();
    assert.match(html, /Cesium\.js/);
    assert.match(html, /config\.js/);
    assert.match(html, /Cesium3DTileFeature/);
    assert.match(html, /LEFT_CLICK/);
    assert.match(html, /window\.parent\.postMessage/);
    assert.match(html, /homeButton: false/);
    assert.match(html, /cesium-viewer-toolbar \{ display: none/);
  });

  it("escapes HTML in the page title", () => {
    const html = buildCockpitIndexHtml(`x</title><img src=x onerror=alert(1)>`);
    assert.ok(!html.includes("</title><img"));
    assert.match(html, /&lt;\/title&gt;/);
  });

  it("writes online layers to config.js and caches local GeoJSON", async () => {
    const project = createEmptyProject("Harbor");
    project.mapView = { center: [121.47, 31.23], zoom: 10, bearing: 15, pitch: 45 };
    project.layers.push(geojsonLayer());
    project.layers.push({
      id: "osm",
      name: "OSM",
      type: "xyz",
      source: { type: "xyz", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"] },
      visible: true,
      opacity: 0.8,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    });
    project.layers.push({
      id: "tiles",
      name: "Remote tiles",
      type: "3d-tiles",
      source: { type: "3d-tiles", url: "https://example.com/tileset.json" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    });

    const exported = await buildCockpitExport({ project, title: "Harbor" });
    const paths = exported.files.map((file) => file.path).sort();
    assert.deepEqual(paths, [
      "config.js",
      "data/geojson/cities.geojson",
      "globe.html",
      "index.html",
    ].sort());
    const xyz = exported.config.layers.find((layer) => layer.id === "osm");
    assert.equal(xyz?.url, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    assert.equal(xyz?.cached, false);
    const remote = exported.config.layers.find((layer) => layer.id === "tiles");
    assert.equal(remote?.url, "https://example.com/tileset.json");
    assert.equal(remote?.cached, false);
    const vector = exported.config.layers.find((layer) => layer.id === "cities");
    assert.equal(vector?.url, "data/geojson/cities.geojson");
    assert.equal(vector?.cached, true);
    assert.ok(Math.abs(exported.config.camera.longitude - 121.47) < 1e-6);
    assert.ok(exported.config.camera.height > 0);
    const js = new TextDecoder().decode(exported.files.find((file) => file.path === "config.js")!.bytes);
    assert.match(js, /window\.GEOLIBRE_COCKPIT/);
  });

  it("redacts credentials from config.js", async () => {
    const project = createEmptyProject("Secret");
    project.preferences.geocoding.apiKeys.mapbox = "cockpit-secret";
    project.layers.push({
      id: "auth",
      name: "Auth tiles",
      type: "3d-tiles",
      source: {
        type: "3d-tiles",
        url: "https://example.com/private/tileset.json",
        requestHeaders: { Authorization: "Bearer cockpit-secret" },
      },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    });
    const exported = await buildCockpitExport({ project });
    const js = serializeCockpitConfigJs(exported.config);
    assert.ok(!js.includes("cockpit-secret"));
    assert.ok(!js.includes("Bearer"));
  });

  it("caches a local 3D Tiles tree and rewrites child URIs", async () => {
    const tileset = encoder.encode(
      JSON.stringify({
        asset: { version: "1.1" },
        root: {
          content: { uri: "tile.glb" },
          boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
        },
      }),
    );
    const glb = encoder.encode("glb-bytes");
    const cached = await cacheTilesetTree(
      "https://cockpit.local/root/tileset.json",
      "data/tilesets/mesh",
      async (url) => (url.endsWith("tileset.json") ? tileset : glb),
    );
    assert.ok(cached.some((file) => file.path === "data/tilesets/mesh/tileset.json"));
    const json = JSON.parse(
      new TextDecoder().decode(cached.find((file) => file.path.endsWith("tileset.json"))!.bytes),
    );
    assert.equal(json.root.content.uri, "tile.glb");
    assert.ok(cached.some((file) => file.path.endsWith("tile.glb")));
  });
});