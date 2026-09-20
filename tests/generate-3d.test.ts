/**
 * editor/core · localCache/generate3d —— 三维模型 → 3D Tiles 缓存生成 单测
 *
 * 覆盖：
 * - OBJ 解析（v/vn + 索引、负索引、多边形扇形三角化、缺法线时按几何计算）
 * - STL 解析（ASCII 面法线平直着色 / 二进制）
 * - AABB 计算（含退化包围盒钳制）
 * - tileset.json 结构（3D Tiles 1.1、boundingVolume.box、content.uri、transform 可选）
 * - root.transform（ENU→ECEF 列主序，与 Cesium 自身计算结果比对；scale 生效）
 * - generate3DTilesFromModel 端到端（GLB 可被 WebIO 读回、统计、progress 单调）
 * - 与发布链路桥接（generatedCacheToZipInputs / zipGeneratedCache → 真实 zip 条目）
 * - importGeneratedCacheToLayers（blob URL 重写 + metadata 透传 + 释放）
 */
import { Cesium3DTileset, Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import { WebIO } from '@gltf-transform/core';
import JSZip from 'jszip';
import assert from "node:assert/strict";
import { mock } from "node:test";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MockInstance } from 'node:test';

import type { LayerInfo, LayerManager, LayerSource } from '../LayerManager';
import { generateXyzFromGeoJSON } from '../packages/xyz-cache/src/generate-2d';
import type { TileCanvas, TileContext2D } from '../packages/xyz-cache/src/generate-2d';
import {
  buildModelGlb,
  buildRootTransform,
  buildTilesetJson,
  computeModelAabb,
  detectModelFormat,
  generate3DTilesFromModel,
  generatedCacheToZipInputs,
  importGeneratedCacheToLayers,
  mergeModels,
  parseObjText,
  parseStl,
  parseStlBinary,
  parseStlText,
  revokeGeneratedLayerUrls,
  zipGeneratedCache,
} from '../packages/xyz-cache/src/generate-3d';

/** vitest toBeCloseTo 等价：|a-b| < 10^-d / 2 */
const closeTo = (actual: number, expected: number, digits = 9): void => {
  assert.ok(Math.abs(actual - expected) < Math.pow(10, -digits) / 2, `closeTo: ${actual} !~ ${expected} (digits=${digits})`);
};


// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

/** 单位正方形（XY 平面）+ 文件法线 + 四边形面（应扇形三角化为 2 个三角面） */
const OBJ_WITH_NORMALS = `# quad
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vn 0 0 1
f 1//1 2//1 3//1 4//1
`;

/** 负索引 + 无文件法线（法线应由几何计算） */
const OBJ_NEGATIVE_INDEX = `v 0 0 0
v 1 0 0
v 0 1 0
f -3 -2 -1
`;

const OBJ_TRIANGLE = `v 0 0 0
v 2 0 0
v 0 2 0
vn 0 0 1
f 1//1 2//1 3//1
`;

const ASCII_STL = `solid tri
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid tri
`;

/** 造一个二进制 STL（1 个三角面）：84 字节头 + 50 字节记录 */
function buildBinaryStl(): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + 50);
  const view = new DataView(buffer);
  view.setUint32(80, 1, true);
  let offset = 84;
  for (const value of [0, 0, 1]) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  const coords = [0, 0, 0, 2, 0, 0, 0, 3, 0];
  for (const value of coords) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  view.setUint16(offset, 0, true);
  return buffer;
}

const PLACEMENT = {
  longitude: 116.3912,
  latitude: 39.9075,
  height: 50,
  heading: 30,
  pitch: 5,
  roll: -2,
  scale: 2,
};

/** 造一个带 name 的真实 File（Node 22 提供全局 File/Blob） */
function modelFile(name: string, content: string | ArrayBuffer, type = 'text/plain'): File {
  return new File([content], name, { type });
}

