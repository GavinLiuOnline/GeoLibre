/**
 * Import dispatch and option normalisation for the 3D Tiles pipeline.
 */

import { parseGlb, parseObj, parsePly, parseStl, triangleCount, vertexCount, weldVertices, quantizePositions, computeBBox } from "./mesh";
import { isLaz, LasParseError, parseLas } from "./las";
import type { ImportedScene, MeshData, OptimizeOptions, PointCloudData, SourceFormat } from "./types";
import { DEFAULT_OPTIMIZE_OPTIONS } from "./types";

const GLB_MAGIC = "glTF";
const LAS_MAGIC = "LASF";

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

function formatFromName(name: string): SourceFormat | null {
  const ext = extensionOf(name);
  if (ext === "glb") return "glb";
  if (ext === "gltf") return "gltf";
  if (ext === "obj") return "obj";
  if (ext === "stl") return "stl";
  if (ext === "ply") return "ply";
  if (ext === "las" || ext === "laz") return "las";
  if (ext === "osgb") return "osgb";
  return null;
}

/**
 * Import a 3D file (GLB, glTF JSON without external buffers, OBJ, or LAS).
 * Throws a user-facing Error when the format is unsupported or the payload is
 * truncated / compressed (LAZ).
 */
export function importScene(name: string, bytes: Uint8Array): ImportedScene {
  const hinted = formatFromName(name);
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, 4));
  let format: SourceFormat;
  if (head === GLB_MAGIC) format = "glb";
  else if (head === LAS_MAGIC) format = "las";
  else if (hinted) format = hinted;
  else {
    throw new Error(
      `Unsupported 3D format for “${name}”. Use GLB, glTF, OBJ, STL, PLY, uncompressed LAS, or a 3D Tiles / oblique folder.`,
    );
  }

  if (format === "osgb") {
    throw new Error(
      "OSGB binary mesh is not decoded in the browser. Import the folder and include tileset.json or an OBJ/GLB export; metadata.xml is still read for the coordinate system.",
    );
  }

  if (format === "las") {
    if (isLaz(bytes) || extensionOf(name) === "laz") {
      throw new LasParseError(
        "LAZ (compressed LAS) is not decoded in the browser. Convert to uncompressed LAS first, or use a LAS file.",
      );
    }
    const points = parseLas(bytes);
    return {
      kind: "points",
      name,
      sourceFormat: "las",
      points,
      vertexCount: points.positions.length / 3,
      triangleCount: 0,
    };
  }

  if (format === "obj") {
    const mesh = parseObj(new TextDecoder("utf-8").decode(bytes));
    return {
      kind: "mesh",
      name,
      sourceFormat: "obj",
      mesh,
      vertexCount: vertexCount(mesh),
      triangleCount: triangleCount(mesh),
    };
  }

  if (format === "stl") {
    const mesh = parseStl(bytes);
    return {
      kind: "mesh",
      name,
      sourceFormat: "stl",
      mesh,
      vertexCount: vertexCount(mesh),
      triangleCount: triangleCount(mesh),
    };
  }

  if (format === "ply") {
    const mesh = parsePly(bytes);
    return {
      kind: "mesh",
      name,
      sourceFormat: "ply",
      mesh,
      vertexCount: vertexCount(mesh),
      triangleCount: triangleCount(mesh),
    };
  }

  if (format === "gltf") {
    // Single-file glTF only: a .gltf that references an external .bin is
    // rejected rather than silently producing an empty mesh.
    const text = new TextDecoder("utf-8").decode(bytes);
    let json: { buffers?: { uri?: string }[] };
    try {
      json = JSON.parse(text) as { buffers?: { uri?: string }[] };
    } catch {
      throw new Error("The glTF file is not valid JSON.");
    }
    const uri = json.buffers?.[0]?.uri;
    if (uri && !uri.startsWith("data:")) {
      throw new Error("This glTF references an external .bin. Export a GLB (binary glTF) and import that instead.");
    }
    throw new Error("JSON glTF with embedded buffers is not parsed yet. Re-export the model as GLB.");
  }

  const mesh = parseGlb(bytes);
  return {
    kind: "mesh",
    name,
    sourceFormat: "glb",
    mesh,
    originalGlb: bytes,
    vertexCount: vertexCount(mesh),
    triangleCount: triangleCount(mesh),
  };
}

export function normalizeOptimizeOptions(value: unknown): OptimizeOptions {
  const c = (value ?? {}) as Partial<OptimizeOptions>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    weldEpsilon: Math.max(0, num(c.weldEpsilon, DEFAULT_OPTIMIZE_OPTIONS.weldEpsilon)),
    reduction: Math.min(1, Math.max(0.05, num(c.reduction, DEFAULT_OPTIMIZE_OPTIONS.reduction))),
    lodLevels: Math.min(8, Math.max(1, Math.round(num(c.lodLevels, DEFAULT_OPTIMIZE_OPTIONS.lodLevels)))),
    quantize: typeof c.quantize === "boolean" ? c.quantize : DEFAULT_OPTIMIZE_OPTIONS.quantize,
  };
}

/** Apply weld + quantization to a scene's working mesh (in place on a copy). */
export function applyMeshOptimize(scene: ImportedScene, options: OptimizeOptions): ImportedScene {
  if (scene.kind !== "mesh" || !scene.mesh) return scene;
  let mesh = scene.mesh;
  if (options.weldEpsilon > 0) mesh = weldVertices(mesh, options.weldEpsilon);
  if (options.quantize) mesh = quantizePositions(mesh);
  return {
    ...scene,
    mesh,
    originalGlb: options.weldEpsilon > 0 || options.quantize ? undefined : scene.originalGlb,
    vertexCount: vertexCount(mesh),
    triangleCount: triangleCount(mesh),
  };
}

function shiftPositions(positions: Float32Array, dx: number, dy: number, dz: number): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i] - dx;
    out[i + 1] = positions[i + 1] - dy;
    out[i + 2] = positions[i + 2] - dz;
  }
  return out;
}

/** Subtract a model-space origin so projected CAD/OSGB vertices sit in local metres. */
export function shiftScene(scene: ImportedScene, dx: number, dy: number, dz: number): ImportedScene {
  if (dx === 0 && dy === 0 && dz === 0) return scene;
  if (scene.kind === "mesh" && scene.mesh) {
    const positions = shiftPositions(scene.mesh.positions, dx, dy, dz);
    const mesh: MeshData = { ...scene.mesh, positions, bbox: computeBBox(positions) };
    return {
      ...scene,
      mesh,
      originalGlb: undefined,
      vertexCount: vertexCount(mesh),
      triangleCount: triangleCount(mesh),
    };
  }
  if (scene.points) {
    const positions = shiftPositions(scene.points.positions, dx, dy, dz);
    const points: PointCloudData = { ...scene.points, positions, bbox: computeBBox(positions) };
    return { ...scene, points, vertexCount: positions.length / 3 };
  }
  return scene;
}

export function bboxCenter(bbox: { min: [number, number, number]; max: [number, number, number] }): [number, number, number] {
  return [
    (bbox.min[0] + bbox.max[0]) / 2,
    (bbox.min[1] + bbox.max[1]) / 2,
    (bbox.min[2] + bbox.max[2]) / 2,
  ];
}
