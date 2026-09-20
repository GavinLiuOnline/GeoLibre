/**
 * editor/core · localCache/generate3d —— 三维模型 → 3D Tiles 缓存生成
 *
 * 场景：用户导入三维模型（OBJ / STL）后，在编辑器内直接「生成缓存」，
 * 得到一份与本地缓存导入（tilesetCache）形态一致的 3D Tiles 1.1 数据集，
 * 从而复用既有链路：预览（Cesium3DTileset）→ 注册图层（LayerManager）
 * → zip 打包（zipCacheBundle）→ 发布（publishScenePackage）。
 *
 * 产物（zip 内相对路径，rootDir 为空即包根）：
 * - `tileset.json`：3D Tiles 1.1（asset.version = '1.1'），
 *   root.boundingVolume.box 由模型 AABB 计算，root.transform 为 ENU→ECEF（placement 存在时）
 * - `<模型名>.glb`：由解析出的几何经 @gltf-transform 写出的自包含 GLB
 *
 * 设计要点：
 * - 解析器自实现（不引入 three.js）：OBJ（v/vn/vt + 索引 + 负索引 + 多边形扇形三角化）
 *   与 STL（ASCII / 二进制，面法线平直着色）。纯函数，可独立单测。
 * - GLB 写出用 WebIO（与 optimizer/glbOptimizer 一致，浏览器安全，不依赖 node:fs）。
 * - transform 用 Cesium 的 Transforms.headingPitchRollToFixedFrame（内部即
 *   eastNorthUpToFixedFrame + heading/pitch/roll），再叠加 uniform scale，
 *   Matrix4.toArray() 得到的 16 元数组即为 3D Tiles 要求的**列主序** transform。
 * - 与发布链路的桥接：generatedCacheToZipInputs / zipGeneratedCache 直接复用
 *   localCache.metadataToZipInputs + zipBundle.zipCacheBundle，不重复实现打包。
 *
 * 已知取舍：OBJ 的 .mtl / 贴图不参与生成（统一使用默认 PBR 材质），
 * 需要贴图时请走「导入 GLB」路径。
 */
import { Cartesian3, Cesium3DTileset, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import { Document, Primitive, WebIO } from '@gltf-transform/core';

import type { LayerManager } from './layer-manager';
import { normalizeRelativePath } from './detect';
import { importGeneratedXyzToLayers } from './generate-2d';
import { metadataToZipInputs } from './local-cache';
import { rewriteTilesetJson, rewriteTilesetNode } from './tileset-rewrite';
import type { TilesetNode } from './tileset-rewrite';
import type { LocalCacheMetadata, ZipBundleOptions, ZipBundleResult } from './types';
import { zipCacheBundle } from './zip-bundle';
import type { ZipInputEntry } from './zip-bundle';

// ---------------------------------------------------------------------------
// 契约类型（t14 UI 消费；不得改名）
// ---------------------------------------------------------------------------

/** 模型放置参数（经纬高 + 姿态 + 缩放），生成 tileset.json 的 root.transform */
export interface ModelPlacement {
  longitude: number;
  latitude: number;
  height?: number;
  heading?: number;
  pitch?: number;
  roll?: number;
  scale?: number;
}

/** 生成缓存内的单个文件（path 为包内相对 POSIX 路径） */
export interface GeneratedCacheFile {
  path: string;
  blob: Blob;
}

/** 生成结果：可直接写 LayerSource.metadata，也可直接交给 zipCacheBundle 打包 */
export interface GeneratedCache {
  kind: '3dtiles' | 'xyz';
  /** 包内文件清单（相对 POSIX 路径） */
  files: GeneratedCacheFile[];
  /** 3dtiles: 'tileset.json' 路径；xyz: '' */
  entry: string;
  /** 可直接写入 LayerSource.metadata（cacheKind/files/rootDir/detection + cacheSource:'generated'） */
  metadata: LocalCacheMetadata;
  /** 统计信息（UI 显示） */
  stats: {
    fileCount: number;
    totalBytes: number;
    triangles?: number;
    vertices?: number;
    maxZoom?: number;
  };
}

/** 生成选项 */
export interface Generate3dOptions {
  /** 进度回调（0~1，单调不减） */
  onProgress?: (ratio: number) => void;
}

// ---------------------------------------------------------------------------
// 解析结果与模型格式
// ---------------------------------------------------------------------------

/** 解析后的三角网格（索引化，POSITION/NORMAL 均为逐顶点） */
export interface ParsedModel {
  /** 顶点位置（xyz × N） */
  positions: Float32Array;
  /** 顶点法线（xyz × N，与 positions 对齐） */
  normals: Float32Array;
  /** 三角形索引（3 × M） */
  indices: Uint32Array;
  /** 顶点数 */
  vertices: number;
  /** 三角形数 */
  triangles: number;
  /** 法线是否来自文件（false = 解析时由几何计算/面法线） */
  normalsFromFile: boolean;
}

/** 支持生成缓存的三维模型格式 */
export type ModelFormat = 'obj' | 'stl';

/** 由文件名（或路径）判别模型格式；不支持时返回 undefined */
export function detectModelFormat(name: string): ModelFormat | undefined {
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base.endsWith('.obj')) return 'obj';
  if (base.endsWith('.stl')) return 'stl';
  return undefined;
}

