/**
 * Mesh helpers: OBJ parsing, GLB (glTF 2 binary) parse/write, bounding boxes,
 * vertex welding, and vertex-clustering simplification for LOD.
 */

import type { BBox3, MeshData } from "./types";

function emptyBBox(): BBox3 {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function computeBBox(positions: ArrayLike<number>): BBox3 {
  const bbox = emptyBBox();
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < bbox.min[0]) bbox.min[0] = x;
    if (y < bbox.min[1]) bbox.min[1] = y;
    if (z < bbox.min[2]) bbox.min[2] = z;
    if (x > bbox.max[0]) bbox.max[0] = x;
    if (y > bbox.max[1]) bbox.max[1] = y;
    if (z > bbox.max[2]) bbox.max[2] = z;
  }
  if (!Number.isFinite(bbox.min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return bbox;
}

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Parse a Wavefront OBJ (triangles / n-gons fanned). Ignores materials and
 * negative indices that OBJ allows for relative addressing are supported.
 */
export function parseObj(text: string): MeshData {
  const verts: number[] = [];
  const faces: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const parts = line.slice(2).trim().split(/\s+/);
      verts.push(Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0);
    } else if (line.startsWith("f ")) {
      const parts = line.slice(2).trim().split(/\s+/);
      const ids: number[] = [];
      for (const part of parts) {
        const token = part.split("/")[0];
        let index = Number(token);
        if (!Number.isFinite(index) || index === 0) continue;
        if (index < 0) index = verts.length / 3 + index + 1;
        ids.push(index - 1);
      }
      for (let i = 1; i + 1 < ids.length; i++) {
        faces.push(ids[0], ids[i], ids[i + 1]);
      }
    }
  }
  const positions = new Float32Array(verts);
  const indices = faces.length ? new Uint32Array(faces) : undefined;
  return { positions, indices, bbox: computeBBox(positions) };
}

interface GlbJson {
  accessors?: {
    bufferView?: number;
    componentType: number;
    count: number;
    type: string;
    byteOffset?: number;
  }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
}

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(json: GlbJson, bin: Uint8Array, index: number): Float32Array | Uint32Array | null {
  const acc = json.accessors?.[index];
  if (!acc || acc.bufferView === undefined) return null;
  const view = json.bufferViews?.[acc.bufferView];
  if (!view) return null;
  const compSize = COMPONENT_BYTES[acc.componentType];
  const comps = TYPE_COMPONENTS[acc.type] ?? 1;
  const offset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? compSize * comps;
  const count = acc.count;
  if (acc.componentType === 5126) {
    const out = new Float32Array(count * comps);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < comps; c++) out[i * comps + c] = dv.getFloat32(offset + i * stride + c * 4, true);
    }
    return out;
  }
  if (acc.componentType === 5125 || acc.componentType === 5123 || acc.componentType === 5121) {
    const out = new Uint32Array(count);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    for (let i = 0; i < count; i++) {
      const at = offset + i * stride;
      out[i] =
        acc.componentType === 5125
          ? dv.getUint32(at, true)
          : acc.componentType === 5123
            ? dv.getUint16(at, true)
            : dv.getUint8(at);
    }
    return out;
  }
  return null;
}

/**
 * Parse a glTF 2 GLB, concatenating every mesh primitive's POSITION (and
 * indices) into one MeshData. Materials and textures are ignored; keep the
 * original bytes on {@link ImportedScene.originalGlb} when they must survive.
 */
