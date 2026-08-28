/**
 * Project → Export Cesium cockpit. Writes a static folder (as a ZIP) with:
 *
 * - `index.html` — digital-twin HUD chrome (title, nav, side panels)
 * - `globe.html` — CesiumJS globe, framed by index.html
 * - `config.js`  — online layer URLs plus relative paths to bundled caches
 * - `data/geojson/*.geojson` — local / in-memory vector features
 * - `data/tilesets/<id>/` — local or blob 3D Tiles trees rewritten to relative URIs
 *
 * Picks inside the globe iframe postMessage to the HUD, which opens a simulated
 * detail panel. Credentials are stripped before anything is written.
 */

import {
  isAbsoluteFilesystemPath,
  redactCredentials,
  type GeoLibreLayer,
  type GeoLibreProject,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";

export const COCKPIT_MESSAGE_SOURCE = "geolibre-cesium-cockpit";

const CESIUM_CDN = "https://cdn.jsdelivr.net/npm/cesium@1.144.0/Build/Cesium/";
const MAX_TILESET_FILES = 250;
const MAX_TILESET_BYTES = 100 * 1024 * 1024;
const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;
const TILE_SIZE = 512;
const FOVY = Math.PI / 3;
const ASSUMED_CANVAS_HEIGHT = 800;
const MAX_PITCH = 85;
const MAX_MERCATOR_LAT = 85.051129;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function cameraFromProject(project: GeoLibreProject): CockpitConfig["camera"] {
  const view = project.mapView;
  const longitude = Array.isArray(view?.center) ? Number(view.center[0]) : 0;
  const latitude = Array.isArray(view?.center) ? Number(view.center[1]) : 0;
  const zoom = typeof view?.zoom === "number" ? view.zoom : 2;
  const heading = typeof view?.bearing === "number" ? view.bearing : 0;
  const pitch = clamp(typeof view?.pitch === "number" ? view.pitch : 0, 0, MAX_PITCH) - 90;
  const latRad = (clamp(latitude, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * Math.PI) / 180;
  const groundRes = (Math.cos(latRad) * EARTH_CIRCUMFERENCE) / (TILE_SIZE * 2 ** zoom);
  const height = (groundRes * ASSUMED_CANVAS_HEIGHT) / (2 * Math.tan(FOVY / 2));
  return {
    longitude: Number.isFinite(longitude) ? longitude : 0,
    latitude: Number.isFinite(latitude) ? latitude : 0,
    height: Number.isFinite(height) && height > 0 ? height : 12_000_000,
    heading: Number.isFinite(heading) ? heading : 0,
    pitch: Number.isFinite(pitch) ? pitch : -90,
  };
}

export interface CockpitLayer {
  id: string;
  name: string;
  type: "geojson" | "3d-tiles" | "xyz" | "wms" | "wmts" | "raster";
  url: string;
  visible: boolean;
  opacity: number;
  cached: boolean;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  markerColor?: string;
  wmsLayers?: string;
  wmsFormat?: string;
  minzoom?: number;
  maxzoom?: number;
}

export interface CockpitSkippedLayer {
  id: string;
  name: string;
  reason: string;
}

export interface CockpitConfig {
  version: 1;
  title: string;
  ionToken: string;
  camera: {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
  };
  layers: CockpitLayer[];
  skipped: CockpitSkippedLayer[];
}

export interface CockpitExportFile {
  path: string;
  bytes: Uint8Array;
}

export type CockpitByteFetcher = (url: string) => Promise<Uint8Array>;

export interface BuildCockpitExportOptions {
  project: GeoLibreProject;
  title?: string;
  /** Optional Ion token written into config.js. Leave empty; hosts fill it in. */
  ionToken?: string;
  fetchBytes?: CockpitByteFetcher;
}

const encoder = new TextEncoder();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isBlobUrl(value: string): boolean {
  return value.startsWith("blob:");
}

function isLocalUrl(value: string): boolean {
  return isBlobUrl(value) || value.startsWith("file:") || isAbsoluteFilesystemPath(value);
}

function safeStem(id: string): string {
  const stem = id.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return stem || "layer";
}

function layerGeoJson(layer: GeoLibreLayer): FeatureCollection | undefined {
  if (layer.geojson && Array.isArray(layer.geojson.features) && layer.geojson.features.length) {
    return layer.geojson;
  }
  const embedded = layer.metadata?.embeddedGeoJSON;
  if (
    embedded &&
    typeof embedded === "object" &&
    Array.isArray((embedded as FeatureCollection).features) &&
    (embedded as FeatureCollection).features.length
  ) {
    return embedded as FeatureCollection;
  }
  return undefined;
}

function tilesetUrlOf(layer: GeoLibreLayer): string | undefined {
  return str(layer.source.url) ?? str(layer.sourcePath);
}

function imageryUrlOf(layer: GeoLibreLayer): string | undefined {
  const tiles = layer.source.tiles;
  if (Array.isArray(tiles) && typeof tiles[0] === "string" && tiles[0]) return tiles[0];
  return str(layer.source.url);
}

function collectRefUris(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefUris(item, out);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.uri === "string" && rec.uri) out.push(rec.uri);
  const content = rec.content;
  if (content && typeof content === "object") {
    const url = (content as { url?: unknown }).url;
    if (typeof url === "string" && url) out.push(url);
  }
  for (const value of Object.values(rec)) collectRefUris(value, out);
}

function rewriteRefUris(node: unknown, map: Map<string, string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) rewriteRefUris(item, map);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.uri === "string" && map.has(rec.uri)) rec.uri = map.get(rec.uri);
  const content = rec.content;
  if (content && typeof content === "object") {
    const c = content as { url?: string };
    if (typeof c.url === "string" && map.has(c.url)) c.url = map.get(c.url);
  }
  for (const value of Object.values(rec)) rewriteRefUris(value, map);
}