// ---------------------------------------------------------------------------
// OBJ 解析
// ---------------------------------------------------------------------------

interface FaceRef {
  /** 顶点下标（positions 数组下标） */
  vertex: number;
  /** 法线下标（normals 数组下标），缺省表示该面未给法线 */
  normal?: number;
}

/**
 * 解析 OBJ 文本 → 索引化三角网格。
 *
 * 支持：`v x y z`、`vn x y z`、`f`（`v`、`v/vt`、`v//vn`、`v/vt/vn`，含负索引），
 * 多边形面按扇形三角化；`vt` 被解析但不参与 GLB（本函数不产出 UV）。
 * 若并非所有面都带法线，则整模型改由几何计算平滑法线。
 */
export function parseObjText(text: string): ParsedModel {
  const rawPositions: number[] = [];
  const rawNormals: number[] = [];
  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outIndices: number[] = [];
  /** key = `${vIdx}/${nIdx}` → 输出去重后的顶点下标 */
  const vertexMap = new Map<string, number>();
  let totalFaces = 0;
  let facesWithNormals = 0;

  const vertexCount = (): number => rawPositions.length / 3;

  const pushVertex = (ref: FaceRef): number => {
    const key = `${ref.vertex}/${ref.normal ?? ''}`;
    const hit = vertexMap.get(key);
    if (hit !== undefined) return hit;
    const index = outPositions.length / 3;
    outPositions.push(
      rawPositions[ref.vertex * 3] ?? 0,
      rawPositions[ref.vertex * 3 + 1] ?? 0,
      rawPositions[ref.vertex * 3 + 2] ?? 0,
    );
    if (ref.normal !== undefined) {
      outNormals.push(
        rawNormals[ref.normal * 3] ?? 0,
        rawNormals[ref.normal * 3 + 1] ?? 0,
        rawNormals[ref.normal * 3 + 2] ?? 0,
      );
    } else {
      outNormals.push(0, 0, 0); // 占位，稍后统一由几何计算
    }
    vertexMap.set(key, index);
    return index;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];

    if (tag === 'v') {
      rawPositions.push(number(parts[1]), number(parts[2]), number(parts[3]));
    } else if (tag === 'vn') {
      rawNormals.push(number(parts[1]), number(parts[2]), number(parts[3]));
    } else if (tag === 'f') {
      const refs: FaceRef[] = [];
      for (let i = 1; i < parts.length; i++) {
        const token = parts[i];
        if (!token) continue;
        refs.push(parseFaceRef(token, vertexCount(), rawNormals.length / 3));
      }
      if (refs.length < 3) continue;
      totalFaces++;
      if (refs.every((r) => r.normal !== undefined)) facesWithNormals++;
      // 扇形三角化：v0-vi-vi+1
      for (let i = 1; i + 1 < refs.length; i++) {
        outIndices.push(pushVertex(refs[0]!), pushVertex(refs[i]!), pushVertex(refs[i + 1]!));
      }
    }
    // 其余标签（vt / o / g / s / usemtl / mtllib）忽略
  }

  const positions = new Float32Array(outPositions);
  const indices = new Uint32Array(outIndices);
  const normalsFromFile = totalFaces > 0 && facesWithNormals === totalFaces;
  const normals = normalsFromFile
    ? new Float32Array(outNormals)
    : computeSmoothNormals(positions, indices);

  return {
    positions,
    normals,
    indices,
    vertices: positions.length / 3,
    triangles: indices.length / 3,
    normalsFromFile,
  };
}