export function parseGlb(bytes: Uint8Array): MeshData {
  if (bytes.byteLength < 12) throw new Error("File is too small to be a GLB.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = decodeText(bytes.subarray(0, 4));
  if (magic !== "glTF") throw new Error("Not a GLB file (missing glTF magic).");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`Unsupported glTF version ${version}; need 2.`);
  let json: GlbJson | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = decodeText(bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > bytes.byteLength) break;
    if (chunkType === "JSON") {
      let jsonBytes = bytes.subarray(start, end);
      while (jsonBytes.length && jsonBytes[jsonBytes.length - 1] <= 0x20) {
        jsonBytes = jsonBytes.subarray(0, jsonBytes.length - 1);
      }
      json = JSON.parse(decodeText(jsonBytes)) as GlbJson;
    } else if (chunkType === "BIN\0") bin = bytes.subarray(start, end);
    offset = end;
  }
  if (!json || !bin) throw new Error("GLB is missing a JSON or BIN chunk.");
  const pos: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const position = readAccessor(json, bin, prim.attributes.POSITION);
      if (!(position instanceof Float32Array)) continue;
      for (let i = 0; i < position.length; i++) pos.push(position[i]);
      const vertexCount = position.length / 3;
      if (prim.indices !== undefined) {
        const indices = readAccessor(json, bin, prim.indices);
        if (indices instanceof Uint32Array) {
          for (const i of indices) idx.push(i + base);
        }
      } else {
        for (let i = 0; i < vertexCount; i++) idx.push(base + i);
      }
      base += vertexCount;
    }
  }
  if (!pos.length) throw new Error("GLB has no mesh POSITION data.");
  const positions = new Float32Array(pos);
  return { positions, indices: idx.length ? new Uint32Array(idx) : undefined, bbox: computeBBox(positions) };
}

/**
 * Wrap existing glTF JSON + a BIN payload as a GLB, so a JSON glTF that
 * referenced an external `.bin` can be imported the same way as a `.glb`.
 */
export function wrapGlb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  const buffersIn = Array.isArray(json.buffers) ? json.buffers : [];
  const first =
    buffersIn[0] && typeof buffersIn[0] === "object"
      ? { ...(buffersIn[0] as Record<string, unknown>) }
      : {};
  delete first.uri;
  first.byteLength = bin.byteLength;
  const jsonBytes = align4(
    new TextEncoder().encode(JSON.stringify({ ...json, buffers: [first, ...buffersIn.slice(1)] })),
    0x20,
  );
  const binPadded = align4(bin);
  const total = 12 + 8 + jsonBytes.length + 8 + binPadded.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode("glTF"), 0);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  out.set(new TextEncoder().encode("JSON"), 16);
  out.set(jsonBytes, 20);
  const binHeader = 20 + jsonBytes.length;
  dv.setUint32(binHeader, binPadded.length, true);
  out.set(new TextEncoder().encode("BIN\0"), binHeader + 4);
  out.set(binPadded, binHeader + 8);
  return out;
}

/**
 * ASCII or binary STL. Binary is detected by the 80-byte header + triangle
 * count matching the file length (`84 + 50 × n`).
 */
export function parseStl(bytes: Uint8Array): MeshData {
  if (bytes.byteLength >= 84) {
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (count > 0 && bytes.byteLength === 84 + count * 50) {
      const positions = new Float32Array(count * 9);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < count; i++) {
        const at = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) positions[i * 9 + k] = dv.getFloat32(at + k * 4, true);
      }
      return { positions, bbox: computeBBox(positions) };
    }
  }
  const text = decodeText(bytes);
  if (!/^\s*solid/i.test(text)) {
    throw new Error("Not a valid STL file.");
  }
  const verts: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^vertex\s+/i.test(line)) {
      const parts = line.slice(6).trim().split(/\s+/);
      verts.push(Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0);
    }
  }
  if (verts.length < 9) throw new Error("STL has no triangles.");
  const positions = new Float32Array(verts);
  return { positions, bbox: computeBBox(positions) };
}

/**
 * Stanford PLY (ASCII or binary little-endian) with x/y/z vertices and triangle
 * or quad faces. Other properties are ignored.
 */