function resolveChildUrl(parentUrl: string, ref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("data:")) return ref;
  try {
    return new URL(ref, parentUrl).toString();
  } catch {
    return ref;
  }
}

function basenameOfUrl(url: string, fallback: string): string {
  try {
    const path = new URL(url, "https://cockpit.local/").pathname;
    const base = path.split("/").filter(Boolean).pop();
    if (base) return base.replace(/[?#].*$/, "");
  } catch {
    // Fall through.
  }
  return fallback;
}

function looksLikeJson(bytes: Uint8Array, name: string): boolean {
  if (/\.json$/i.test(name)) return true;
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) {
    i += 1;
  }
  return bytes[i] === 0x7b || bytes[i] === 0x5b;
}

/**
 * Copy a local / blob 3D Tiles tree into `destDir`, rewriting child URIs to
 * relative paths. Remote HTTP tilesets are left as URLs (see caller).
 */
export async function cacheTilesetTree(
  rootUrl: string,
  destDir: string,
  fetchBytes: CockpitByteFetcher,
): Promise<CockpitExportFile[]> {
  const files: CockpitExportFile[] = [];
  const usedNames = new Set<string>();
  const urlToName = new Map<string, string>();
  let totalBytes = 0;

  const uniqueName = (raw: string): string => {
    const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "_") || "tile";
    let name = cleaned;
    let n = 1;
    while (usedNames.has(name)) {
      const dot = cleaned.lastIndexOf(".");
      name = dot > 0 ? `${cleaned.slice(0, dot)}_${n}${cleaned.slice(dot)}` : `${cleaned}_${n}`;
      n += 1;
    }
    usedNames.add(name);
    return name;
  };

  const queue: { url: string; name: string }[] = [{ url: rootUrl, name: "tileset.json" }];
  const seen = new Set<string>();

  while (queue.length) {
    const next = queue.shift();
    if (!next || seen.has(next.url)) continue;
    seen.add(next.url);
    if (files.length >= MAX_TILESET_FILES || totalBytes >= MAX_TILESET_BYTES) {
      throw new Error("3D Tiles cache exceeded the export size limit");
    }
    const bytes = await fetchBytes(next.url);
    const name = urlToName.get(next.url) ?? uniqueName(next.name);
    urlToName.set(next.url, name);
    let outBytes = bytes;
    if (looksLikeJson(bytes, name)) {
      const text = new TextDecoder().decode(bytes);
      const doc = JSON.parse(text) as unknown;
      const refs: string[] = [];
      collectRefUris(doc, refs);
      const rewrite = new Map<string, string>();
      for (const ref of refs) {
        if (ref.startsWith("data:")) continue;
        const childUrl = resolveChildUrl(next.url, ref);
        let childName = urlToName.get(childUrl);
        if (!childName) {
          childName = uniqueName(basenameOfUrl(childUrl, `tile-${files.length}`));
          urlToName.set(childUrl, childName);
          queue.push({ url: childUrl, name: childName });
        }
        rewrite.set(ref, childName);
      }
      rewriteRefUris(doc, rewrite);
      outBytes = encoder.encode(`${JSON.stringify(doc)}\n`);
    }
    totalBytes += outBytes.length;
    files.push({ path: `${destDir}/${name}`, bytes: outBytes });
  }

  return files;
}