/** 解析单个 OBJ 面引用 token（支持负索引：-1 = 当前最后一个） */
function parseFaceRef(token: string, vertexCount: number, normalCount: number): FaceRef {
  const [vPart, , nPart] = token.split('/');
  const vertex = resolveIndex(vPart, vertexCount, '顶点');
  const normal = nPart ? resolveIndex(nPart, normalCount, '法线') : undefined;
  return normal === undefined ? { vertex } : { vertex, normal };
}

/** OBJ 索引归一化：正数为 1-based，负数为相对当前末尾 */
function resolveIndex(part: string | undefined, count: number, label: string): number {
  const value = Number(part);
  if (!Number.isInteger(value) || value === 0) {
    throw new Error(`OBJ 面引用了非法${label}索引："${part ?? ''}"`);
  }
  const index = value > 0 ? value - 1 : count + value;
  if (index < 0 || index >= count) {
    throw new Error(`OBJ 面引用了不存在的${label}索引：${value}（当前共 ${count} 个）`);
  }
  return index;
}

/** 由几何计算面积加权平滑法线（单位化；退化处回退 +Z） */
export function computeSmoothNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const ia = indices[i]! * 3;
    const ib = indices[i + 1]! * 3;
    const ic = indices[i + 2]! * 3;
    const abx = (positions[ib] ?? 0) - (positions[ia] ?? 0);
    const aby = (positions[ib + 1] ?? 0) - (positions[ia + 1] ?? 0);
    const abz = (positions[ib + 2] ?? 0) - (positions[ia + 2] ?? 0);
    const acx = (positions[ic] ?? 0) - (positions[ia] ?? 0);
    const acy = (positions[ic + 1] ?? 0) - (positions[ia + 1] ?? 0);
    const acz = (positions[ic + 2] ?? 0) - (positions[ia + 2] ?? 0);
    // 叉积不归一化 → 面积加权
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const idx of [ia, ib, ic]) {
      normals[idx] = (normals[idx] ?? 0) + nx;
      normals[idx + 1] = (normals[idx + 1] ?? 0) + ny;
      normals[idx + 2] = (normals[idx + 2] ?? 0) + nz;
    }
  }
  for (let i = 0; i + 2 < normals.length; i += 3) {
    const x = normals[i] ?? 0;
    const y = normals[i + 1] ?? 0;
    const z = normals[i + 2] ?? 0;
    const len = Math.hypot(x, y, z);
    if (len > 1e-12) {
      normals[i] = x / len;
      normals[i + 1] = y / len;
      normals[i + 2] = z / len;
    } else {
      normals[i] = 0;
      normals[i + 1] = 0;
      normals[i + 2] = 1;
    }
  }
  return normals;
}

// ---------------------------------------------------------------------------
// STL 解析（ASCII / 二进制，面法线平直着色）
// ---------------------------------------------------------------------------

/** 解析 STL（自动判别 ASCII / 二进制） */
export function parseStl(data: ArrayBuffer | ArrayBufferView): ParsedModel {
  const buffer = toArrayBuffer(data);
  if (isBinaryStl(buffer)) return parseStlBinary(buffer);
  return parseStlText(new TextDecoder().decode(buffer));
}

/** 二进制判别：字节数恰好符合 84 + n×50 且 n 与文件头一致 */
export function isBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  return 84 + count * 50 === buffer.byteLength;
}