function createFakeLayerManager(): {
  manager: LayerManager;
  calls: Array<{ name: string; source: Partial<LayerSource>; tileset: unknown }>;
  imageryCalls: Array<{
    name: string;
    provider: unknown;
    source: Partial<LayerSource>;
    options: Record<string, unknown>;
  }>;
} {
  const calls: Array<{ name: string; source: Partial<LayerSource>; tileset: unknown }> = [];
  const imageryCalls: Array<{
    name: string;
    provider: unknown;
    source: Partial<LayerSource>;
    options: Record<string, unknown>;
  }> = [];
  const manager = {
    add3DTilesInstance: (
      name: string,
      tileset: unknown,
      source: Partial<LayerSource> = {},
    ): Promise<LayerInfo> => {
      calls.push({ name, tileset, source });
      return Promise.resolve({
        id: `layer-${calls.length}`,
        name,
        type: '3dtiles',
        show: true,
        opacity: 1,
      });
    },
    addImageryLayerInstance: (
      name: string,
      provider: unknown,
      source: Partial<LayerSource> = {},
      options: Record<string, unknown> = {},
    ): LayerInfo => {
      imageryCalls.push({ name, provider, source, options });
      return {
        id: `imagery-${imageryCalls.length}`,
        name,
        type: 'imagery',
        show: true,
        opacity: 1,
      };
    },
  } as unknown as LayerManager;
  return { manager, calls, imageryCalls };
}

// ---------------------------------------------------------------------------
// 格式判别 / OBJ
// ---------------------------------------------------------------------------

