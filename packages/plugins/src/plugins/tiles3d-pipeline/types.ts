/**
 * Domain types for the 3D Tiles pipeline: imported meshes and point clouds,
 * geographic placement, ground-control registration, and export options.
 *
 * Kept free of MapLibre/DOM so the conversion math can be unit-tested in Node.
 */

/** Local-space axis-aligned bounding box. */
export interface BBox3 {
  min: [number, number, number];
  max: [number, number, number];
}

/** A triangle mesh in local meters (glTF Y-up when sourced from glTF/GLB). */
export interface MeshData {
  /** Interleaved xyz positions (meters). */
  positions: Float32Array;
  /** Optional interleaved xyz normals. */
  normals?: Float32Array;
  /** Optional interleaved rgb bytes, 0–255. */
  colors?: Uint8Array;
  /** Triangle indices; omitted for non-indexed triangle lists. */
  indices?: Uint32Array;
  bbox: BBox3;
}

/** An unstructured point cloud in local meters. */
export interface PointCloudData {
  positions: Float32Array;
  colors?: Uint8Array;
  bbox: BBox3;
}

export type SourceFormat = "glb" | "gltf" | "obj" | "las" | "stl" | "ply" | "osgb" | "tileset";

/** glTF / GLB (and Collada) are Y-up; OBJ / STL / PLY / LAS / OSGB are Z-up. */
export function sceneIsYUp(format: SourceFormat): boolean {
  return format === "glb" || format === "gltf";
}

/** A loaded 3D dataset before geographic placement. */
export interface ImportedScene {
  kind: "mesh" | "points";
  name: string;
  sourceFormat: SourceFormat;
  mesh?: MeshData;
  points?: PointCloudData;
  /**
   * Original GLB bytes, kept so a transform-only export can wrap the authored
   * file instead of re-encoding (which would drop materials/textures).
   */
  originalGlb?: Uint8Array;
  vertexCount: number;
  triangleCount: number;
}

/** Geographic origin + rigid transform applied in a local ENU frame. */
export interface Placement {
  /** Longitude in degrees, WGS84. */
  longitude: number;
  /** Latitude in degrees, WGS84. */
  latitude: number;
  /** Ellipsoidal height in meters. */
  height: number;
  /** Heading in degrees clockwise from north (yaw about Up). */
  heading: number;
  /** Pitch in degrees (tilt about East). */
  pitch: number;
  /** Roll in degrees (bank about North). */
  roll: number;
  /** Uniform scale applied in local meters. */
  scale: number;
}

export const DEFAULT_PLACEMENT: Placement = {
  longitude: 0,
  latitude: 0,
  height: 0,
  heading: 0,
  pitch: 0,
  roll: 0,
  scale: 1,
};

/**
 * A ground control point linking a local model coordinate to a geographic
 * position. Three or more non-degenerate GCPs fit a 3D similarity transform.
 */
export interface ModelGcp {
  id: string;
  modelX: number;
  modelY: number;
  modelZ: number;
  longitude: number;
  latitude: number;
  height: number;
}

export interface OptimizeOptions {
  /** Weld vertices closer than this (meters). 0 disables. */
  weldEpsilon: number;
  /** Target triangle/point fraction in (0, 1]; 1 keeps the source density. */
  reduction: number;
  /** Number of LOD levels to emit (1 = a single tile, no pyramid). */
  lodLevels: number;
  /** Quantize positions to 16-bit in the bounding box. */
  quantize: boolean;
}

export const DEFAULT_OPTIMIZE_OPTIONS: OptimizeOptions = {
  weldEpsilon: 0,
  reduction: 1,
  lodLevels: 3,
  quantize: false,
};

export interface QaIssue {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface QaReport {
  name: string;
  kind: "mesh" | "points";
  sourceFormat: SourceFormat;
  vertexCount: number;
  triangleCount: number;
  bbox: BBox3;
  geographicBounds?: [number, number, number, number];
  placement: Placement;
  gcpCount: number;
  residualRmsMeters: number | null;
  lodLevels: { level: number; vertices: number; triangles: number; geometricError: number }[];
  issues: QaIssue[];
}

/** One file in an exported 3D Tiles tileset (relative path + bytes). */
export interface TilesetFile {
  path: string;
  bytes: Uint8Array;
}

export interface TilesetExport {
  files: TilesetFile[];
  /** Geographic `[west, south, east, north]` of the root tile. */
  bounds: [number, number, number, number];
  geometricError: number;
}

export type PipelineStep = "import" | "register" | "optimize" | "export";

export const PIPELINE_STEPS: readonly PipelineStep[] = ["import", "register", "optimize", "export"];

/** How the dataset is pinned to the ellipsoid: a local CRS, or ground control points. */
export type RegisterMode = "crs" | "gcp";

/**
 * Engineering / RTK local coordinate system. Model metres are converted to
 * WGS84 lon/lat via Gauss-Kruger, UTM, or a custom proj4 string.
 */
export type CrsPreset =
  | "enu"
  | "wgs84-utm"
  | "web-mercator"
  | "albers-china"
  | "cgcs2000-gk3"
  | "cgcs2000-gk6"
  | "bj54-gk3"
  | "bj54-gk6"
  | "custom";

export interface LocalCrsSettings {
  preset: CrsPreset;
  /** Gauss-Kruger 3° zone 25–45, 6° zone 13–23, or UTM 1–60. */
  zone: number;
  /** When true, false easting is `zone × 1e6 + 500000` (带号进东坐标). */
  zoneInEasting: boolean;
  /** Projected metres of the model origin (RTK site / CAD false origin). */
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  customProj4: string;
  /**
   * When true, model XY are already easting/northing (absolute projected
   * coordinates). The mesh is recentred on its bbox so it sits in a local ENU.
   */
  modelIsProjected: boolean;
}

export const DEFAULT_LOCAL_CRS: LocalCrsSettings = {
  preset: "enu",
  zone: 40,
  zoneInEasting: true,
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
  customProj4: "",
  modelIsProjected: false,
};
