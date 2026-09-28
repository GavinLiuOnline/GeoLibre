/**
 * editor/core · localCache/bounds 单测（t30）
 *
 * 覆盖：瓦片键集合 → lon/lat 矩形（XYZ / TMS / Geographic）、全球范围、
 * bounds 归一化校验；数值口径与 generate2d 的 tileXToLon/tileYToLat 一致。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MERCATOR_MAX_LAT, tileXToLon, tileYToLat } from '../packages/xyz-cache/src/generate-2d';
import { boundsFromTileKeys, globalBounds, normalizeBounds } from '../packages/xyz-cache/src/bounds';

/** vitest toBeCloseTo 等价：|a-b| < 10^-d / 2 */
const closeTo = (actual: number, expected: number, digits = 9): void => {
  assert.ok(Math.abs(actual - expected) < Math.pow(10, -digits) / 2, `closeTo: ${actual} !~ ${expected} (digits=${digits})`);
};


describe('t30 · boundsFromTileKeys（XYZ，web-mercator）', () => {
  it('单瓦片 z1：键 1/0/0（西北象限）→ 该瓦片经纬度矩形', () => {
    const b = boundsFromTileKeys(['1/0/0']);
    assert.notStrictEqual(b, undefined);
    const [minLon, minLat, maxLon, maxLat] = b!;
    closeTo(minLon, tileXToLon(0, 1), 9);
    closeTo(maxLon, tileXToLon(1, 1), 9);
    closeTo(maxLat, tileYToLat(0, 1), 9);
    closeTo(minLat, tileYToLat(1, 1), 9);
    // 西北象限：经度 -180~0、纬度 0~85.05
    closeTo(minLon, -180, 9);
    closeTo(maxLon, 0, 9);
    closeTo(minLat, 0, 9);
    closeTo(maxLat, MERCATOR_MAX_LAT, 6);
  });

  it('多层级键集合：取最大层级的 min/max x,y', () => {
    // z1 有 0/0、0/1；z2 有 2/1、3/2 → 取 z2
    const b = boundsFromTileKeys(['1/0/0', '1/0/1', '2/2/1', '2/3/2']);
    assert.notStrictEqual(b, undefined);
    const [minLon, minLat, maxLon, maxLat] = b!;
    closeTo(minLon, tileXToLon(2, 2), 9);
    closeTo(maxLon, tileXToLon(4, 2), 9);
    closeTo(maxLat, tileYToLat(1, 2), 9);
    closeTo(minLat, tileYToLat(3, 2), 9);
    // 返回值有序：minLon < maxLon、minLat < maxLat
    assert.ok(minLon < (maxLon));
    assert.ok(minLat < (maxLat));
  });

  it('非最大层级的键不影响结果；空集合返回 undefined', () => {
    assert.notStrictEqual(boundsFromTileKeys(['2/1/1']), undefined);
    assert.strictEqual(boundsFromTileKeys([]), undefined);
  });

  it('非法键被跳过（非整数 / 负数 / 段数不对）', () => {
    assert.strictEqual(boundsFromTileKeys(['bad', '1/0', '1/0/0/x', '-1/0/0', '1/0/-1']), undefined);
  });
});

describe('t30 · boundsFromTileKeys（TMS / Geographic）', () => {
  it('TMS：y 自南向北，与 XYZ 同键集合的纬度范围上下翻转', () => {
    // XYZ：y=0 是最北；TMS：y=0 是最南。z1 南半球 = XYZ y=1 = TMS y=0。
    const xyz = boundsFromTileKeys(['1/0/1']);
    const tms = boundsFromTileKeys(['1/0/0'], { tms: true });
    assert.notStrictEqual(xyz, undefined);
    assert.notStrictEqual(tms, undefined);
    // 两个键描述的是**同一地理瓦片**（z1 南半球）→ 范围一致
    closeTo(tms![0], xyz![0], 9);
    closeTo(tms![1], xyz![1], 9);
    closeTo(tms![2], xyz![2], 9);
    closeTo(tms![3], xyz![3], 9);
    // 南半球：minLat < 0 < maxLat
    assert.ok(tms![1] < (0));
    closeTo(tms![3], 0, 9);
  });

  it('TMS 覆盖整行（y=0 与 y=1）→ 全球范围', () => {
    const b = boundsFromTileKeys(['1/0/0', '1/0/1'], { tms: true });
    closeTo(b![1], -MERCATOR_MAX_LAT, 6);
    closeTo(b![3], MERCATOR_MAX_LAT, 6);
  });

  it('Geographic（经纬度直方格，2×1 根瓦片 → 2^(z+1) 列）：z1 x=0,y=0 → lon -180~-90, lat 0~90', () => {
    const b = boundsFromTileKeys(['1/0/0'], { tilingMode: 'geographic' });
    // z1：4 列 × 2 行（每行 90°）；x=0 → lon -180~-90，y=0（北起）→ lat 0~90
    closeTo(b![3], 90, 9);
    closeTo(b![1], 0, 9);
    closeTo(b![0], -180, 9);
    closeTo(b![2], -90, 9);
  });

  it('Geographic + TMS：y 自南向北', () => {
    const b = boundsFromTileKeys(['1/0/0'], { tilingMode: 'geographic', tms: true });
    // z1 TMS y=0：最南行 lat -90~0
    closeTo(b![1], -90, 9);
    closeTo(b![3], 0, 9);
  });
});

describe('t30 · globalBounds / normalizeBounds', () => {
  it('globalBounds：web-mercator 钳制到 ±85.0511，geographic ±90', () => {
    assert.deepStrictEqual(globalBounds('web-mercator'), [-180, -MERCATOR_MAX_LAT, 180, MERCATOR_MAX_LAT]);
    assert.deepStrictEqual(globalBounds('geographic'), [-180, -90, 180, 90]);
    assert.deepStrictEqual(globalBounds(), [-180, -MERCATOR_MAX_LAT, 180, MERCATOR_MAX_LAT]);
  });

  it('normalizeBounds：合法元组原样返回（数字化）', () => {
    assert.deepStrictEqual(normalizeBounds([100, 20, 110, 40]), [100, 20, 110, 40]);
    assert.deepStrictEqual(normalizeBounds(['100', '20', '110', '40']), [100, 20, 110, 40]);
  });

  it('normalizeBounds：非法输入一律 undefined（NaN / 顺序颠倒 / 越界 / 长度不对）', () => {
    assert.strictEqual(normalizeBounds(undefined), undefined);
    assert.strictEqual(normalizeBounds([1, 2, 3]), undefined);
    assert.strictEqual(normalizeBounds([NaN, 0, 1, 1]), undefined);
    assert.strictEqual(normalizeBounds([120, 0, 110, 10]), undefined); // minLon > maxLon
    assert.strictEqual(normalizeBounds([0, 40, 10, 20]), undefined); // minLat > maxLat
    assert.strictEqual(normalizeBounds([-200, 0, 10, 10]), undefined); // 经度越界
    assert.strictEqual(normalizeBounds([0, -100, 10, 10]), undefined); // 纬度越界
  });
});
