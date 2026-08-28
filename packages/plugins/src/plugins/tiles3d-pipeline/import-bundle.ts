/**
 * Folder / multi-file import for the 3D Tiles pipeline: 3D Tiles trees,
 * glTF + `.bin`, ContextCapture OSGB metadata, and a preferred mesh in a mix.
 *
 * Takes path + bytes so Node tests do not need the File API.
 */

import { importScene } from "./import-scene";
import { parseGlb, wrapGlb } from "./mesh";
import { parseObliqueMetadata, type ObliqueMetadata } from "./oblique";
import type { ImportedScene, TilesetFile } from "./types";
import { triangleCount, vertexCount } from "./mesh";

export interface NamedBytes {
  /** Slash-separated relative path (webkitRelativePath or the file name). */
  name: string;
  bytes: Uint8Array;
}

export type ImportBundle =
  | { kind: "scene"; scene: ImportedScene; metadata: ObliqueMetadata | null }
  | { kind: "tileset"; name: string; files: TilesetFile[]; metadata: ObliqueMetadata | null };

const MESH_EXT = new Set(["glb", "gltf", "obj", "stl", "ply", "las"]);
const MESH_RANK: Record<string, number> = {
  glb: 0,
  obj: 1,
  gltf: 2,
  stl: 3,
  ply: 4,
  las: 5,
};

export function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const index = base.lastIndexOf(".");
  return index === -1 ? "" : base.slice(index + 1).toLowerCase();
}

export function dirnameOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const index = norm.lastIndexOf("/");
  return index === -1 ? "" : norm.slice(0, index);
}

export function joinPath(dir: string, rel: string): string {
  const raw = rel.replace(/\\/g, "/");
  if (!dir) return raw.replace(/^\.\//, "");
  const parts = [...dir.split("/"), ...raw.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function slashCount(path: string): number {
  return path.split("/").length;
}

function byPath(files: NamedBytes[]): Map<string, NamedBytes> {
  const map = new Map<string, NamedBytes>();
  for (const file of files) {
    const name = file.name.replace(/\\/g, "/");
    map.set(name, { ...file, name });
    const base = name.split("/").pop();
    if (base && !map.has(base)) map.set(base, { ...file, name });
  }
  return map;
}

function readMetadata(files: NamedBytes[]): ObliqueMetadata | null {
  const xml = files.find((f) => {
    const base = (f.name.split("/").pop() ?? "").toLowerCase();
    return base === "metadata.xml" || extensionOf(f.name) === "3mx";
  });
  if (!xml) return null;
  return parseObliqueMetadata(new TextDecoder("utf-8").decode(xml.bytes));
}

function pickRootTileset(files: NamedBytes[]): NamedBytes | null {
  const matches = files.filter((f) => (f.name.split("/").pop() ?? "").toLowerCase() === "tileset.json");
  if (!matches.length) return null;
  matches.sort((a, b) => slashCount(a.name) - slashCount(b.name) || a.name.length - b.name.length);
  return matches[0];
}

function pickPreferredMesh(files: NamedBytes[]): NamedBytes | null {
  const meshes = files.filter((f) => MESH_EXT.has(extensionOf(f.name)));
  if (!meshes.length) return null;
  meshes.sort((a, b) => {
    const depth = slashCount(a.name) - slashCount(b.name);
    if (depth !== 0) return depth;
    return (MESH_RANK[extensionOf(a.name)] ?? 9) - (MESH_RANK[extensionOf(b.name)] ?? 9);
  });
  return meshes[0];
}

function importGltfWithBuffers(file: NamedBytes, files: NamedBytes[]): ImportedScene {
  const json = JSON.parse(new TextDecoder("utf-8").decode(file.bytes)) as {
    buffers?: { uri?: string; byteLength?: number }[];
  };
  const uri = json.buffers?.[0]?.uri;
  if (!uri) {
    throw new Error("This glTF has no buffer. Export a GLB and import that instead.");
  }
  if (uri.startsWith("data:")) {
    throw new Error("JSON glTF with embedded buffers is not parsed yet. Re-export the model as GLB.");
  }
  const lookup = byPath(files);
  const resolved = lookup.get(joinPath(dirnameOf(file.name), uri)) ?? lookup.get(uri);
  if (!resolved) {
    throw new Error(`This glTF references “${uri}”, which was not in the imported folder.`);
  }
  const glb = wrapGlb(json as Record<string, unknown>, resolved.bytes);
  const mesh = parseGlb(glb);
  const name = (file.name.split("/").pop() ?? file.name).replace(/\.gltf$/i, ".glb");
  return {
    kind: "mesh",
    name,
    sourceFormat: "gltf",
    mesh,
    originalGlb: glb,
    vertexCount: vertexCount(mesh),
    triangleCount: triangleCount(mesh),
  };
}

const OSGB_HINT =
  "OSGB binary mesh is not decoded in the browser. Import a folder that also contains tileset.json (3D Tiles) or an OBJ/GLB/glTF export from the same project. metadata.xml is still read for the coordinate system.";

/**
 * Import one file or a whole folder (oblique OSGB / 3D Tiles / mixed mesh).
 */
export function importBundle(files: NamedBytes[]): ImportBundle {
  if (!files.length) throw new Error("No files to import.");
  const normalized = files.map((f) => ({ ...f, name: f.name.replace(/\\/g, "/") }));
  const metadata = readMetadata(normalized);
  const tileset = pickRootTileset(normalized);
  if (tileset) {
    return {
      kind: "tileset",
      name: tileset.name.split("/").pop() ?? "tileset.json",
      files: normalized.map((f) => ({ path: f.name, bytes: f.bytes })),
      metadata,
    };
  }
  const meshFile = pickPreferredMesh(normalized);
  if (!meshFile) {
    const osgb = normalized.some((f) => extensionOf(f.name) === "osgb");
    if (osgb || metadata) throw new Error(OSGB_HINT);
    throw new Error(
      "Unsupported 3D format. Use GLB, glTF (+ .bin), OBJ, STL, PLY, uncompressed LAS, a 3D Tiles folder (tileset.json), or an oblique folder with metadata.xml plus an OBJ/GLB export.",
    );
  }
  const ext = extensionOf(meshFile.name);
  const scene =
    ext === "gltf"
      ? importGltfWithBuffers(meshFile, normalized)
      : importScene(meshFile.name.split("/").pop() ?? meshFile.name, meshFile.bytes);
  return { kind: "scene", scene, metadata };
}