describe('generate3d · 格式判别与 OBJ 解析', () => {
  it('detectModelFormat 只认 obj / stl（不区分大小写，忽略目录）', () => {
    assert.strictEqual(detectModelFormat('a.obj'), 'obj');
    assert.strictEqual(detectModelFormat('dir/B.OBJ'), 'obj');
    assert.strictEqual(detectModelFormat('C:\\models\\c.StL'), 'stl');
    assert.strictEqual(detectModelFormat('a.glb'), undefined);
    assert.strictEqual(detectModelFormat('a.ply'), undefined);
  });

  it('OBJ：四边形面扇形三角化 + 文件法线保留 + 同 (v,vn) 顶点去重', () => {
    const model = parseObjText(OBJ_WITH_NORMALS);
    assert.strictEqual(model.vertices, 4);
    assert.strictEqual(model.triangles, 2);
    assert.strictEqual(model.normalsFromFile, true);
    assert.deepStrictEqual(Array.from(model.indices), [0, 1, 2, 0, 2, 3]);
    assert.deepStrictEqual(Array.from(model.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    for (let i = 0; i < model.normals.length; i += 3) {
      assert.deepStrictEqual([model.normals[i], model.normals[i + 1], model.normals[i + 2]], [0, 0, 1]);
    }
  });

  it('OBJ：负索引解析 + 缺法线时由几何计算单位法线', () => {
    const model = parseObjText(OBJ_NEGATIVE_INDEX);
    assert.strictEqual(model.vertices, 3);
    assert.strictEqual(model.triangles, 1);
    assert.strictEqual(model.normalsFromFile, false);
    assert.deepStrictEqual(Array.from(model.indices), [0, 1, 2]);
    for (let i = 0; i < model.normals.length; i += 3) {
      const len = Math.hypot(model.normals[i]!, model.normals[i + 1]!, model.normals[i + 2]!);
      closeTo(len, 1, 6);
      closeTo(model.normals[i + 2], 1, 6); // XY 平面 → +Z
    }
  });

  it('OBJ：部分面缺法线时整模型改由几何计算（不使用半套文件法线）', () => {
    const model = parseObjText(`v 0 0 0
v 1 0 0
v 0 1 0
vn 0 0 -1
f 1//1 2//1 3//1
f 1 2 3
`);
    assert.strictEqual(model.normalsFromFile, false);
    assert.strictEqual(model.triangles, 2);
    for (let i = 0; i < model.normals.length; i += 3) {
      assert.ok(model.normals[i + 2] > (0)); // 忽略文件里的 -Z，按几何算得 +Z
    }
  });

  it('OBJ：越界/非法索引给出明确错误', () => {
    assert.throws(() => parseObjText('v 0 0 0\nf 1 2 3\n'), /不存在的顶点索引/);
    assert.throws(() => parseObjText('v 0 0 0\nf 0 1 1\n'), /非法顶点索引/);
  });
});

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

describe('generate3d · STL 解析', () => {
  it('ASCII STL：面法线平直着色、逐面独立顶点', () => {
    const model = parseStlText(ASCII_STL);
    assert.strictEqual(model.triangles, 1);
    assert.strictEqual(model.vertices, 3);
    assert.deepStrictEqual(Array.from(model.positions), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepStrictEqual(Array.from(model.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('二进制 STL：解析三角面与法线', () => {
    const buffer = buildBinaryStl();
    const model = parseStlBinary(buffer);
    assert.strictEqual(model.triangles, 1);
    assert.strictEqual(model.vertices, 3);
    assert.deepStrictEqual(Array.from(model.positions), [0, 0, 0, 2, 0, 0, 0, 3, 0]);
    assert.deepStrictEqual(Array.from(model.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('parseStl 自动判别 ASCII / 二进制', () => {
    assert.strictEqual(parseStl(new TextEncoder().encode(ASCII_STL).buffer).triangles, 1);
    assert.strictEqual(parseStl(buildBinaryStl()).triangles, 1);
  });

  it('空 STL 报错', () => {
    assert.throws(() => parseStlText('solid empty\nendsolid empty\n'), /未解析到任何三角面/);
  });
});

// ---------------------------------------------------------------------------
// AABB / tileset.json / transform
// ---------------------------------------------------------------------------

describe('generate3d · AABB 与 tileset.json', () => {
  it('computeModelAabb：min/max/center/halfSize 与 boundingVolume.box', () => {
    const aabb = computeModelAabb(new Float32Array([-1, -2, -3, 3, 4, 5]));
    assert.deepStrictEqual(aabb.min, [-1, -2, -3]);
    assert.deepStrictEqual(aabb.max, [3, 4, 5]);
    assert.deepStrictEqual(aabb.center, [1, 1, 1]);
    assert.deepStrictEqual(aabb.halfSize, [2, 3, 4]);
    assert.deepStrictEqual(aabb.box, [1, 1, 1, 2, 0, 0, 0, 3, 0, 0, 0, 4]);
  });

  it('computeModelAabb：退化模型半轴长钳制为非零（避免零体积包围盒）', () => {
    const aabb = computeModelAabb(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]));
    assert.strictEqual(aabb.halfSize.every((v) => v > 0), true);
    closeTo(aabb.halfSize[0], 1e-6, 12);
  });

  it('buildTilesetJson：3D Tiles 1.1 + content.uri + box；无 transform 时省略该字段', () => {
    const aabb = computeModelAabb(new Float32Array([0, 0, 0, 2, 2, 2]));
    const tileset = buildTilesetJson({ contentUri: 'model.glb', aabb });
    assert.strictEqual(tileset.asset.version, '1.1');
    assert.strictEqual(tileset.root.content.uri, 'model.glb');
    assert.deepStrictEqual(tileset.root.boundingVolume.box, aabb.box);
    assert.strictEqual(tileset.root.geometricError, 0);
    assert.strictEqual('transform' in tileset.root, false);
    // 可被 Cesium tileset 结构消费的关键字段齐备
    assert.deepStrictEqual(Object.keys(tileset.root).sort(), [
      'boundingVolume',
      'content',
      'geometricError',
    ]);
  });

  it('buildTilesetJson：给定 transform 时写入列主序 16 元数组', () => {
    const aabb = computeModelAabb(new Float32Array([0, 0, 0, 1, 1, 1]));
    const transform = buildRootTransform(PLACEMENT)!;
    const tileset = buildTilesetJson({ contentUri: 'm.glb', aabb, transform });
    assert.strictEqual(tileset.root.transform.length, (16));
    assert.deepStrictEqual(tileset.root.transform, transform);
  });
});

describe('generate3d · root.transform（ENU→ECEF）', () => {
  it('零姿态时等于 Cesium 的 eastNorthUpToFixedFrame，平移分量 = 站心 ECEF 原点', () => {
    const placement = {
      longitude: PLACEMENT.longitude,
      latitude: PLACEMENT.latitude,
      height: PLACEMENT.height,
    };
    const transform = buildRootTransform(placement)!;
    const origin = Cartesian3.fromDegrees(placement.longitude, placement.latitude, placement.height);
    const expected = Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(origin)) as number[];
    assert.strictEqual(transform.length, (16));
    for (let i = 0; i < 16; i++) closeTo(transform[i], expected[i]!, 6);
    // 列主序 12..14 为平移 = ECEF 原点
    closeTo(transform[12], origin.x, 6);
    closeTo(transform[13], origin.y, 6);
    closeTo(transform[14], origin.z, 6);
  });

  it('含 heading/pitch/roll 且 scale=1 时与 Cesium headingPitchRollToFixedFrame 逐元素一致', () => {
    const transform = buildRootTransform({ ...PLACEMENT, scale: 1 })!;
    const expected = Matrix4.toArray(
      Transforms.headingPitchRollToFixedFrame(
        Cartesian3.fromDegrees(PLACEMENT.longitude, PLACEMENT.latitude, PLACEMENT.height),
        new HeadingPitchRoll(
          CesiumMath.toRadians(PLACEMENT.heading),
          CesiumMath.toRadians(PLACEMENT.pitch),
          CesiumMath.toRadians(PLACEMENT.roll),
        ),
      ),
    ) as number[];
    for (let i = 0; i < 16; i++) closeTo(transform[i], expected[i]!, 6);
  });

  it('scale 生效：列向量模长按比例放大，且平移不变', () => {
    const base = buildRootTransform({ ...PLACEMENT, scale: 1 })!;
    const scaled = buildRootTransform({ ...PLACEMENT, scale: 3 })!;
    const norm = (arr: number[], col: number): number =>
      Math.hypot(arr[col * 4]!, arr[col * 4 + 1]!, arr[col * 4 + 2]!);
    closeTo(norm(scaled, 0) / norm(base, 0), 3, 6);
    assert.deepStrictEqual(scaled.slice(12, 15), base.slice(12, 15));
  });

  it('heading 旋转改变朝向（与 0 度不同），且仍是正交基', () => {
    const rotated = buildRootTransform({ ...PLACEMENT, heading: 90, pitch: 0, roll: 0, scale: 1 })!;
    const plain = buildRootTransform({ ...PLACEMENT, heading: 0, pitch: 0, roll: 0, scale: 1 })!;
    assert.notDeepStrictEqual(rotated.slice(0, 12), plain.slice(0, 12));
    const norm = (col: number): number =>
      Math.hypot(rotated[col * 4]!, rotated[col * 4 + 1]!, rotated[col * 4 + 2]!);
    for (const col of [0, 1, 2]) closeTo(norm(col), 1, 6);
  });

  it('无有效经纬度（缺省 / 非有限值）时返回 undefined（调用方省略 transform）', () => {
    assert.strictEqual(buildRootTransform(undefined), undefined);
    assert.strictEqual(buildRootTransform(null), undefined);
    assert.strictEqual(buildRootTransform({ longitude: Number.NaN, latitude: 39 }), undefined);
  });
});

// ---------------------------------------------------------------------------
// 生成入口端到端
// ---------------------------------------------------------------------------

describe('generate3d · generate3DTilesFromModel', () => {
  it('OBJ → 3D Tiles 1.1：文件清单 / metadata / stats 完整，GLB 可被 WebIO 读回', async () => {
    const ratios: number[] = [];
    const cache = await generate3DTilesFromModel(
      [modelFile('quad.obj', OBJ_WITH_NORMALS)],
      PLACEMENT,
      { onProgress: (r) => ratios.push(r) },
    );

    assert.strictEqual(cache.kind, '3dtiles');
    assert.strictEqual(cache.entry, 'tileset.json');
    assert.deepStrictEqual(cache.files.map((f) => f.path), ['tileset.json', 'quad.glb']);
    assert.strictEqual(cache.stats.vertices, 4);
    assert.strictEqual(cache.stats.triangles, 2);
    assert.strictEqual(cache.stats.fileCount, 2);
    assert.ok(cache.stats.totalBytes > (0));

    // metadata 可直接写入 LayerSource.metadata（含 cacheSource:'generated'）
    assert.strictEqual(cache.metadata.cacheKind, '3dtiles');
    assert.strictEqual(cache.metadata.cacheSource, 'generated');
    assert.strictEqual(cache.metadata.rootDir, '');
    assert.strictEqual(cache.metadata.detection?.tilesetPath, 'tileset.json');
    assert.deepStrictEqual(cache.metadata.files.map((f) => f.path), ['tileset.json', 'quad.glb']);
    assert.strictEqual(cache.metadata.totalBytes, cache.files.reduce((sum, f) => sum + f.blob.size, 0),);

    // tileset.json 内容
    const tileset = JSON.parse(await cache.files[0]!.blob.text()) as {
      asset: { version: string };
      root: { content: { uri: string }; boundingVolume: { box: number[] }; transform: number[] };
    };
    assert.strictEqual(tileset.asset.version, '1.1');
    assert.strictEqual(tileset.root.content.uri, 'quad.glb');
    assert.deepStrictEqual(tileset.root.boundingVolume.box, [0.5, 0.5, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 1e-6]);
    assert.deepStrictEqual(tileset.root.transform, buildRootTransform(PLACEMENT));

    // GLB：魔数 + 读回后 POSITION/NORMAL 宽度与索引一致
    const glbBytes = new Uint8Array(await cache.files[1]!.blob.arrayBuffer());
    assert.strictEqual(new TextDecoder().decode(glbBytes.slice(0, 4)), 'glTF');
    const doc = await new WebIO().readBinary(glbBytes);
    const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    assert.strictEqual(prim.getAttribute('POSITION')!.getCount(), 4);
    assert.strictEqual(prim.getAttribute('NORMAL')!.getCount(), 4);
    assert.strictEqual(prim.getIndices()!.getCount(), 6);
    assert.deepStrictEqual(Array.from(prim.getIndices()!.getArray() as Uint16Array), [0, 1, 2, 0, 2, 3]);

    // progress：从 0 到 1 单调不减
    assert.strictEqual(ratios[0], 0);
    assert.strictEqual(ratios.at(-1), 1);
    for (let i = 1; i < ratios.length; i++) assert.ok(ratios[i]! >= (ratios[i - 1]!));
  });

  it('STL（二进制）同样可生成；多个模型合并为一个网格（索引带偏移）', async () => {
    const single = await generate3DTilesFromModel(
      [modelFile('tri.stl', buildBinaryStl(), 'application/sla')],
      { longitude: 120, latitude: 30 },
    );
    assert.strictEqual(single.stats.triangles, 1);
    const tileset = JSON.parse(await single.files[0]!.blob.text()) as { root: { transform?: number[] } };
    assert.notStrictEqual(tileset.root.transform, undefined);

    const merged = await generate3DTilesFromModel(
      [modelFile('quad.obj', OBJ_WITH_NORMALS), modelFile('tri.obj', OBJ_TRIANGLE)],
      PLACEMENT,
    );
    assert.strictEqual(merged.stats.vertices, 7);
    assert.strictEqual(merged.stats.triangles, 3);
    assert.deepStrictEqual(merged.files.map((f) => f.path), ['tileset.json', 'quad.glb']);

    const mergedDoc = await new WebIO().readBinary(
      new Uint8Array(await merged.files[1]!.blob.arrayBuffer()),
    );
    const indices = Array.from(
      mergedDoc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getIndices()!.getArray() as Uint16Array,
    );
    assert.deepStrictEqual(indices.slice(0, 6), [0, 1, 2, 0, 2, 3]);
    assert.deepStrictEqual(indices.slice(6), [4, 5, 6]); // 第二个模型索引偏移 +4
  });

  it('无模型文件 / 不支持的格式给出明确错误', async () => {
    await assert.rejects(generate3DTilesFromModel([], PLACEMENT), /未选择任何文件/);
    await assert.rejects(generate3DTilesFromModel([modelFile('a.ply', 'ply\n')], PLACEMENT), /未找到可解析的三维模型文件（支持 \.obj \/ \.stl）/);
    await assert.rejects(generate3DTilesFromModel([modelFile('tc.obj', '# 空模型\n')], PLACEMENT), /不含任何三角面/);
  });

  it('placement 非有限经纬度时不写 transform（模型保持局部坐标）', async () => {
    const cache = await generate3DTilesFromModel([modelFile('quad.obj', OBJ_WITH_NORMALS)], {
      longitude: Number.NaN,
      latitude: 39,
    });
    const tileset = JSON.parse(await cache.files[0]!.blob.text()) as { root: Record<string, unknown> };
    assert.strictEqual('transform' in tileset.root, false);
  });
});

describe('generate3d · mergeModels / buildModelGlb', () => {
  it('mergeModels 合并顶点与索引并累计统计', () => {
    const merged = mergeModels([parseObjText(OBJ_WITH_NORMALS), parseObjText(OBJ_TRIANGLE)]);
    assert.strictEqual(merged.vertices, 7);
    assert.strictEqual(merged.triangles, 3);
    assert.deepStrictEqual(Array.from(merged.indices), [0, 1, 2, 0, 2, 3, 4, 5, 6]);
    assert.throws(() => mergeModels([]), /不含任何三角面/);
  });

  it('buildModelGlb 输出可被 WebIO 读回的 GLB（scene / mesh / POSITION 齐备）', async () => {
    const model = parseObjText(OBJ_TRIANGLE);
    const bytes = await buildModelGlb(model);
    assert.strictEqual(new TextDecoder().decode(bytes.slice(0, 4)), 'glTF');
    const doc = await new WebIO().readBinary(bytes);
    assert.strictEqual(doc.getRoot().listScenes().length, (1));
    assert.strictEqual(doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!.getCount(), 3);
  });
});

// ---------------------------------------------------------------------------
// 发布链路桥接
// ---------------------------------------------------------------------------

describe('generate3d · zip 桥接（复用 zipCacheBundle）', () => {
  it('generatedCacheToZipInputs 与 cache.files 一一对应', async () => {
    const cache = await generate3DTilesFromModel([modelFile('quad.obj', OBJ_WITH_NORMALS)], PLACEMENT);
    const inputs = generatedCacheToZipInputs(cache);
    assert.strictEqual(inputs.rootDir, '');
    assert.deepStrictEqual(inputs.entries.map((e) => e.path), ['tileset.json', 'quad.glb']);
    assert.strictEqual(inputs.entries.every((e) => e.data instanceof Blob), true);
  });

  it('zipGeneratedCache 产出真实 zip（含 tileset.json + model.glb，可交 publishScenePackage）', async () => {
    const cache = await generate3DTilesFromModel([modelFile('quad.obj', OBJ_WITH_NORMALS)], PLACEMENT);
    const result = await zipGeneratedCache(cache);
    assert.strictEqual(result.fileCount, 2);
    assert.strictEqual(result.totalBytes, cache.metadata.totalBytes);

    const zip = await JSZip.loadAsync(await result.zip.arrayBuffer());
    assert.deepStrictEqual(Object.keys(zip.files).sort(), ['quad.glb', 'tileset.json']);
    const tilesetText = await zip.file('tileset.json')!.async('string');
    assert.strictEqual((JSON.parse(tilesetText) as { asset: { version: string } }).asset.version, '1.1');
    const glb = await zip.file('quad.glb')!.async('uint8array');
    assert.strictEqual(new TextDecoder().decode(glb.slice(0, 4)), 'glTF');
  });
});

// ---------------------------------------------------------------------------
// 注册为图层（Cesium 预览入口）
// ---------------------------------------------------------------------------

describe('generate3d · importGeneratedCacheToLayers', () => {
  const created = new Map<string, Blob>();
  let createSpy: MockInstance;
  let revokeSpy: MockInstance;
  let fromUrlSpy: MockInstance;

  beforeEach(() => {
    created.clear();
    createSpy = mock.method(URL, 'createObjectURL', (obj: Blob | MediaSource) => {
      const url = `blob:test/${created.size}`;
      created.set(url, obj as Blob);
      return url;
    });
    revokeSpy = mock.method(URL, 'revokeObjectURL', () => undefined);
    fromUrlSpy = mock.method(Cesium3DTileset, 'fromUrl', async () => ({ isDestroyed: () => false } as never));
  });

  afterEach(() => {
    createSpy.mock.restore();
    revokeSpy.mock.restore();
    fromUrlSpy.mock.restore();
  });

  it('把包内文件转为 blob URL、改写 content.uri、透传 metadata 并返回图层 id', async () => {
    const cache = await generate3DTilesFromModel([modelFile('quad.obj', OBJ_WITH_NORMALS)], PLACEMENT);
    const { manager, calls } = createFakeLayerManager();

    const layerId = await importGeneratedCacheToLayers(cache, manager, { name: '生成的缓存图层' });

    assert.strictEqual(layerId, 'layer-1');
    assert.strictEqual(calls.length, (1));
    assert.strictEqual(calls[0]!.name, '生成的缓存图层');
    assert.strictEqual(calls[0]!.source.url, 'tileset.json');
    assert.strictEqual(calls[0]!.source.filename, 'tileset.json');
    assert.strictEqual(calls[0]!.source.metadata?.cacheSource, 'generated');
    assert.strictEqual(calls[0]!.source.metadata?.cacheKind, '3dtiles');

    // 交给 Cesium 的是「重写后的 tileset.json」blob URL，且 content.uri 指向 GLB 的 blob URL
    const entryUrl = fromUrlSpy.mock.calls[0]!.arguments[0] as string;
    assert.strictEqual(entryUrl.startsWith('blob:'), true);
    const rewritten = JSON.parse(await created.get(entryUrl)!.text()) as {
      asset: { version: string };
      root: { content: { uri: string } };
    };
    assert.strictEqual(rewritten.asset.version, '1.1');
    assert.strictEqual(rewritten.root.content.uri.startsWith('blob:'), true);
    assert.strictEqual(created.get(rewritten.root.content.uri)!.size, cache.files.find((f) => f.path === 'quad.glb')!.blob.size,);

    // 释放：所有 blob URL 被 revoke，且重复调用安全
    revokeGeneratedLayerUrls(layerId);
    assert.strictEqual(revokeSpy.mock.calls.length, 2);
    revokeGeneratedLayerUrls(layerId);
    assert.strictEqual(revokeSpy.mock.calls.length, 2);
  });

  it('默认图层名 / 非 3dtiles 结果 / 缺入口文件给出明确错误', async () => {
    const cache = await generate3DTilesFromModel([modelFile('quad.obj', OBJ_WITH_NORMALS)], PLACEMENT);
    const { manager, calls } = createFakeLayerManager();
    await importGeneratedCacheToLayers(cache, manager);
    assert.strictEqual(calls[0]!.name, '生成的 3D Tiles 缓存');

    // kind='xyz' 分发到 generate2d 的导入路径（此处文件非 {z}/{x}/{y}.png → 报无瓦片）
    await assert.rejects(importGeneratedCacheToLayers({ ...cache, kind: 'xyz' }, manager), /不含任何可识别的 XYZ 瓦片/);
    await assert.rejects(importGeneratedCacheToLayers(
        { ...cache, kind: 'bogus' } as unknown as typeof cache,
        manager,
      ), /暂不支持导入生成的 bogus 缓存/);
    await assert.rejects(importGeneratedCacheToLayers({ ...cache, files: [] }, manager), /缺少入口文件/);
  });

  it('kind=xyz 的生成缓存经统一入口分发到 XYZ 图层（t13 桥接）', async () => {
    // node 测试环境无 Canvas，注入最小假画布工厂
    const fakeCanvasFactory = (width: number, height: number): TileCanvas => {
      const context = {
        lineJoin: '',
        lineCap: '',
        beginPath: () => undefined,
        arc: () => undefined,
        moveTo: () => undefined,
        lineTo: () => undefined,
        closePath: () => undefined,
        fill: () => undefined,
        stroke: () => undefined,
        getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) }),
      };
      return {
        context: context as unknown as TileContext2D,
        toPngBlob: async () => new Blob([`png-${width}x${height}`], { type: 'image/png' }),
      };
    };
    const xyzCache = await generateXyzFromGeoJSON(
      {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: {} },
        ],
      } as never,
      { minZoom: 3, maxZoom: 3, canvasFactory: fakeCanvasFactory },
    );
    const { manager, imageryCalls } = createFakeLayerManager();

    const layerId = await importGeneratedCacheToLayers(xyzCache, manager, { name: 'xyz 图层' });

    assert.strictEqual(layerId, 'imagery-1');
    assert.strictEqual(imageryCalls.length, (1));
    assert.strictEqual(imageryCalls[0]!.name, 'xyz 图层');
    assert.notStrictEqual(imageryCalls[0]!.provider, undefined);
    assert.strictEqual(imageryCalls[0]!.source.metadata?.cacheSource, 'generated');
    assert.strictEqual(imageryCalls[0]!.source.metadata?.cacheKind, 'xyz');
  });
});
