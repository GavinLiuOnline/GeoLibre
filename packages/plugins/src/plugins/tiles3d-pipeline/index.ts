/**
 * 3D Tiles pipeline plugin: import → register (CRS or GCPs) → optimize → export.
 * Imported data is added as a layer immediately; registration updates that layer.
 */

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { FeatureCollection, Point } from "geojson";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../../types";
import { TILES3D_PIPELINE_PLUGIN_ID } from "../../plugin-ids";
import { DEFAULT_DECK_VIZ_STYLE, type DeckVizConfig } from "../deckgl-viz/registry";
import { createDeckVizStoreLayer } from "../deckgl-viz/store-layer";
import { restoreThreeDTilesLayers, THREE_D_TILES_SOURCE_KIND } from "../maplibre-3d-tiles";
import {
  bboxLooksProjected,
  normalizeLocalCrsSettings,
  parseCrsInput,
  placementFromLocalCrs,
  proj4FromLocalCrs,
  proj4StringForParams,
  removeProj4Param,
  updateProj4Param,
} from "./crs";
import { applyMeshOptimize, bboxCenter, normalizeOptimizeOptions, shiftScene } from "./import-scene";
import { dirnameOf, importBundle, joinPath, type NamedBytes } from "./import-bundle";
import { DEFAULT_TILES3D_PIPELINE_LABELS, type Tiles3dPipelineLabels } from "./labels";

import { writeGlb } from "./mesh";
import { applyObliqueMetadata } from "./oblique";
import { renderPipelinePanel } from "./panel";
import { buildQaReport } from "./qa";
import { buildTileset, rewriteTilesetUris, tilesetGeographicBounds } from "./tileset";
import {
  fitPlacementFromGcps,
  geographicBounds,
  lngLatHeightFromEcef,
  normalizePlacement,
  tilesetTransform,
  transformPoint,
} from "./transforms";
import type {
  ImportedScene,
  LocalCrsSettings,
  ModelGcp,
  OptimizeOptions,
  PipelineStep,
  Placement,
  QaReport,
  RegisterMode,
  TilesetFile,
} from "./types";
import { DEFAULT_LOCAL_CRS, DEFAULT_OPTIMIZE_OPTIONS, DEFAULT_PLACEMENT, sceneIsYUp } from "./types";
import { buildZip } from "./zip";

export { TILES3D_PIPELINE_PLUGIN_ID };
export type { Tiles3dPipelineLabels };
export { DEFAULT_TILES3D_PIPELINE_LABELS, defaultProj4ParamLabel } from "./labels";

const PANEL_ID = "geolibre-3d-pipeline-panel";
const MENU_ID = "geolibre-3d-pipeline-menu";
const LIVE_LAYER_ID = "geolibre-3d-pipeline-layer";
const TILESET_LAYER_ID = "geolibre-3d-pipeline-tileset";

let labels: Tiles3dPipelineLabels = { ...DEFAULT_TILES3D_PIPELINE_LABELS };
let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let unregisterMenu: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let localeUnsub: (() => void) | null = null;

let step: PipelineStep = "import";
let scene: ImportedScene | null = null;
let importedTileset: { name: string; files: TilesetFile[] } | null = null;
let gcps: ModelGcp[] = [];
let placement: Placement = { ...DEFAULT_PLACEMENT };
let crs: LocalCrsSettings = { ...DEFAULT_LOCAL_CRS };
let registerMode: RegisterMode = "crs";
let sceneShift: [number, number, number] = [0, 0, 0];
let options: OptimizeOptions = { ...DEFAULT_OPTIMIZE_OPTIONS };
let pickOrigin = false;
let status = "";
let qa: QaReport | null = null;
let lastExport: { files: TilesetFile[]; bounds: [number, number, number, number] } | null = null;
let objectUrls: string[] = [];
let clickHandler: ((event: MapMouseEvent) => void) | null = null;
let boundMap: MapLibreMap | null = null;
let residualRmsMeters: number | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let liveGlbUrl: string | null = null;