export function parsePly(bytes: Uint8Array): MeshData {
  const headerEnd = indexOfHeaderEnd(bytes);
  if (headerEnd < 0) throw new Error("PLY is missing an end_header line.");
  const header = decodeText(bytes.subarray(0, headerEnd));
  const lines = header.split(/\r?\n/).map((l) => l.trim());
  if (!/^ply$/i.test(lines[0] ?? "")) throw new Error("Not a valid PLY file.");
  let format: "ascii" | "binary_le" = "ascii";
  let vertexCount = 0;
  let faceCount = 0;
  let section: "vertex" | "face" | null = null;
  const vertexProps: string[] = [];
  for (const line of lines) {
    if (/^format\s+ascii/i.test(line)) format = "ascii";
    else if (/^format\s+binary_little_endian/i.test(line)) format = "binary_le";
    else if (/^format\s+binary_big_endian/i.test(line)) {
      throw new Error("Big-endian PLY is not supported. Re-export as ASCII or little-endian.");
    } else if (/^element\s+vertex\s+/i.test(line)) {
      section = "vertex";
      vertexCount = Number(line.split(/\s+/)[2]) || 0;
    } else if (/^element\s+face\s+/i.test(line)) {
      section = "face";
      faceCount = Number(line.split(/\s+/)[2]) || 0;
    } else if (/^element\s+/i.test(line)) {
      section = null;
    } else if (section === "vertex" && /^property\s+/i.test(line)) {
      vertexProps.push(line.split(/\s+/).pop() ?? "");
    }
  }
  const xi = vertexProps.indexOf("x");
  const yi = vertexProps.indexOf("y");
  const zi = vertexProps.indexOf("z");
  if (xi < 0 || yi < 0 || zi < 0) throw new Error("PLY vertices must include x, y, and z.");
  if (format === "ascii") {
    const body = decodeText(bytes.subarray(headerEnd)).trim().split(/\r?\n/);
    const positions = new Float32Array(vertexCount * 3);
    const faces: number[] = [];
    for (let i = 0; i < vertexCount; i++) {
      const parts = (body[i] ?? "").trim().split(/\s+/);
      positions[i * 3] = Number(parts[xi]) || 0;
      positions[i * 3 + 1] = Number(parts[yi]) || 0;
      positions[i * 3 + 2] = Number(parts[zi]) || 0;
    }
    for (let i = 0; i < faceCount; i++) {
      const parts = (body[vertexCount + i] ?? "").trim().split(/\s+/).map(Number);
      const n = parts[0];
      const ids = parts.slice(1, 1 + n);
      for (let t = 1; t + 1 < ids.length; t++) faces.push(ids[0], ids[t], ids[t + 1]);
    }
    return {
      positions,
      indices: faces.length ? new Uint32Array(faces) : undefined,
      bbox: computeBBox(positions),
    };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset + headerEnd, bytes.byteLength - headerEnd);
  const propSize = vertexProps.length * 4;
  const positions = new Float32Array(vertexCount * 3);
  let offset = 0;
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = dv.getFloat32(offset + xi * 4, true);
    positions[i * 3 + 1] = dv.getFloat32(offset + yi * 4, true);
    positions[i * 3 + 2] = dv.getFloat32(offset + zi * 4, true);
    offset += propSize;
  }
  const faces: number[] = [];
  for (let i = 0; i < faceCount; i++) {
    const n = dv.getUint8(offset);
    offset += 1;
    const ids: number[] = [];
    for (let k = 0; k < n; k++) {
      ids.push(dv.getUint32(offset, true));
      offset += 4;
    }
    for (let t = 1; t + 1 < ids.length; t++) faces.push(ids[0], ids[t], ids[t + 1]);
  }
  return {
    positions,
    indices: faces.length ? new Uint32Array(faces) : undefined,
    bbox: computeBBox(positions),
  };
}