/** 解析二进制 STL */
export function parseStlBinary(data: ArrayBuffer | ArrayBufferView): ParsedModel {
  const buffer = toArrayBuffer(data);
  if (buffer.byteLength < 84) throw new Error('STL 二进制数据不完整（缺少 84 字节文件头）');
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  if (84 + count * 50 > buffer.byteLength) {
    throw new Error(`STL 二进制数据不完整：声明 ${count} 个三角面，但长度不足`);
  }
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  let offset = 84;
  for (let t = 0; t < count; t++) {
    const nx = view.getFloat32(offset, true);
    const ny = view.getFloat32(offset + 4, true);
    const nz = view.getFloat32(offset + 8, true);
    offset += 12;
    for (let v = 0; v < 3; v++) {
      positions[t * 9 + v * 3] = view.getFloat32(offset, true);
      positions[t * 9 + v * 3 + 1] = view.getFloat32(offset + 4, true);
      positions[t * 9 + v * 3 + 2] = view.getFloat32(offset + 8, true);
      normals[t * 9 + v * 3] = nx;
      normals[t * 9 + v * 3 + 1] = ny;
      normals[t * 9 + v * 3 + 2] = nz;
      offset += 12;
    }
    offset += 2; // attribute byte count
  }
  const indices = new Uint32Array(count * 3);
  for (let i = 0; i < count * 3; i++) indices[i] = i;
  return {
    positions,
    normals,
    indices,
    vertices: positions.length / 3,
    triangles: count,
    normalsFromFile: true,
  };
}

/** 解析 ASCII STL */
export function parseStlText(text: string): ParsedModel {
  const positions: number[] = [];
  const normals: number[] = [];
  let facetNormal: [number, number, number] = [0, 0, 0];
  let facetVertices: number[] = [];
  /** 每个三角面独立顶点（平直着色），无共享顶点 */
  let triangles = 0;

  const flush = (): void => {
    if (facetVertices.length < 9) {
      facetVertices = [];
      return;
    }
    const p: [number, number, number] = [
      facetVertices[0]!,
      facetVertices[1]!,
      facetVertices[2]!,
    ];
    // 文件法线缺失/为零时由三角面计算
    let [nx, ny, nz] = facetNormal;
    if (Math.hypot(nx, ny, nz) < 1e-12) {
      const ax = facetVertices[3]! - p[0];
      const ay = facetVertices[4]! - p[1];
      const az = facetVertices[5]! - p[2];
      const bx = facetVertices[6]! - p[0];
      const by = facetVertices[7]! - p[1];
      const bz = facetVertices[8]! - p[2];
      nx = ay * bz - az * by;
      ny = az * bx - ax * bz;
      nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
    }
    for (let v = 0; v < 3; v++) {
      positions.push(facetVertices[v * 3]!, facetVertices[v * 3 + 1]!, facetVertices[v * 3 + 2]!);
      normals.push(nx, ny, nz);
    }
    triangles++;
    facetVertices = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('facet normal')) {
      const parts = line.split(/\s+/);
      facetNormal = [number(parts[2]), number(parts[3]), number(parts[4])];
      facetVertices = [];
    } else if (lower.startsWith('vertex')) {
      const parts = line.split(/\s+/);
      facetVertices.push(number(parts[1]), number(parts[2]), number(parts[3]));
    } else if (lower.startsWith('endfacet')) {
      flush();
    }
  }
  flush(); // 容错：缺少 endfacet 的文件

  if (triangles === 0) throw new Error('STL 未解析到任何三角面（文件为空或格式不受支持）');
  const indices = new Uint32Array(triangles * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices,
    vertices: positions.length / 3,
    triangles,
    normalsFromFile: true,
  };
}

// ---------------------------------------------------------------------------
// 合并 / AABB / GLB / tileset.json
// ---------------------------------------------------------------------------

/** 合并多个模型为单一索引化网格（索引加偏移） */
export function mergeModels(models: ParsedModel[]): ParsedModel {
  const valid = models.filter((m) => m.positions.length >= 9 && m.indices.length >= 3);
  if (valid.length === 0) throw new Error('模型不含任何三角面');
  if (valid.length === 1) return valid[0]!;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let base = 0;
  for (const m of valid) {
    for (let i = 0; i < m.positions.length; i++) positions.push(m.positions[i]!);
    for (let i = 0; i < m.normals.length; i++) normals.push(m.normals[i]!);
    for (let i = 0; i < m.indices.length; i++) indices.push(m.indices[i]! + base);
    base += m.positions.length / 3;
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    vertices: positions.length / 3,
    triangles: indices.length / 3,
    normalsFromFile: valid.every((m) => m.normalsFromFile),
  };
}

/** 模型轴对齐包围盒（含 3D Tiles boundingVolume.box 的 12 元数组） */
export interface ModelAabb {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  halfSize: [number, number, number];
  /** boundingVolume.box：[cx,cy,cz, hx,0,0, 0,hy,0, 0,0,hz] */
  box: number[];
}