type ZipSaver = (blob: Blob, defaultName: string) => Promise<string | null>;
let zipSaver: ZipSaver | null = null;

/** Injected by the desktop host so zip export uses a native save dialog. */
export function setTiles3dPipelineZipSaver(saver: ZipSaver | null): void {
  zipSaver = saver;
}

export function setTiles3dPipelineLabels(next: Partial<Tiles3dPipelineLabels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) render();
}

function revokeObjectUrls(): void {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  liveGlbUrl = null;
}

function rememberUrl(url: string): string {
  objectUrls.push(url);
  return url;
}

function setStatus(message: string): void {
  status = message;
  render();
}

function workingScene(): ImportedScene | null {
  if (!scene) return null;
  return shiftScene(applyMeshOptimize(scene, options), sceneShift[0], sceneShift[1], sceneShift[2]);
}

function currentQa(): QaReport | null {
  const current = workingScene();
  if (!current) return null;
  return buildQaReport(current, placement, options, gcps.length, residualRmsMeters);
}

function panelKind(): "mesh" | "points" | "tileset" | null {
  if (importedTileset && !scene) return "tileset";
  return scene?.kind ?? null;
}

function panelModel() {
  return {
    step,
    fileName: scene?.name ?? importedTileset?.name ?? null,
    kind: panelKind(),
    vertexCount: scene?.vertexCount ?? 0,
    triangleCount: scene?.triangleCount ?? 0,
    registerMode,
    crs,
    gcps,
    placement,
    weldEpsilon: options.weldEpsilon,
    reduction: options.reduction,
    lodLevels: options.lodLevels,
    quantize: options.quantize,
    pickOrigin,
    status,
    qa,
    labels,
  };
}

function render(): void {
  if (!panelContainer) return;
  renderPipelinePanel(panelContainer, panelModel(), {
    onStep: (next) => {
      step = next;
      if (next === "export") qa = currentQa();
      render();
    },
    onPickFile: () => void pickFiles(false),
    onPickFolder: () => void pickFiles(true),
    onRegisterMode: (mode) => {
      registerMode = mode;
      render();
    },
    onCrs: (patch) => {
      const merged = { ...crs, ...patch };
      if (merged.preset !== "custom" && merged.preset !== "enu") {
        const generated = proj4FromLocalCrs(normalizeLocalCrsSettings(merged, crs));
        if (generated) merged.customProj4 = generated;
      }
      crs = normalizeLocalCrsSettings(merged, crs);
      render();
    },
    onCrsDefinition: (raw) => applyCrsDefinition(raw),
    onProj4Param: (key, value, flag) => applyProj4Param(key, value, flag),
    onApplyCrs: () => applyCrs(),
    onPlacement: (patch) => {
      placement = normalizePlacement({ ...placement, ...patch });
      scheduleSync(false);
      render();
    },
    onOptimize: (patch) => {
      options = normalizeOptimizeOptions({ ...options, ...patch });
      scheduleSync(false);
      render();
    },
    onAddGcp: () => {
      gcps = [
        ...gcps,
        {
          id: `gcp-${gcps.length + 1}`,
          modelX: 0,
          modelY: 0,
          modelZ: 0,
          longitude: placement.longitude,
          latitude: placement.latitude,
          height: placement.height,
        },
      ];
      render();
    },
    onRemoveGcp: (id) => {
      gcps = gcps.filter((g) => g.id !== id);
      render();
    },
    onGcpChange: (id, patch) => {
      gcps = gcps.map((g) => (g.id === id ? { ...g, ...patch } : g));
      render();
    },
    onFitGcps: () => {
      const fit = fitPlacementFromGcps(gcps);
      if (!fit) {
        setStatus(labels.gcpFitFailed);
        return;
      }
      placement = fit.placement;
      residualRmsMeters = fit.residualRmsMeters;
      sceneShift = [0, 0, 0];
      void syncLiveLayer(true);
      setStatus(labels.gcpFitted);
    },
    onTogglePickOrigin: () => togglePickOrigin(),
    onExport: () => void exportZip(),
    onAddTileset: () => void addExportedTileset(),
  });
}