export function serializeCockpitConfigJs(config: CockpitConfig): string {
  const json = JSON.stringify(config, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `/* GeoLibre Cesium cockpit configuration. Loaded by index.html and globe.html. */\nwindow.GEOLIBRE_COCKPIT = ${json};\n`;
}

export function buildCockpitIndexHtml(title: string): string {
  const safeTitle = escapeHtml(title);
  const source = JSON.stringify(COCKPIT_MESSAGE_SOURCE);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle} · 数字孪生驾驶舱</title>
  <style>
    :root {
      --navy: #041428;
      --panel: rgba(6, 28, 68, 0.62);
      --line: rgba(64, 190, 255, 0.55);
      --cyan: #5ce1ff;
      --blue: #2f8dff;
      --text: #e8f6ff;
      --muted: #8eb4d4;
      --warn: #ff5d6c;
      --ok: #3ee0a4;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; overflow: hidden; color: var(--text);
      font-family: "Segoe UI", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
      background: #02060e; }
    #globe-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; z-index: 0; background: #02060e; }
    .hud { position: absolute; z-index: 2; pointer-events: none; }
    .hud * { pointer-events: auto; }
    #top {
      inset-inline: 0; inset-block-start: 0; height: 72px;
      background: linear-gradient(180deg, rgba(2,10,28,0.92) 0%, rgba(2,10,28,0.55) 70%, transparent 100%);
      display: grid; grid-template-columns: minmax(220px,1.1fr) auto minmax(220px,1fr); align-items: center;
      padding: 8px 22px 18px; gap: 12px;
    }
    #top::after {
      content: ""; position: absolute; inset-inline: 8%; inset-block-end: 6px; height: 1px;
      background: linear-gradient(90deg, transparent, var(--line), transparent);
      box-shadow: 0 0 8px var(--cyan);
    }
    #brand { min-width: 0; }
    #brand h1 {
      margin: 0; font-size: clamp(16px, 2vw, 22px); font-weight: 700; letter-spacing: 0.06em;
      text-shadow: 0 0 18px rgba(92,225,255,0.45); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #brand p { margin: 3px 0 0; font-size: 11px; color: var(--cyan); letter-spacing: 0.28em; text-transform: uppercase; }
    #tabs { display: flex; gap: 8px; }
    .tab {
      transform: skewX(-18deg); padding: 8px 18px; border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(20,80,170,0.45), rgba(8,30,70,0.35));
      color: var(--text); cursor: pointer; font-size: 13px; white-space: nowrap;
      box-shadow: 0 0 12px rgba(47,141,255,0.25);
    }
    .tab span { display: inline-block; transform: skewX(18deg); }
    .tab.active { background: linear-gradient(180deg, rgba(40,140,255,0.75), rgba(12,50,120,0.55)); box-shadow: 0 0 18px rgba(92,225,255,0.4); }
    #meta { display: flex; justify-content: flex-end; gap: 16px; align-items: center; font-variant-numeric: tabular-nums; font-size: 12px; color: var(--muted); }
    #meta b { color: var(--cyan); }
    #left, #right {
      top: 86px; bottom: 28px; width: min(320px, 24vw); display: flex; flex-direction: column; gap: 12px;
    }
    #left { inset-inline-start: 16px; }
    #right { inset-inline-end: 16px; }
    .panel {
      background: linear-gradient(180deg, rgba(8,36,82,0.72), rgba(4,16,40,0.58));
      border: 1px solid var(--line); backdrop-filter: blur(14px);
      box-shadow: 0 0 28px rgba(20,80,180,0.22), inset 0 0 40px rgba(20,90,180,0.08);
      clip-path: polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px);
      padding: 12px 14px; min-height: 0; overflow: auto;
    }
    .panel h2 {
      margin: 0 0 10px; font-size: 12px; letter-spacing: 0.18em; color: var(--cyan);
      border-bottom: 1px solid rgba(92,225,255,0.2); padding-bottom: 6px; text-transform: uppercase;
    }
    .kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .kpi { padding: 8px; background: rgba(0,40,90,0.35); border: 1px solid rgba(64,190,255,0.2); }
    .kpi span { display: block; font-size: 11px; color: var(--muted); }
    .kpi b { font-size: 20px; color: var(--cyan); font-weight: 650; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th { text-align: start; color: var(--muted); font-weight: 500; padding: 4px 2px; }
    td { padding: 5px 2px; border-top: 1px solid rgba(64,190,255,0.15); }
    .status-ok { color: var(--ok); }
    .status-warn { color: var(--warn); }
    .gauges { display: flex; gap: 8px; }
    .gauge { flex: 1; text-align: center; }
    .ring {
      width: 54px; height: 54px; margin: 0 auto 4px; border-radius: 50%;
      border: 3px solid rgba(92,225,255,0.25); border-top-color: var(--cyan);
      box-shadow: 0 0 10px rgba(92,225,255,0.25);
    }
    .ring.warn { border-top-color: var(--warn); }
    .gauge small { color: var(--muted); font-size: 10px; }
    .equip { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 12px; }
    .equip div { display: flex; justify-content: space-between; padding: 4px 6px; background: rgba(0,30,70,0.35); }
    .equip b { color: var(--cyan); }
    #chart { height: 72px; width: 100%; display: block; }
    #modes {
      inset-inline-end: calc(min(320px, 24vw) + 28px); inset-block-end: 36px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .mode {
      transform: skewX(-14deg); padding: 7px 14px; font-size: 12px; cursor: pointer;
      background: rgba(8,30,70,0.7); border: 1px solid var(--line); color: var(--text);
    }
    .mode span { display: inline-block; transform: skewX(14deg); }
    .mode.active { background: rgba(40,140,255,0.55); }
    #footer {
      inset-inline: 22%; inset-block-end: 8px; text-align: center; font-size: 11px;
      letter-spacing: 0.12em; color: var(--muted); pointer-events: none;
      text-shadow: 0 0 8px #000;
    }
    #footer b { color: var(--text); }
    #target {
      display: none; inset-inline-end: calc(min(320px, 24vw) + 28px); inset-block-start: 92px;
      width: min(340px, 28vw); max-height: calc(100% - 140px);
    }
    #target.open { display: block; }
    #target .close { float: inline-end; cursor: pointer; color: var(--muted); border: 0; background: none; }
    #target pre { margin: 8px 0 0; font-size: 11px; white-space: pre-wrap; word-break: break-word; color: var(--text); }
    .layer { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .layer:last-child { border-bottom: 0; }
    .kind { margin-inline-start: auto; font-size: 10px; color: var(--muted); }
    @media (max-width: 960px) {
      #left, #right { display: none; }
      #modes, #target { inset-inline-end: 12px; width: min(320px, calc(100% - 24px)); }
      #tabs { display: none; }
    }
  </style>
</head>
<body>
  <iframe id="globe-frame" src="globe.html" title="Cesium globe"></iframe>
  <header id="top" class="hud">
    <div id="brand">
      <h1 id="project-title">${safeTitle}</h1>
      <p>Digital Twin Cockpit</p>
    </div>
    <nav id="tabs">
      <button class="tab active" data-tab="overview"><span>全景总览</span></button>
      <button class="tab" data-tab="ops"><span>智慧运营</span></button>
      <button class="tab" data-tab="sec"><span>智慧安防</span></button>
      <button class="tab" data-tab="energy"><span>智慧能耗</span></button>
      <button class="tab" data-tab="emg"><span>应急指挥</span></button>
    </nav>
    <div id="meta">
      <span>图层 <b id="layer-count">0</b></span>
      <span>告警 <b id="alarm-count" class="status-warn">3</b></span>
      <span id="clock"></span>
    </div>
  </header>
  <aside id="left" class="hud">
    <section class="panel">
      <h2>园区概览</h2>
      <div class="kpis">
        <div class="kpi"><span>建筑</span><b id="kpi-bldg">128</b></div>
        <div class="kpi"><span>在线设备</span><b id="kpi-dev">2,416</b></div>
        <div class="kpi"><span>今日通行</span><b id="kpi-pax">1,087</b></div>
        <div class="kpi"><span>能耗 MW</span><b id="kpi-kwh">3.42</b></div>
      </div>
    </section>
    <section class="panel" style="flex:1">
      <h2>图层</h2>
      <div id="layer-list"></div>
    </section>
    <section class="panel">
      <h2>人员通行</h2>
      <table>
        <thead><tr><th>姓名</th><th>位置</th><th>状态</th></tr></thead>
        <tbody id="pax-body">
          <tr><td>陈伟</td><td>1号门</td><td class="status-ok">在园</td></tr>
          <tr><td>林雪</td><td>研发楼</td><td class="status-ok">在园</td></tr>
          <tr><td>访客-08</td><td>接待厅</td><td class="status-warn">预约</td></tr>
        </tbody>
      </table>
    </section>
  </aside>
  <aside id="right" class="hud">
    <section class="panel">
      <h2>园区态势</h2>
      <div class="gauges">
        <div class="gauge"><div class="ring warn"></div><small>今日告警</small></div>
        <div class="gauge"><div class="ring"></div><small>水压</small></div>
        <div class="gauge"><div class="ring"></div><small>消防</small></div>
        <div class="gauge"><div class="ring"></div><small>温感</small></div>
      </div>
    </section>
    <section class="panel">
      <h2>消防设备</h2>
      <div class="equip">
        <div>烟感 <b>622</b></div><div>光电 <b>237</b></div>
        <div>手报 <b>84</b></div><div>喷淋 <b>41</b></div>
      </div>
    </section>
    <section class="panel">
      <h2>园区能耗</h2>
      <svg id="chart" viewBox="0 0 280 72" preserveAspectRatio="none">
        <polyline fill="rgba(47,141,255,0.18)" stroke="#5ce1ff" stroke-width="2"
          points="0,50 40,42 80,48 120,28 160,34 200,18 240,24 280,12 280,72 0,72" />
      </svg>
    </section>
    <section class="panel" style="flex:1">
      <h2>事件告警</h2>
      <table>
        <thead><tr><th>类型</th><th>位置</th><th>状态</th></tr></thead>
        <tbody id="alarm-body">
          <tr><td>烟感</td><td>办公楼 A</td><td class="status-ok">已处理</td></tr>
          <tr><td>门禁</td><td>2号门</td><td class="status-warn">未处理</td></tr>
          <tr><td>能耗</td><td>冷冻站</td><td class="status-ok">已处理</td></tr>
        </tbody>
      </table>
    </section>
  </aside>
  <div id="modes" class="hud">
    <button class="mode active" data-mode="twin"><span>孪生场景</span></button>
    <button class="mode" data-mode="light"><span>照明控制</span></button>
    <button class="mode" data-mode="traffic"><span>人车分流</span></button>
  </div>
  <aside id="target" class="hud panel">
    <button class="close" type="button" id="target-close">关闭</button>
    <h2>目标详情</h2>
    <div class="kpis">
      <div class="kpi"><span>名称</span><b id="t-name">—</b></div>
      <div class="kpi"><span>图层</span><b id="t-layer">—</b></div>
      <div class="kpi"><span>模拟负荷</span><b id="t-load">—</b></div>
      <div class="kpi"><span>在线终端</span><b id="t-term">—</b></div>
    </div>
    <pre id="target-body"></pre>
  </aside>
  <div id="footer" class="hud">LON <b id="hud-lon">—</b> · LAT <b id="hud-lat">—</b> · H <b id="hud-h">—</b> · HDG <b id="hud-hdg">—</b></div>
  <script src="config.js"></script>
  <script>
(function () {
  var SOURCE = ${source};
  var cfg = window.GEOLIBRE_COCKPIT || { title: "", layers: [], skipped: [] };
  var frame = document.getElementById("globe-frame");
  document.getElementById("project-title").textContent = cfg.title || document.title;
  document.getElementById("layer-count").textContent = String((cfg.layers || []).length);

  function tickClock() {
    var d = new Date();
    document.getElementById("clock").textContent = d.toLocaleString();
  }
  tickClock();
  setInterval(tickClock, 1000);

  var list = document.getElementById("layer-list");
  (cfg.layers || []).forEach(function (layer) {
    var row = document.createElement("label");
    row.className = "layer";
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = layer.visible !== false;
    box.addEventListener("change", function () {
      frame.contentWindow.postMessage({ source: SOURCE, type: "set-visible", payload: { id: layer.id, visible: box.checked } }, "*");
    });
    var name = document.createElement("span");
    name.textContent = layer.name;
    var kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = layer.cached ? "CACHE" : layer.type;
    row.append(box, name, kind);
    list.appendChild(row);
  });
  if (cfg.skipped && cfg.skipped.length) {
    var note = document.createElement("div");
    note.style.cssText = "margin-top:8px;font-size:11px;color:var(--warn)";
    note.textContent = cfg.skipped.map(function (s) { return s.name; }).join("、") + " 未进入地球";
    list.appendChild(note);
  }

  document.querySelectorAll(".tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
    });
  });
  document.querySelectorAll(".mode").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".mode").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
    });
  });

  function sim(seed) {
    var n = 0;
    String(seed || "x").split("").forEach(function (c) { n = (n * 33 + c.charCodeAt(0)) >>> 0; });
    return n;
  }
  function openTarget(payload) {
    var props = payload.properties || {};
    var name = props.name || props.Name || payload.featureId || payload.layerName || "未命名目标";
    var s = sim(payload.layerId + name);
    document.getElementById("t-name").textContent = String(name);
    document.getElementById("t-layer").textContent = payload.layerName || payload.layerType || "—";
    document.getElementById("t-load").textContent = ((s % 280) / 10).toFixed(1) + " kW";
    document.getElementById("t-term").textContent = String(12 + (s % 40));
    document.getElementById("target-body").textContent = JSON.stringify(payload, null, 2);
    document.getElementById("target").classList.add("open");
    var alarms = document.getElementById("alarm-body");
    var row = document.createElement("tr");
    row.innerHTML = "<td>拾取</td><td>" + String(name).replace(/[<>]/g, "") + "</td><td class=\\"status-warn\\">查看中</td>";
    alarms.insertBefore(row, alarms.firstChild);
    document.getElementById("alarm-count").textContent = String(alarms.children.length);
    document.getElementById("kpi-pax").textContent = String(1000 + (s % 200));
  }
  document.getElementById("target-close").addEventListener("click", function () {
    document.getElementById("target").classList.remove("open");
  });

  window.addEventListener("message", function (event) {
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === "pick") openTarget(data.payload || {});
    if (data.type === "click") document.getElementById("target").classList.remove("open");
    if (data.type === "ready") document.getElementById("layer-count").textContent = String((data.payload && data.payload.layerCount) || (cfg.layers || []).length);
    if (data.type === "camera" && data.payload && data.payload.position) {
      var p = data.payload.position;
      document.getElementById("hud-lon").textContent = Number(p.longitude).toFixed(4);
      document.getElementById("hud-lat").textContent = Number(p.latitude).toFixed(4);
      document.getElementById("hud-h").textContent = Number(p.height).toFixed(0);
      if (data.payload.heading != null) document.getElementById("hud-hdg").textContent = Number(data.payload.heading).toFixed(1);
    }
  });
})();
  </script>