/** 由顶点位置计算 AABB；半轴长被钳制到 1e-6 避免零体积包围盒 */
export function computeModelAabb(positions: Float32Array): ModelAabb {
  if (positions.length < 3) throw new Error('模型不含顶点，无法计算包围盒');
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const halfSize: [number, number, number] = [
    Math.max((maxX - minX) / 2, 1e-6),
    Math.max((maxY - minY) / 2, 1e-6),
    Math.max((maxZ - minZ) / 2, 1e-6),
  ];
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center,
    halfSize,
    box: [
      center[0], center[1], center[2],
      halfSize[0], 0, 0,
      0, halfSize[1], 0,
      0, 0, halfSize[2],
    ],
  };
}

/** 生成的 tileset.json 结构（3D Tiles 1.1 最小可用集） */
export interface GeneratedTileset {
  asset: { version: string };
  geometricError: number;
  root: {
    boundingVolume: { box: number[] };
    geometricError: number;
    content: { uri: string };
    transform?: number[];
  };
}

/** 构造 tileset.json：boundingVolume.box 来自 AABB，transform 仅在 placement 存在时给出 */
export function buildTilesetJson(input: {
  contentUri: string;
  aabb: ModelAabb;
  transform?: number[] | undefined;
  geometricError?: number;
}): GeneratedTileset {
  const geometricError = input.geometricError ?? 0;
  const root: GeneratedTileset['root'] = {
    boundingVolume: { box: [...input.aabb.box] },
    geometricError: 0,
    content: { uri: input.contentUri },
  };
  if (input.transform) root.transform = [...input.transform];
  return { asset: { version: '1.1' }, geometricError, root };
}

/**
 * 由 placement 计算 3D Tiles root.transform（ENU→ECEF 4×4，列主序 16 元数组）。
 *
 * Cesium 的 headingPitchRollToFixedFrame = eastNorthUpToFixedFrame + heading/pitch/roll，
 * 再叠加 uniform scale；无有效经纬度（placement 缺省/非有限值）时返回 undefined，
 * 由调用方省略 transform（模型保持局部坐标）。
 */
export function buildRootTransform(placement?: ModelPlacement | null): number[] | undefined {
  if (!placement) return undefined;
  if (!Number.isFinite(placement.longitude) || !Number.isFinite(placement.latitude)) return undefined;
  const origin = Cartesian3.fromDegrees(
    placement.longitude,
    placement.latitude,
    placement.height ?? 0,
  );
  const hpr = new HeadingPitchRoll(
    CesiumMath.toRadians(placement.heading ?? 0),
    CesiumMath.toRadians(placement.pitch ?? 0),
    CesiumMath.toRadians(placement.roll ?? 0),
  );
  const matrix = Transforms.headingPitchRollToFixedFrame(origin, hpr);
  const scale = placement.scale ?? 1;
  if (Number.isFinite(scale) && scale !== 1) {
    Matrix4.multiplyByUniformScale(matrix, scale, matrix);
  }
  return Matrix4.toArray(matrix) as number[];
}

/** 用 @gltf-transform WebIO 把网格写成自包含 GLB（POSITION / NORMAL / indices） */
export async function buildModelGlb(model: ParsedModel): Promise<Uint8Array<ArrayBuffer>> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor('POSITION', buffer)
    .setType('VEC3')
    .setArray(new Float32Array(model.positions));
  const normal = doc
    .createAccessor('NORMAL', buffer)
    .setType('VEC3')
    .setArray(new Float32Array(model.normals));
  // 顶点数超 65535 时用 UNSIGNED_INT，避免索引溢出
  const indexArray =
    model.vertices > 65535 ? new Uint32Array(model.indices) : new Uint16Array(model.indices);
  const indices = doc.createAccessor('indices', buffer).setType('SCALAR').setArray(indexArray);
  const material = doc
    .createMaterial('model-default')
    .setBaseColorFactor([0.82, 0.82, 0.82, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.9)
    .setDoubleSided(true);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('NORMAL', normal)
    .setIndices(indices)
    .setMaterial(material)
    .setMode(Primitive.Mode.TRIANGLES);
  const mesh = doc.createMesh('model').addPrimitive(primitive);
  const node = doc.createNode('model').setMesh(mesh);
  doc.createScene('scene').addChild(node);
  return new WebIO().writeBinary(doc);
}

