/**
 * editor/core · optimizer/glbOptimizer —— GLB/glTF 数据轻量化
 *
 * 基于 @gltf-transform：weld（焊接重复顶点）+ dedup（去重）+ simplify（网格简化，meshoptimizer）
 * + prune（剔除未引用资源），可选 meshopt 压缩（Draco 可按同一扩展模式自行注册）。
 * 返回轻量化前后字节体积对比 { beforeBytes, afterBytes } 与网格统计。
 *
 * I/O 使用 WebIO（无 node:fs 依赖，浏览器打包安全）；GLB 为自包含格式，不触发外部 URI 解析。
 */
import { Primitive, WebIO } from '@gltf-transform/core';
import type { Document } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

export interface GlbOptimizeOptions {
  /** 焊接重复顶点（默认 true） */
  weld?: boolean;
  /** 去重 accessors/materials/textures 等（默认 true） */
  dedup?: boolean;
  /** 网格简化（默认 true，基于 meshoptimizer） */
  simplify?: boolean;
  /** 简化目标顶点保留比例 0~1（默认 0.5） */
  simplifyRatio?: number;
  /** 简化误差上限（网格半径的比例，默认 0.01） */
  simplifyError?: number;
  /** 剔除未引用的节点/材质/纹理等（默认 true） */
  prune?: boolean;
  /** 输出压缩：'none'（默认）| 'meshopt'（KHR_meshopt_compression） */
  compression?: 'none' | 'meshopt';
}

/** 网格统计 */
export interface GlbMeshStats {
  vertices: number;
  triangles: number;
  meshes: number;
}

export interface GlbOptimizeResult {
  /** 轻量化后的 GLB 字节 */
  data: Uint8Array;
  /** 输入字节数 */
  beforeBytes: number;
  /** 输出字节数 */
  afterBytes: number;
  /** afterBytes / beforeBytes */
  ratio: number;
  beforeStats: GlbMeshStats;
  afterStats: GlbMeshStats;
}

/** GLB 轻量化：输入字节/Blob/URL，输出轻量版字节与前后体积对比 */
export async function optimizeGlb(
  source: Uint8Array | ArrayBuffer | Blob | string,
  options: GlbOptimizeOptions = {},
): Promise<GlbOptimizeResult> {
  const bytes = await toBytes(source);
  const io = new WebIO();
  const useMeshopt = (options.compression ?? 'none') === 'meshopt';
  if (useMeshopt) {
    await MeshoptEncoder.ready;
    io.registerExtensions([EXTMeshoptCompression]);
    io.registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  }
  const document = await io.readBinary(bytes);
  const beforeStats = collectMeshStats(document);

  const transforms: Array<Parameters<Document['transform']>[0]> = [];
  if (options.weld ?? true) transforms.push(weld());
  if (options.dedup ?? true) transforms.push(dedup());
  if (options.simplify ?? true) {
    await MeshoptSimplifier.ready;
    transforms.push(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: options.simplifyRatio ?? 0.5,
        error: options.simplifyError ?? 0.01,
      }),
    );
  }
  if (transforms.length > 0) {
    await document.transform(...transforms);
  }
  if (options.prune ?? true) {
    await document.transform(prune());
  }
  if (useMeshopt) {
    // reorder + quantize + 写入 KHR_meshopt_compression（需 encoder 就绪）
    await document.transform(meshopt({ encoder: MeshoptEncoder }));
  }

  const data = await io.writeBinary(document);
  const afterStats = collectMeshStats(document);
  return {
    data,
    beforeBytes: bytes.length,
    afterBytes: data.length,
    ratio: data.length / Math.max(bytes.length, 1),
    beforeStats,
    afterStats,
  };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

async function toBytes(source: Uint8Array | ArrayBuffer | Blob | string): Promise<Uint8Array> {
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`拉取 GLB 失败：${res.status} ${res.statusText}（${source}）`);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (source instanceof Blob) {
    return new Uint8Array(await source.arrayBuffer());
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  }
  return source;
}

/** 统计网格顶点/三角面数量（用于轻量化前后对比） */
function collectMeshStats(document: Document): GlbMeshStats {
  let vertices = 0;
  let triangles = 0;
  let meshes = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    meshes++;
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION');
      if (position) vertices += position.getCount();
      if (prim.getMode() === Primitive.Mode.TRIANGLES) {
        const indices = prim.getIndices();
        const count = indices ? indices.getCount() : (position?.getCount() ?? 0);
        triangles += Math.floor(count / 3);
      }
    }
  }
  return { vertices, triangles, meshes };
}