</body>
</html>
`;
}

export function buildCockpitGlobeHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Globe</title>
  <script>window.CESIUM_BASE_URL = ${JSON.stringify(CESIUM_CDN)};</script>
  <link rel="stylesheet" href="${CESIUM_CDN}Widgets/widgets.css" />
  <style>
    html, body, #cesiumContainer { margin: 0; height: 100%; width: 100%; overflow: hidden; background: #02060e; }
    .cesium-viewer-bottom, .cesium-viewer-animationContainer, .cesium-viewer-timelineContainer,
    .cesium-viewer-toolbar { display: none !important; }
  </style>
</head>
<body>
  <div id="cesiumContainer"></div>
  <script src="${CESIUM_CDN}Cesium.js"></script>
  <script src="config.js"></script>
  <script>
(function () {
  var SOURCE = ${JSON.stringify(COCKPIT_MESSAGE_SOURCE)};
  var cfg = window.GEOLIBRE_COCKPIT || { layers: [], camera: {}, ionToken: "" };

  function post(type, payload) {
    var message = { source: SOURCE, type: type, payload: payload || {} };
    try { window.parent.postMessage(message, "*"); } catch (err) {}
  }

  if (cfg.ionToken) Cesium.Ion.defaultAccessToken = cfg.ionToken;

  var viewer = new Cesium.Viewer("cesiumContainer", {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: true,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    baseLayer: false
  });
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    credit: "© OpenStreetMap"
  }));

  var cam = cfg.camera || {};
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(cam.longitude || 0, cam.latitude || 0, cam.height || 12000000),
    orientation: {
      heading: Cesium.Math.toRadians(cam.heading || 0),
      pitch: Cesium.Math.toRadians(cam.pitch == null ? -90 : cam.pitch),
      roll: 0
    }
  });

  var layerHandles = {};
  var entityLayer = new WeakMap();

  function setVisible(id, visible) {
    var handle = layerHandles[id];
    if (!handle) return;
    if (handle.imagery) handle.imagery.show = visible;
    if (handle.dataSource) handle.dataSource.show = visible;
    if (handle.tileset) handle.tileset.show = visible;
  }

  function cssColor(value, fallback) {
    try { return Cesium.Color.fromCssColorString(value || fallback); }
    catch (err) { return Cesium.Color.fromCssColorString(fallback); }
  }

  async function loadLayer(layer) {
    if (layer.type === "geojson") {
      var ds = await Cesium.GeoJsonDataSource.load(layer.url, {
        clampToGround: true,
        stroke: cssColor(layer.strokeColor, "#5ce1ff"),
        fill: cssColor(layer.fillColor, "rgba(47,141,255,0.35)"),
        strokeWidth: layer.strokeWidth || 2,
        markerColor: cssColor(layer.markerColor || layer.fillColor, "#5ce1ff")
      });
      ds.name = layer.id;
      ds.entities.values.forEach(function (entity) { entityLayer.set(entity, layer); });
      await viewer.dataSources.add(ds);
      ds.show = layer.visible !== false;
      layerHandles[layer.id] = { dataSource: ds };
      return;
    }
    if (layer.type === "3d-tiles") {
      var tileset = await Cesium.Cesium3DTileset.fromUrl(layer.url);
      tileset.geolibreLayer = layer;
      viewer.scene.primitives.add(tileset);
      tileset.show = layer.visible !== false;
      layerHandles[layer.id] = { tileset: tileset };
      return;
    }
    var provider = null;
    if (layer.type === "wms") {
      provider = new Cesium.WebMapServiceImageryProvider({
        url: layer.url,
        layers: layer.wmsLayers || "",
        parameters: { transparent: true, format: layer.wmsFormat || "image/png" }
      });
    } else if (layer.url) {
      provider = new Cesium.UrlTemplateImageryProvider({
        url: layer.url,
        minimumLevel: layer.minzoom || 0,
        maximumLevel: layer.maxzoom || 22
      });
    }
    if (!provider) return;
    var imagery = viewer.imageryLayers.addImageryProvider(provider);
    imagery.alpha = typeof layer.opacity === "number" ? layer.opacity : 1;
    imagery.show = layer.visible !== false;
    layerHandles[layer.id] = { imagery: imagery };
  }

  Promise.all((cfg.layers || []).map(function (layer) {
    return loadLayer(layer).catch(function (err) { console.error(err); });
  })).then(function () {
    post("ready", { title: cfg.title, layerCount: (cfg.layers || []).length });
  });

  function cartographicFromClick(position) {
    var cartesian = viewer.scene.pickPosition(position) || viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid);
    if (!cartesian) return null;
    var carto = Cesium.Cartographic.fromCartesian(cartesian);
    return {
      longitude: Cesium.Math.toDegrees(carto.longitude),
      latitude: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height
    };
  }

  function featureProperties(picked) {
    if (picked instanceof Cesium.Cesium3DTileFeature) {
      var props = {};
      picked.getPropertyIds().forEach(function (id) { props[id] = picked.getProperty(id); });
      var tlayer = picked.tileset && picked.tileset.geolibreLayer;
      return {
        layerId: tlayer && tlayer.id,
        layerName: tlayer && tlayer.name,
        layerType: "3d-tiles",
        featureId: picked.getProperty("id") || picked.getProperty("name") || undefined,
        properties: props
      };
    }
    var entity = picked && picked.id;
    if (entity && entityLayer.has(entity)) {
      var glayer = entityLayer.get(entity);
      var eprops = {};
      if (entity.properties) {
        entity.properties.propertyNames.forEach(function (name) {
          eprops[name] = entity.properties[name] && entity.properties[name].getValue
            ? entity.properties[name].getValue()
            : entity.properties[name];
        });
      }
      return {
        layerId: glayer.id,
        layerName: glayer.name,
        layerType: "geojson",
        featureId: entity.id,
        properties: eprops
      };
    }
    return null;
  }

  viewer.screenSpaceEventHandler.setInputAction(function (click) {
    var position = cartographicFromClick(click.position) || {};
    var picked = viewer.scene.pick(click.position);
    var feature = Cesium.defined(picked) ? featureProperties(picked) : null;
    var payload = Object.assign({ position: position }, feature || {});
    post(feature ? "pick" : "click", payload);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  var lastCam = 0;
  viewer.clock.onTick.addEventListener(function () {
    var now = Date.now();
    if (now - lastCam < 250) return;
    lastCam = now;
    var carto = viewer.camera.positionCartographic;
    post("camera", {
      position: {
        longitude: Cesium.Math.toDegrees(carto.longitude),
        latitude: Cesium.Math.toDegrees(carto.latitude),
        height: carto.height
      },
      heading: Cesium.Math.toDegrees(viewer.camera.heading)
    });
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === "set-visible" && data.payload) setVisible(data.payload.id, data.payload.visible);
  });
})();
  </script>
</body>
</html>
`;
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Build the cockpit ZIP contents from a project. Online imagery / 3D Tiles stay
 * as URLs in `config.js`; local vectors and local/blob 3D Tiles are written
 * under `data/`.
 */