// ---------------------------------------------------------------------------
// 生成入口（契约 API）
// ---------------------------------------------------------------------------

/**
 * 三维模型文件 → 3D Tiles 1.1 缓存。
 *
 * @param files 用户选择/拖入的文件（至少含一个 .obj 或 .stl；同批多个模型会合并为一个网格）
 * @param placement 放置参数（经纬高 + heading/pitch/roll/scale）；经纬度非有限值时省略 transform
 * @param options onProgress 进度回调（0~1，单调不减）
 */
export async function generate3DTilesFromModel(
  files: File[],
  placement: ModelPlacement,
  options: Generate3dOptions = {},
): Promise<GeneratedCache> {
  const report = createProgressReporter(options.onProgress);
  report(0);

  const list = (Array.isArray(files) ? files : []).filter(
    (f): f is File => !!f && typeof (f as File).name === 'string',
  );
  if (list.length === 0) throw new Error('未选择任何文件：请提供 .obj 或 .stl 三维模型');

  const modelFiles = list.filter((f) => detectModelFormat(f.name) !== undefined);
  if (modelFiles.length === 0) {
    throw new Error(
      `未找到可解析的三维模型文件（支持 .obj / .stl），实际选择：${list
        .map((f) => f.name)
        .join('、')}`,
    );
  }

  report(0.05);
  const parsed: ParsedModel[] = [];
  for (let i = 0; i < modelFiles.length; i++) {
    const file = modelFiles[i]!;
    const format = detectModelFormat(file.name);
    const model = format === 'obj' ? parseObjText(await file.text()) : parseStl(await file.arrayBuffer());
    parsed.push(model);
    report(0.05 + (0.35 * (i + 1)) / modelFiles.length);
  }

  const model = mergeModels(parsed);
  const aabb = computeModelAabb(model.positions);
  report(0.5);

  const glbBytes = await buildModelGlb(model);
  report(0.75);

  const glbName = `${modelBaseName(modelFiles[0]!.name)}.glb`;
  const transform = buildRootTransform(placement);
  const tileset = buildTilesetJson({
    contentUri: glbName,
    aabb,
    ...(transform ? { transform } : {}),
  });
  const tilesetBlob = new Blob([JSON.stringify(tileset, null, 2)], { type: 'application/json' });
  const glbBlob = new Blob([glbBytes], { type: 'model/gltf-binary' });

  const outFiles: GeneratedCacheFile[] = [
    { path: 'tileset.json', blob: tilesetBlob },
    { path: glbName, blob: glbBlob },
  ];
  const totalBytes = outFiles.reduce((sum, f) => sum + f.blob.size, 0);
  const metadata: LocalCacheMetadata = {
    cacheKind: '3dtiles',
    files: outFiles.map((f) => ({ path: f.path, size: f.blob.size })),
    totalBytes,
    rootDir: '',
    detection: { tilesetPath: 'tileset.json' },
    cacheSource: 'generated',
  };
  report(1);

  return {
    kind: '3dtiles',
    files: outFiles,
    entry: 'tileset.json',
    metadata,
    stats: {
      fileCount: outFiles.length,
      totalBytes,
      triangles: model.triangles,
      vertices: model.vertices,
    },
  };
}

/**
 * 把生成结果注册为可预览的编辑器图层（统一入口，按 kind 分发）。
 *
 * - kind='3dtiles'：包内文件转 blob URL，复用 tilesetRewrite 把 tileset.json 的
 *   content.uri 重写为 GLB 的 blob URL，再交给 Cesium3DTileset.fromUrl；
 * - kind='xyz'：分发到 generate2d 的 importGeneratedXyzToLayers
 *   （LocalXyzImageryProvider + blob URL 映射）。
 *
 * metadata 原样写入 LayerSource.metadata（含 cacheSource:'generated'）。
 *
 * @returns 图层 id
 */