function scheduleSync(fit: boolean): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncLiveLayer(fit), 250);
}

async function filesFromList(list: FileList): Promise<NamedBytes[]> {
  const out: NamedBytes[] = [];
  for (const file of Array.from(list)) {
    const name = file.webkitRelativePath || file.name;
    out.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return out;
}

async function pickFiles(folder: boolean): Promise<void> {
  const input = document.createElement("input");
  input.type = "file";
  if (folder) {
    input.setAttribute("webkitdirectory", "");
    input.multiple = true;
  } else {
    input.accept = ".glb,.gltf,.obj,.stl,.ply,.las,.osgb,.xml,.json,.3mx,.bin";
    input.multiple = true;
  }
  input.addEventListener("change", async () => {
    const list = input.files;
    if (!list?.length) {
      setStatus(labels.pickCancelled);
      return;
    }
    try {
      await ingestFiles(await filesFromList(list));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  });
  input.click();
}

async function ingestFiles(files: NamedBytes[]): Promise<void> {
  const bundle = importBundle(files);
  residualRmsMeters = null;
  lastExport = null;
  qa = null;
  sceneShift = [0, 0, 0];
  removeLiveLayers();
  revokeObjectUrls();

  if (bundle.metadata) {
    const applied = applyObliqueMetadata(bundle.metadata, placement, crs);
    placement = normalizePlacement(applied.placement, placement);
    crs = applied.crs;
    if (applied.applied === "projected") registerMode = "crs";
  }

  if (bundle.kind === "tileset") {
    scene = null;
    importedTileset = { name: bundle.name, files: bundle.files };
    addTilesetLayer(bundle.files, bundle.name);
    step = "export";
    qa = null;
    setStatus(`${bundle.name} · ${labels.layerAdded}`);
    return;
  }

  importedTileset = null;
  scene = bundle.scene;
  if (crs.preset !== "enu") {
    try {
      applyCrs(false);
    } catch {
      // Leave placement as metadata / default; layer still added.
    }
  }
  step = "register";
  await syncLiveLayer(true);
  setStatus(`${scene.name} · ${labels.layerAdded}`);
}

function applyProj4Param(key: string, value: string, flag?: boolean): void {
  const current = proj4StringForParams(crs);
  const next =
    flag === false
      ? removeProj4Param(current, key)
      : updateProj4Param(current, key, value, flag === true);
  applyCrsDefinition(next);
}

function applyCrsDefinition(raw: string): void {
  const parsed = parseCrsInput(raw);
  if (!parsed) {
    crs = normalizeLocalCrsSettings({ ...crs, customProj4: raw }, crs);
    render();
    return;
  }
  crs = normalizeLocalCrsSettings({ ...crs, customProj4: raw, ...parsed }, crs);
  if (crs.preset === "enu") {
    render();
    return;
  }
  applyCrs();
}

function applyCrs(sync = true): void {
  try {
    const bbox = scene?.kind === "mesh" ? scene.mesh?.bbox : scene?.points?.bbox;
    const useModelXy =
      crs.modelIsProjected ||
      (bbox !== undefined &&
        (bboxLooksProjected(bbox) ||
          crs.preset === "web-mercator" ||
          crs.preset === "albers-china" ||
          crs.preset === "custom"));
    if (useModelXy && bbox && !crs.modelIsProjected) {
      crs = { ...crs, modelIsProjected: true };
    }
    const origin =
      useModelXy && bbox ? bboxCenter(bbox) : ([0, 0, 0] as [number, number, number]);
    placement = placementFromLocalCrs(crs, origin[0], origin[1], origin[2], placement);
    sceneShift = useModelXy && bbox ? origin : [0, 0, 0];
    residualRmsMeters = null;
    if (sync && scene) void syncLiveLayer(true);
    const usedGridOrigin =
      Math.hypot(origin[0], origin[1]) < 1 && Math.hypot(crs.offsetX, crs.offsetY) < 1;
    if (usedGridOrigin) {
      setStatus(
        `${labels.crsNeedOrigin} (${placement.longitude.toFixed(4)}, ${placement.latitude.toFixed(4)})`,
      );
    } else {
      setStatus(
        `${labels.crsApplied} ${placement.longitude.toFixed(6)}, ${placement.latitude.toFixed(6)}`,
      );
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : labels.crsFailed);
  }
}

function togglePickOrigin(): void {
  const map = appRef?.getMap?.() ?? null;
  if (pickOrigin) {
    if (map && clickHandler) map.off("click", clickHandler);
    clickHandler = null;
    pickOrigin = false;
    boundMap = null;
    render();
    return;
  }
  if (!map) return;
  pickOrigin = true;
  boundMap = map;
  clickHandler = (event: MapMouseEvent) => {
    placement = normalizePlacement({
      ...placement,
      longitude: event.lngLat.lng,
      latitude: event.lngLat.lat,
    });
    pickOrigin = false;
    map.off("click", clickHandler!);
    clickHandler = null;
    boundMap = null;
    void syncLiveLayer(true);
    render();
  };
  map.on("click", clickHandler);
  render();
}

function removeLiveLayers(): void {
  const store = useAppStore.getState();
  store.removeLayer(LIVE_LAYER_ID);
  store.removeLayer(TILESET_LAYER_ID);
}

function addTilesetLayer(files: TilesetFile[], name: string): void {
  if (!appRef) return;
  const mounted = mountTilesetFiles(files);
  const id = TILESET_LAYER_ID;
  const layer: GeoLibreLayer = {
    id,
    name,
    type: "3d-tiles",
    source: { type: "3d-tiles", url: mounted.url, sourceId: id, altitudeOffset: 0 },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: THREE_D_TILES_SOURCE_KIND,
      customLayerType: "3d-tiles",
      externalNativeLayer: true,
      identifiable: false,
      sourceId: id,
      nativeLayerIds: [`geolibre-3d-tiles-${id}`],
      altitudeOffset: 0,
      panelCollapsed: true,
      ...(mounted.bounds ? { bounds: mounted.bounds } : {}),
    },
    sourcePath: mounted.url,
  };
  useAppStore.getState().addLayer(layer);
  restoreThreeDTilesLayers(appRef);
  if (mounted.bounds) appRef.fitBounds?.(mounted.bounds);
}

function mountTilesetFiles(files: TilesetFile[]): {
  url: string;
  bounds: [number, number, number, number] | null;
} {
  const urls = new Map<string, string>();
  const jsonFiles = files.filter((file) => file.path.toLowerCase().endsWith(".json"));
  const other = files.filter((file) => !file.path.toLowerCase().endsWith(".json"));
  for (const file of other) {
    const type = file.path.endsWith(".glb") ? "model/gltf-binary" : "application/octet-stream";
    urls.set(
      file.path.replace(/\\/g, "/"),
      rememberUrl(URL.createObjectURL(new Blob([file.bytes as BlobPart], { type }))),
    );
  }
  jsonFiles.sort((a, b) => b.path.split("/").length - a.path.split("/").length);
  let rootBounds: [number, number, number, number] | null = null;
  for (const file of jsonFiles) {
    const path = file.path.replace(/\\/g, "/");
    const text = new TextDecoder().decode(file.bytes);
    const dir = dirnameOf(path);
    const rewritten = rewriteTilesetUris(text, (rel) => {
      const abs = joinPath(dir, rel);
      return urls.get(abs) ?? urls.get(rel) ?? rel;
    });
    urls.set(path, rememberUrl(URL.createObjectURL(new Blob([rewritten], { type: "application/json" }))));
    if (!rootBounds) rootBounds = tilesetGeographicBounds(text);
  }
  const root =
    files.find((file) => (file.path.split("/").pop() ?? "").toLowerCase() === "tileset.json") ?? jsonFiles[jsonFiles.length - 1];
  const url = root ? urls.get(root.path.replace(/\\/g, "/")) : undefined;
  if (!url) throw new Error("tileset.json missing from import.");
  return { url, bounds: rootBounds };
}

async function syncLiveLayer(fit: boolean): Promise<void> {
  const current = workingScene();
  if (!current || !appRef) return;
  const store = useAppStore.getState();
  store.removeLayer(LIVE_LAYER_ID);
  const yUp = sceneIsYUp(current.sourceFormat);
  const bbox = current.kind === "mesh" ? current.mesh!.bbox : current.points!.bbox;
  const bounds = geographicBounds(bbox, placement, yUp);
  qa = currentQa();

  if (current.kind === "mesh" && current.mesh) {
    const glb =
      current.originalGlb && options.reduction >= 1 && options.weldEpsilon === 0 && !options.quantize && sceneShift.every((n) => n === 0)
        ? current.originalGlb
        : writeGlb(current.mesh);
    if (liveGlbUrl) {
      URL.revokeObjectURL(liveGlbUrl);
      objectUrls = objectUrls.filter((url) => url !== liveGlbUrl);
    }
    const url = rememberUrl(URL.createObjectURL(new Blob([glb as BlobPart], { type: "model/gltf-binary" })));
    liveGlbUrl = url;
    const config: DeckVizConfig = {
      layerKind: "scenegraph",
      format: "csv-rows",
      fieldMapping: { lng: "lng", lat: "lat", altitude: "altitude", bearing: "bearing", scale: "scale" },
      style: DEFAULT_DECK_VIZ_STYLE,
      scenegraph: {
        modelUrl: url,
        sizeScale: 1,
        sizeMinPixels: 0,
        bearing: 0,
        translation: [0, 0, 0],
        altitude: 0,
      },
    };
    store.addLayer(
      createDeckVizStoreLayer({
        id: LIVE_LAYER_ID,
        name: current.name,
        config,
        rows: [
          {
            lng: placement.longitude,
            lat: placement.latitude,
            altitude: placement.height,
            bearing: placement.heading,
            scale: placement.scale,
          },
        ],
        sourcePath: current.name,
        bounds,
      }),
    );
  } else if (current.points) {
    const m = tilesetTransform(placement, false);
    const max = Math.min(12_000, current.points.positions.length / 3);
    const stepN = Math.max(1, Math.floor(current.points.positions.length / 3 / max));
    const features: FeatureCollection<Point>["features"] = [];
    for (let i = 0; i < current.points.positions.length / 3; i += stepN) {
      const x = current.points.positions[i * 3];
      const y = current.points.positions[i * 3 + 1];
      const z = current.points.positions[i * 3 + 2];
      const ecef = transformPoint(m, x, y, z);
      const g = lngLatHeightFromEcef(ecef[0], ecef[1], ecef[2]);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [g.longitude, g.latitude] },
        properties: { height: g.height },
      });
    }
    store.addLayer({
      id: LIVE_LAYER_ID,
      name: current.name,
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE, circleRadius: 3, fillColor: "#38bdf8" },
      metadata: { bounds },
      geojson: { type: "FeatureCollection", features },
      sourcePath: current.name,
    });
  }

  if (fit) appRef.fitBounds?.(bounds);
}

