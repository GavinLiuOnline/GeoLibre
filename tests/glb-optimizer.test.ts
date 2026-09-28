import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Document, WebIO } from '@gltf-transform/core';

import { optimizeGlb } from '../packages/processing/src/glb-optimizer';

/** 构造 4x4 网格 GLB（25 顶点 / 32 三角面，带起伏）用于轻量化测试 */
async function createGridGlb(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer('grid');
  const N = 4;
  const positions: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      positions.push(i, j, Math.sin(i * 1.3) * 0.1 + Math.cos(j * 0.9) * 0.1);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + N + 1;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const position = doc
    .createAccessor('position')
    .setType('VEC3')
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const index = doc
    .createAccessor('index')
    .setType('SCALAR')
    .setArray(new Uint32Array(indices))
    .setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(index);
  const mesh = doc.createMesh('grid').addPrimitive(prim);
  const node = doc.createNode('grid').setMesh(mesh);
  doc.createScene('scene').addChild(node);
  return await new WebIO().writeBinary(doc);
}

describe('optimizeGlb GLB 轻量化', () => {
  it('网格简化减少三角面，并输出前后体积对比', async () => {
    const glb = await createGridGlb();
    const result = await optimizeGlb(glb, {
      simplifyRatio: 0.1,
      simplifyError: 0.5,
    });

    assert.strictEqual((result.beforeBytes), glb.length);
    assert.ok((result.afterBytes) > (0));
    assert.strictEqual((result.beforeStats.triangles), 32);
    assert.strictEqual((result.beforeStats.vertices), 25);
    assert.ok((result.afterStats.triangles) < (32));
    assert.ok((result.afterStats.triangles) <= (result.beforeStats.triangles));
    assert.ok(Math.abs((result.ratio) - (result.afterBytes / result.beforeBytes)) < Math.pow(10, -(6)) / 2);
  });

  it('关闭简化时三角面保持不变', async () => {
    const glb = await createGridGlb();
    const result = await optimizeGlb(glb, { simplify: false });
    assert.strictEqual((result.afterStats.triangles), 32);
    assert.strictEqual((result.afterStats.vertices), 25);
  });

  it('meshopt 压缩路径输出有效 GLB（EXT_meshopt_compression）', async () => {
    const glb = await createGridGlb();
    const result = await optimizeGlb(glb, { simplify: false, compression: 'meshopt' });
    assert.ok((result.afterBytes) > (0));

    const io = new WebIO();
    const jsonDoc = await io.binaryToJSON(result.data);
    assert.ok((jsonDoc.json.extensionsUsed ?? []).includes('EXT_meshopt_compression'));
  });

  it('支持 Blob 输入', async () => {
    const glb = await createGridGlb();
    const result = await optimizeGlb(new Blob([glb as BlobPart]), { simplify: false });
    assert.strictEqual((result.beforeBytes), glb.length);
  });
});