export async function importGeneratedCacheToLayers(
  cache: GeneratedCache,
  layers: LayerManager,
  options: { name?: string } = {},
): Promise<string> {
  if (cache.kind === 'xyz') {
    return importGeneratedXyzToLayers(cache, layers, options);
  }
  if (cache.kind !== '3dtiles') {
    throw new Error(`暂不支持导入生成的 ${cache.kind} 缓存（生成侧支持 3dtiles / xyz）`);
  }
  const entryPath = normalizeRelativePath(cache.entry || 'tileset.json');
  const entryFile = cache.files.find((f) => normalizeRelativePath(f.path) === entryPath);
  if (!entryFile) {
    throw new Error(`生成缓存缺少入口文件：${entryPath}`);
  }

  const urlMap = new Map<string, string>();
  for (const file of cache.files) {
    urlMap.set(normalizeRelativePath(file.path), URL.createObjectURL(file.blob));
  }
  // rewriteTilesetJson 处理的是 tile 节点形态（content/children 挂在顶层），
  // 而真实 tileset.json 的内容挂在 root 上（本模块产物即 { asset, root }），
  // 因此对 root 再递归补写一次，保证 root.content.uri / root.children[].content.uri
  // 全部指向对应 blob URL。
  const json = JSON.parse(await entryFile.blob.text()) as TilesetNode & { root?: TilesetNode };
  const rewritten = rewriteTilesetJson(json, urlMap);
  if (rewritten.root) rewriteTilesetNode(rewritten.root, urlMap);
  const entryUrl = URL.createObjectURL(
    new Blob([JSON.stringify(rewritten)], { type: 'application/json' }),
  );

  const tileset = await Cesium3DTileset.fromUrl(entryUrl, { maximumScreenSpaceError: 16 });
  const layer = await layers.add3DTilesInstance(
    options.name ?? '生成的 3D Tiles 缓存',
    tileset,
    {
      url: entryPath,
      filename: entryPath,
      metadata: cache.metadata as unknown as Record<string, unknown>,
    },
  );
  layerUrlMaps.set(layer.id, urlMap);
  return layer.id;
}

/** 已注册生成图层的 blob URL 表（供释放） */
const layerUrlMaps = new Map<string, Map<string, string>>();

/** 释放某个生成图层持有的 blob URL（图层移除后调用，避免内存泄漏） */
export function revokeGeneratedLayerUrls(layerId: string): void {
  const urlMap = layerUrlMaps.get(layerId);
  if (!urlMap) return;
  for (const url of urlMap.values()) URL.revokeObjectURL(url);
  layerUrlMaps.delete(layerId);
}

// ---------------------------------------------------------------------------
// 与发布链路桥接（复用既有打包实现，不重复实现 zip）
// ---------------------------------------------------------------------------

/** GeneratedCache → zipCacheBundle 输入（复用 localCache.metadataToZipInputs） */
export function generatedCacheToZipInputs(cache: GeneratedCache): {
  rootDir: string;
  entries: ZipInputEntry[];
} {
  const byPath = new Map(cache.files.map((f) => [normalizeRelativePath(f.path), f.blob]));
  return metadataToZipInputs(cache.metadata, (path) => byPath.get(normalizeRelativePath(path)));
}

/** 直接打包为 publishScenePackage 可消费的 zip（zipCacheBundle 薄封装） */
export function zipGeneratedCache(
  cache: GeneratedCache,
  options: ZipBundleOptions = {},
): Promise<ZipBundleResult> {
  return zipCacheBundle(generatedCacheToZipInputs(cache), options);
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 单调不减的进度上报（夹紧到 0~1，异常不打断主流程） */
function createProgressReporter(onProgress?: (ratio: number) => void): (ratio: number) => void {
  let last = 0;
  return (ratio: number) => {
    const clamped = Math.min(1, Math.max(last, Number.isFinite(ratio) ? ratio : last));
    last = clamped;
    if (!onProgress) return;
    try {
      onProgress(clamped);
    } catch {
      // 进度回调异常不影响生成
    }
  };
}

/** 取文件名（去目录、去扩展名），并清洗为安全字符 */
function modelBaseName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'model';
  const withoutExt = base.replace(/\.[^.]+$/, '');
  const safe = withoutExt.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'model';
}

/** 宽松数值解析（缺失/非法 → 0） */
function number(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** ArrayBufferView / ArrayBuffer → ArrayBuffer（复制到独立缓冲区） */
function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const view = data as ArrayBufferView;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}