function ensureExport() {
  if (importedTileset && !scene) {
    const tilesetFile = importedTileset.files.find((file) => (file.path.split("/").pop() ?? "").toLowerCase() === "tileset.json");
    const bounds = tilesetFile
      ? tilesetGeographicBounds(new TextDecoder().decode(tilesetFile.bytes)) ?? ([-180, -90, 180, 90] as [number, number, number, number])
      : ([-180, -90, 180, 90] as [number, number, number, number]);
    lastExport = { files: importedTileset.files, bounds };
    return lastExport;
  }
  const current = workingScene();
  if (!current) throw new Error(labels.importFirst);
  const exported = buildTileset(current, placement, options);
  lastExport = exported;
  return exported;
}

async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  if (zipSaver) {
    await zipSaver(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportZip(): Promise<void> {
  try {
    const exported = ensureExport();
    const zip = buildZip(exported.files);
    const stem = (scene?.name ?? importedTileset?.name ?? "tileset").replace(/\.[^.]+$/, "");
    await downloadBlob(new Blob([zip as BlobPart], { type: "application/zip" }), `${stem}-3dtiles.zip`);
    setStatus(labels.exported);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

async function addExportedTileset(): Promise<void> {
  if (!appRef) return;
  try {
    const exported = lastExport ?? ensureExport();
    removeLiveLayers();
    revokeObjectUrls();
    addTilesetLayer(exported.files, `${scene?.name ?? importedTileset?.name ?? "3D Tiles"} tileset`);
    appRef.fitBounds?.(exported.bounds);
    setStatus(labels.tilesetAdded);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

function registerUi(app: GeoLibreAppAPI): void {
  unregisterPanel =
    app.registerRightPanel?.({
      id: PANEL_ID,
      title: () => labels.getTitle?.() ?? labels.title,
      dock: "replace-style",
      defaultWidth: 380,
      render: (container) => {
        panelContainer = container;
        render();
        return () => {
          if (panelContainer === container) panelContainer = null;
        };
      },
    }) ?? null;
  unregisterMenu =
    app.registerToolbarMenu?.({
      id: MENU_ID,
      label: () => labels.menu,
      items: [
        {
          id: "open",
          label: () => labels.open,
          onSelect: () => app.openRightPanel?.(PANEL_ID),
        },
      ],
    }) ?? null;
  app.openRightPanel?.(PANEL_ID);
}

function teardown(app: GeoLibreAppAPI): void {
  if (syncTimer) clearTimeout(syncTimer);
  if (boundMap && clickHandler) boundMap.off("click", clickHandler);
  clickHandler = null;
  boundMap = null;
  pickOrigin = false;
  removeLiveLayers();
  revokeObjectUrls();
  app.closeRightPanel?.(PANEL_ID);
  unregisterPanel?.();
  unregisterMenu?.();
  unregisterPanel = null;
  unregisterMenu = null;
  localeUnsub?.();
  localeUnsub = null;
  panelContainer = null;
}

function coerceStep(value: unknown): PipelineStep {
  if (value === "import" || value === "register" || value === "optimize" || value === "export") return value;
  if (value === "position") return "register";
  if (value === "preview") return "export";
  return step;
}

export const maplibreTiles3dPipelinePlugin: GeoLibrePlugin = {
  id: TILES3D_PIPELINE_PLUGIN_ID,
  name: "3D Tiles Pipeline",
  version: "0.2.0",
  activate: (app: GeoLibreAppAPI) => {
    appRef = app;
    registerUi(app);
    localeUnsub =
      app.onLocaleChange?.(() => {
        render();
      }) ?? null;
  },
  deactivate: (app: GeoLibreAppAPI) => {
    teardown(app);
    appRef = null;
  },
  getProjectState: () => {
    if (!scene && !importedTileset && gcps.length === 0) {
      const p = placement;
      const d = DEFAULT_PLACEMENT;
      if (
        p.longitude === d.longitude &&
        p.latitude === d.latitude &&
        p.height === d.height &&
        p.heading === d.heading &&
        p.scale === d.scale
      ) {
        return undefined;
      }
    }
    return {
      step,
      fileName: scene?.name ?? importedTileset?.name ?? null,
      kind: panelKind(),
      placement,
      gcps,
      options,
      crs,
      registerMode,
    };
  },
  applyProjectState: (app, state) => {
    if (!state || typeof state !== "object") return false;
    const rec = state as Record<string, unknown>;
    step = coerceStep(rec.step);
    placement = normalizePlacement(rec.placement, placement);
    options = normalizeOptimizeOptions(rec.options);
    crs = normalizeLocalCrsSettings(rec.crs, crs);
    if (rec.registerMode === "crs" || rec.registerMode === "gcp") registerMode = rec.registerMode;
    if (Array.isArray(rec.gcps)) {
      gcps = rec.gcps.filter((g): g is ModelGcp => !!g && typeof g === "object" && typeof (g as ModelGcp).id === "string");
    }
    if (!appRef) {
      appRef = app;
      registerUi(app);
    }
    render();
    return true;
  },
};
