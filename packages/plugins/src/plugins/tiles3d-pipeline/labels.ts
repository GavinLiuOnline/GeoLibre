/** User-facing strings for the 3D Tiles pipeline workbench. */

export interface Tiles3dPipelineLabels {
  title: string;
  getTitle?: () => string;
  menu: string;
  open: string;
  intro: string;
  stepImport: string;
  stepRegister: string;
  stepOptimize: string;
  stepExport: string;
  chooseFile: string;
  chooseFolder: string;
  formatsHint: string;
  file: string;
  kind: string;
  kindMesh: string;
  kindPoints: string;
  kindTileset: string;
  vertices: string;
  triangles: string;
  registerHint: string;
  registerModeCrs: string;
  registerModeGcp: string;
  crsPreset: string;
  crsEnu: string;
  crsWgs84Utm: string;
  crsWebMercator: string;
  crsAlbersChina: string;
  crsCgcs2000Gk3: string;
  crsCgcs2000Gk6: string;
  crsBj54Gk3: string;
  crsBj54Gk6: string;
  crsCustom: string;
  crsZone: string;
  crsZoneInEasting: string;
  crsOffsetX: string;
  crsOffsetY: string;
  crsOffsetZ: string;
  crsCustomProj4: string;
  crsPasteHint?: string;
  crsParamsTitle: string;
  crsParamLabel?: (key: string) => string;
  crsModelProjected: string;
  crsApply: string;
  crsApplied: string;
  crsNeedOrigin: string;
  crsFailed: string;
  addGcp: string;
  removeGcp: string;
  fitGcps: string;
  modelX: string;
  modelY: string;
  modelZ: string;
  longitude: string;
  latitude: string;
  height: string;
  heading: string;
  pitch: string;
  roll: string;
  scale: string;
  pickOrigin: string;
  pickingOrigin: string;
  optimizeHint: string;
  weldEpsilon: string;
  reduction: string;
  lodLevels: string;
  quantize: string;
  qaTitle: string;
  bounds: string;
  residualRms: string;
  gcpCount: string;
  lodLevel: string;
  exportHint: string;
  exportZip: string;
  addTileset: string;
  importFirst: string;
  gcpFitFailed: string;
  gcpFitted: string;
  layerAdded: string;
  exported: string;
  tilesetAdded: string;
  pickCancelled: string;
}

const DEFAULT_PROJ4_PARAM_NAMES: Record<string, string> = {
  proj: "proj (projection)",
  lat_0: "lat_0 (latitude of origin, °)",
  lat_1: "lat_1 (standard parallel 1, °)",
  lat_2: "lat_2 (standard parallel 2, °)",
  lat_ts: "lat_ts (true scale latitude, °)",
  lon_0: "lon_0 (central meridian, °)",
  lon_1: "lon_1 (°)",
  lon_2: "lon_2 (°)",
  x_0: "x_0 (false easting, m)",
  y_0: "y_0 (false northing, m)",
  k: "k (scale factor)",
  k_0: "k_0 (scale factor)",
  zone: "zone",
  south: "south (southern hemisphere)",
  datum: "datum",
  ellps: "ellps (ellipsoid)",
  a: "a (semi-major axis, m)",
  b: "b (semi-minor axis, m)",
  rf: "rf (inverse flattening)",
  units: "units",
  no_defs: "no_defs",
  towgs84: "towgs84",
  nadgrids: "nadgrids",
  pm: "pm (prime meridian)",
  axis: "axis",
};

/** Fallback caption for a proj4 `+key` when the catalog has no translation. */
export function defaultProj4ParamLabel(key: string): string {
  return DEFAULT_PROJ4_PARAM_NAMES[key] ?? `+${key}`;
}