export async function buildCockpitExport(
  options: BuildCockpitExportOptions,
): Promise<{ files: CockpitExportFile[]; config: CockpitConfig }> {
  const project = redactCredentials(options.project);
  const title = (options.title ?? project.name ?? "GeoLibre").trim() || "GeoLibre";
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const layers: CockpitLayer[] = [];
  const skipped: CockpitSkippedLayer[] = [];
  const files: CockpitExportFile[] = [];

  for (const layer of project.layers ?? []) {
    if (layer.type === "geojson") {
      const fc = layerGeoJson(layer);
      if (!fc) {
        skipped.push({ id: layer.id, name: layer.name, reason: "no vector features in memory" });
        continue;
      }
      const rel = `data/geojson/${safeStem(layer.id)}.geojson`;
      files.push({ path: rel, bytes: encoder.encode(`${JSON.stringify(fc)}\n`) });
      layers.push({
        id: layer.id,
        name: layer.name,
        type: "geojson",
        url: rel,
        visible: layer.visible !== false,
        opacity: layer.opacity,
        cached: true,
        fillColor: str(layer.style?.fillColor),
        strokeColor: str(layer.style?.strokeColor),
        strokeWidth: typeof layer.style?.strokeWidth === "number" ? layer.style.strokeWidth : undefined,
        markerColor: str(layer.style?.markerColor),
      });
      continue;
    }

    if (layer.type === "3d-tiles") {
      const url = tilesetUrlOf(layer);
      if (!url) {
        skipped.push({ id: layer.id, name: layer.name, reason: "missing tileset URL" });
        continue;
      }
      if (isRemoteUrl(url) && !isLocalUrl(url)) {
        layers.push({
          id: layer.id,
          name: layer.name,
          type: "3d-tiles",
          url,
          visible: layer.visible !== false,
          opacity: layer.opacity,
          cached: false,
        });
        continue;
      }
      try {
        const dest = `data/tilesets/${safeStem(layer.id)}`;
        const cached = await cacheTilesetTree(url, dest, fetchBytes);
        files.push(...cached);
        layers.push({
          id: layer.id,
          name: layer.name,
          type: "3d-tiles",
          url: `${dest}/tileset.json`,
          visible: layer.visible !== false,
          opacity: layer.opacity,
          cached: true,
        });
      } catch (error) {
        skipped.push({
          id: layer.id,
          name: layer.name,
          reason: error instanceof Error ? error.message : "could not cache 3D Tiles",
        });
      }
      continue;
    }

    if (layer.type === "xyz" || layer.type === "raster" || layer.type === "wmts" || layer.type === "wms") {
      const url = imageryUrlOf(layer);
      if (!url || !isRemoteUrl(url)) {
        skipped.push({
          id: layer.id,
          name: layer.name,
          reason: url ? "local imagery is not bundled (use an online tile URL)" : "missing tile URL",
        });
        continue;
      }
      layers.push({
        id: layer.id,
        name: layer.name,
        type: layer.type,
        url,
        visible: layer.visible !== false,
        opacity: layer.opacity,
        cached: false,
        wmsLayers: str(layer.source.layers),
        wmsFormat: str(layer.source.format),
        minzoom: typeof layer.source.minzoom === "number" ? layer.source.minzoom : undefined,
        maxzoom: typeof layer.source.maxzoom === "number" ? layer.source.maxzoom : undefined,
      });
      continue;
    }

    skipped.push({ id: layer.id, name: layer.name, reason: `layer type ${layer.type} is not shown on the Cesium globe` });
  }

  const config: CockpitConfig = {
    version: 1,
    title,
    ionToken: options.ionToken ?? "",
    camera: cameraFromProject(project),
    layers,
    skipped,
  };

  files.unshift(
    { path: "index.html", bytes: encoder.encode(buildCockpitIndexHtml(title)) },
    { path: "globe.html", bytes: encoder.encode(buildCockpitGlobeHtml()) },
    { path: "config.js", bytes: encoder.encode(serializeCockpitConfigJs(config)) },
  );

  return { files, config };
}