function indexOfHeaderEnd(bytes: Uint8Array): number {
  const needle = new TextEncoder().encode("end_header");
  for (let i = 0; i + needle.length < bytes.length; i++) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) {
      if (bytes[i + k] !== needle[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let j = i + needle.length;
    while (j < bytes.length && bytes[j] !== 0x0a) j++;
    return j < bytes.length ? j + 1 : j;
  }
  return -1;
}

function align4(bytes: Uint8Array, fill = 0): Uint8Array {
  const pad = pad4(bytes.length);
  if (!pad) return bytes;
  const out = new Uint8Array(bytes.length + pad);
  out.set(bytes);
  if (fill) out.fill(fill, bytes.length);
  return out;
}

/**
 * Encode a triangle mesh as a glTF 2 GLB (POSITION + optional indices). No
 * materials — sufficient for 3D Tiles 1.1 content and for LOD children.
 */
export function writeGlb(mesh: MeshData): Uint8Array {
  const positions = mesh.positions;
  const indices = mesh.indices;
  const posBytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  let bin: Uint8Array;
  let indexView: { byteOffset: number; byteLength: number } | undefined;
  if (indices && indices.length) {
    const indexBytes = new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);
    const posPadded = align4(posBytes);
    bin = new Uint8Array(posPadded.length + indexBytes.length);
    bin.set(posPadded);
    bin.set(indexBytes, posPadded.length);
    indexView = { byteOffset: posPadded.length, byteLength: indexBytes.length };
  } else {
    bin = posBytes;
  }
  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: "GeoLibre 3D Tiles pipeline" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            ...(indexView ? { indices: 1 } : {}),
            mode: 4,
          },
        ],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: "VEC3",
        min: mesh.bbox.min,
        max: mesh.bbox.max,
      },
      ...(indexView
        ? [
            {
              bufferView: 1,
              componentType: 5125,
              count: indices!.length,
              type: "SCALAR",
            },
          ]
        : []),
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      ...(indexView ? [{ buffer: 0, ...indexView, target: 34963 }] : []),
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBytes = align4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binPadded = align4(bin);
  const total = 12 + 8 + jsonBytes.length + 8 + binPadded.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode("glTF"), 0);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  out.set(new TextEncoder().encode("JSON"), 16);
  out.set(jsonBytes, 20);
  const binHeader = 20 + jsonBytes.length;
  dv.setUint32(binHeader, binPadded.length, true);
  out.set(new TextEncoder().encode("BIN\0"), binHeader + 4);
  out.set(binPadded, binHeader + 8);
  return out;
}

function sequentialIndices(count: number): Uint32Array {
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return indices;
}

/** Merge vertices closer than `epsilon` meters, remapping indices. */
export function weldVertices(mesh: MeshData, epsilon: number): MeshData {
  if (epsilon <= 0) return mesh;
  const cell = 1 / epsilon;
  const map = new Map<string, number>();
  const positions: number[] = [];
  const remap: number[] = [];
  const count = mesh.positions.length / 3;
  const sourceIndices = mesh.indices ?? sequentialIndices(count);
  for (let i = 0; i < count; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];
    const key = `${Math.round(x * cell)}:${Math.round(y * cell)}:${Math.round(z * cell)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      map.set(key, id);
      positions.push(x, y, z);
    }
    remap[i] = id;
  }
  const next: number[] = [];
  for (let i = 0; i + 2 < sourceIndices.length; i += 3) {
    const a = remap[sourceIndices[i]];
    const b = remap[sourceIndices[i + 1]];
    const c = remap[sourceIndices[i + 2]];
    if (a !== b && b !== c && c !== a) next.push(a, b, c);
  }
  const pos = new Float32Array(positions);
  return { positions: pos, indices: new Uint32Array(next), bbox: computeBBox(pos) };
}

/**
 * Vertex clustering: snap vertices to a uniform grid of `cells` divisions along
 * the longest AABB axis. Used to build coarser LOD meshes.
 */
export function clusterMesh(mesh: MeshData, cells: number): MeshData {
  const span = Math.max(
    mesh.bbox.max[0] - mesh.bbox.min[0],
    mesh.bbox.max[1] - mesh.bbox.min[1],
    mesh.bbox.max[2] - mesh.bbox.min[2],
    1e-9,
  );
  return weldVertices(mesh, span / Math.max(cells, 1));
}

/** Quantize positions to 16-bit in-box values, then dequantize back to floats. */
export function quantizePositions(mesh: MeshData): MeshData {
  const { min, max } = mesh.bbox;
  const sx = (max[0] - min[0]) / 65535 || 1;
  const sy = (max[1] - min[1]) / 65535 || 1;
  const sz = (max[2] - min[2]) / 65535 || 1;
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = min[0] + Math.round((mesh.positions[i] - min[0]) / sx) * sx;
    positions[i + 1] = min[1] + Math.round((mesh.positions[i + 1] - min[1]) / sy) * sy;
    positions[i + 2] = min[2] + Math.round((mesh.positions[i + 2] - min[2]) / sz) * sz;
  }
  return { ...mesh, positions, bbox: computeBBox(positions) };
}

export function triangleCount(mesh: MeshData): number {
  if (mesh.indices) return Math.floor(mesh.indices.length / 3);
  return Math.floor(mesh.positions.length / 9);
}

export function vertexCount(mesh: MeshData): number {
  return Math.floor(mesh.positions.length / 3);
}