export const DEFAULT_TILES3D_PIPELINE_LABELS: Tiles3dPipelineLabels = {
  title: "3D Tiles Pipeline",
  menu: "3D Tiles",
  open: "Open 3D Tiles Pipeline",
  intro:
    "Import a mesh, point cloud, or oblique folder; it is added as a layer. Register it with a local CRS or GCPs, then optimize and export OGC 3D Tiles.",
  stepImport: "1. Import",
  stepRegister: "2. Register",
  stepOptimize: "3. Optimize",
  stepExport: "4. Export",
  chooseFile: "Choose file…",
  chooseFolder: "Choose folder…",
  formatsHint:
    "GLB, glTF (+ .bin), OBJ, STL, PLY, uncompressed LAS, a 3D Tiles folder (tileset.json), or an oblique/OSGB folder with metadata.xml plus OBJ/GLB or tileset.json.",
  file: "File",
  kind: "Kind",
  kindMesh: "Mesh",
  kindPoints: "Point cloud",
  kindTileset: "3D Tiles",
  vertices: "Vertices",
  triangles: "Triangles",
  registerHint:
    "Engineering drawings and RTK surveys use a local projected CRS (CGCS2000 / Beijing 1954 / WGS84 Gauss-Kruger or UTM). Convert Cartesian metres to longitude/latitude, or fit ground control points. Registration and positioning are the same step.",
  registerModeCrs: "Coordinate system",
  registerModeGcp: "Ground control",
  crsPreset: "CRS",
  crsEnu: "WGS84 / CGCS2000 lon/lat (ENU origin)",
  crsWgs84Utm: "WGS84 UTM",
  crsWebMercator: "Web Mercator (EPSG:3857)",
  crsAlbersChina: "Albers China (25°/47°, 105°E)",
  crsCgcs2000Gk3: "CGCS2000 3° Gauss-Kruger",
  crsCgcs2000Gk6: "CGCS2000 6° Gauss-Kruger",
  crsBj54Gk3: "Beijing 1954 3° Gauss-Kruger",
  crsBj54Gk6: "Beijing 1954 6° Gauss-Kruger",
  crsCustom: "Custom proj4",
  crsZone: "Zone",
  crsZoneInEasting: "Zone prefix in easting (带号)",
  crsOffsetX: "False easting / origin X (m)",
  crsOffsetY: "False northing / origin Y (m)",
  crsOffsetZ: "Height offset (m)",
  crsCustomProj4: "proj4 / EPSG",
  crsPasteHint:
    "Paste a proj4 string or EPSG code (EPSG:32650, EPSG:3857). Every +key=value is shown below and filled automatically.",
  crsParamsTitle: "proj4 parameters",
  crsParamLabel: defaultProj4ParamLabel,
  crsModelProjected: "Model XY are already projected metres",
  crsApply: "Apply coordinate system",
  crsApplied: "Placement updated from the coordinate system.",
  crsNeedOrigin:
    "Converted the CRS origin, not a site location. Import the 3D file so model XY can be converted, or enter the site easting/northing (metres).",
  crsFailed: "Could not convert the local coordinates. Check CRS, zone, and offsets.",
  addGcp: "Add GCP",
  removeGcp: "Remove",
  fitGcps: "Fit placement from GCPs",
  modelX: "Model X",
  modelY: "Model Y",
  modelZ: "Model Z",
  longitude: "Longitude",
  latitude: "Latitude",
  height: "Height (m)",
  heading: "Heading (°)",
  pitch: "Pitch (°)",
  roll: "Roll (°)",
  scale: "Scale",
  pickOrigin: "Click map for origin",
  pickingOrigin: "Click the map…",
  optimizeHint: "Weld coincident vertices, thin the mesh or cloud, and build a REPLACE LOD pyramid.",
  weldEpsilon: "Weld epsilon (m)",
  reduction: "Keep fraction",
  lodLevels: "LOD levels",
  quantize: "Quantize positions",
  qaTitle: "QA report",
  bounds: "Bounds",
  residualRms: "GCP RMS",
  gcpCount: "GCPs",
  lodLevel: "LOD",
  exportHint: "Download a tileset.zip (tileset.json + tiles) or add the optimized tileset as a 3D Tiles layer.",
  exportZip: "Export 3D Tiles zip",
  addTileset: "Add as 3D Tiles layer",
  importFirst: "Import a 3D file first.",
  gcpFitFailed: "Could not fit GCPs (need 1 point, or 3+ non-degenerate points).",
  gcpFitted: "Placement updated from GCPs.",
  layerAdded: "Added as a layer in the current project.",
  exported: "Exported 3D Tiles zip.",
  tilesetAdded: "Added the tileset as a 3D Tiles layer.",
  pickCancelled: "Map pick cancelled.",
};
