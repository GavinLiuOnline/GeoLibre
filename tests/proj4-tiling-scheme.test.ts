/**
 * editor/core · localCache/proj4TilingScheme 单测（t37）
 *
 * 数值断言策略：与「已知 EPSG 手算/公认值」对照，不用实现自身做参照——
 * - Web Mercator 形 CRS（3857 注册表定义）的 square-2^z 网格 ≡ 标准 XYZ 网格：
 *   lon = -180 + 360·x/2^z（精确公式）；纬度边界用公认锚点（0 / ±85.0511287798066）；
 * - longlat 形 CRS（geodetic-2x1）投影为恒等 → 网格边界全是精确度数；
 * - CGCS2000 3° 带 EPSG:4547（CM 114E）：中央经线上 x=FE=500000 精确、
 *   正反算闭合 1e-9、方案矩形 = validBounds（反算外包已钳制进 validBounds）；
 * - TMS（origin bottom-left）行序翻转与 crsBoundsFromTileKeys 的已知瓦片边界。
 *
 * 键约定：瓦片键与 Cesium/XYZ 一致为 `z/x/y`。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Rectangle } from 'cesium';

import { findCrsEntry, resolveCrsInput } from '../packages/xyz-cache/src/crs-registry';
import {
  Proj4TilingScheme,
  crsBoundsFromTileKeys,
  crsPositionToTile,
  crsTileProjectedRect,
  crsTilesInRange,
  gridAtLevel,
  proj4GridSpecOf,
  projectedBoundsOfCrs,
  projectedRectToLonLatBounds,
  rootTilesOf,
} from '../packages/xyz-cache/src/proj4-tiling-scheme';
import type { XyzLayerCrs } from './types';

/** vitest toBeCloseTo 等价：|a-b| < 10^-d / 2 */
const closeTo = (actual: number, expected: number, digits = 9): void => {
  assert.ok(Math.abs(actual - expected) < Math.pow(10, -digits) / 2, `closeTo: ${actual} !~ ${expected} (digits=${digits})`);
};


/** 3857 注册表条目（+proj=merc +a=6378137...）→ 等价标准 Web Mercator XYZ 网格 */
const MERC_CRS: XyzLayerCrs = {
  kind: 'proj4',
  proj4: findCrsEntry('EPSG:3857')!.proj4,
  validBounds: [-180, -85.0511287798066, 180, 85.0511287798066],
};

/** 经纬度恒等网格（geodetic-2x1） */
const GEOD_CRS: XyzLayerCrs = {
  kind: 'proj4',
  proj4: '+proj=longlat +datum=WGS84 +no_defs',
  validBounds: [-180, -90, 180, 90],
  tileMatrix: 'geodetic-2x1',
};

/** CGCS2000 3° 带 CM 114E（注册表条目 EPSG:4547 展开） */
const CGCS4547: XyzLayerCrs = {
  kind: 'proj4',
  proj4: findCrsEntry('EPSG:4547')!.proj4,
  validBounds: [112.5, 0, 115.5, 84],
  id: 'EPSG:4547',
  label: findCrsEntry('EPSG:4547')!.label,
};

const DEG = 180 / Math.PI;
const R = 6378137; // Web Mercator 球半径（公认）
const mercHalf = 20037508.342789244; // R·π（Web Mercator 半周长，米）
/** 标准 Mercator 公式（独立于实现的手算参照） */
const mercY = (latDeg: number): number => R * Math.atanh(Math.sin((latDeg * Math.PI) / 180));
const mercX = (lonDeg: number): number => R * ((lonDeg * Math.PI) / 180);

// ---------------------------------------------------------------------------
// 纯网格数学
// ---------------------------------------------------------------------------

describe('t37 · proj4GridSpecOf / projectedBoundsOfCrs', () => {
  it('merc 形 CRS 投影包围盒 = ±R·π（公认值 20037508.342789244）', () => {
    const spec = proj4GridSpecOf(MERC_CRS);
    assert.strictEqual(spec.rootX, 1);
    assert.strictEqual(spec.rootY, 1);
    assert.ok(Math.abs(spec.projBounds.minX + mercHalf) < (0.01));
    assert.ok(Math.abs(spec.projBounds.maxX - mercHalf) < (0.01));
    assert.ok(Math.abs(spec.projBounds.minY + mercHalf) < (0.01));
    assert.ok(Math.abs(spec.projBounds.maxY - mercHalf) < (0.01));
  });

  it('geodetic 形 CRS 投影为恒等：projBounds 即度数范围', () => {
    const spec = proj4GridSpecOf(GEOD_CRS);
    assert.strictEqual(spec.rootX, 2);
    assert.strictEqual(spec.rootY, 1);
    assert.deepStrictEqual(spec.projBounds, { minX: -180, minY: -90, maxX: 180, maxY: 90 });
  });

  it('rootTilesOf / gridAtLevel：square 2^z×2^z，geodetic 2^(z+1)×2^z', () => {
    assert.deepStrictEqual(rootTilesOf('square-2^z'), { x: 1, y: 1 });
    assert.deepStrictEqual(rootTilesOf('geodetic-2x1'), { x: 2, y: 1 });

    const sq = gridAtLevel(proj4GridSpecOf(MERC_CRS), 3);
    assert.strictEqual(sq.cols, 8);
    assert.strictEqual(sq.rows, 8);
    // 单格尺寸：全宽/8 = 2·mercHalf/8
    assert.ok(Math.abs(sq.cellW - (2 * mercHalf) / 8) < (0.01));

    const gd = gridAtLevel(proj4GridSpecOf(GEOD_CRS), 2);
    assert.strictEqual(gd.cols, 8);
    assert.strictEqual(gd.rows, 4);
    closeTo(gd.cellW, 45, 12); // 360/8
    closeTo(gd.cellH, 45, 12); // 180/4
  });

  it('非法 validBounds / 不可用定义 → 可读错误', () => {
    assert.throws(() => proj4GridSpecOf({ ...MERC_CRS, validBounds: [110, 20, 100, 40] }), /有效范围非法/);
    assert.throws(() => proj4GridSpecOf({ ...MERC_CRS, proj4: '乱码', validBounds: [0, 0, 1, 1] }), /CRS 定义不可用/);
  });

  it('projectedRectToLonLatBounds：merc 反算回已知锚点', () => {
    const b = projectedRectToLonLatBounds(MERC_CRS.proj4, {
      minX: 0,
      minY: 0,
      maxX: mercHalf,
      maxY: mercHalf,
    });
    assert.notStrictEqual(b, undefined);
    // 该投影矩形的 8 点采样外包：lon [0,180]（上/下边中点反算 0 与 180——采样含边中点）
    if (!b) return;
    closeTo(b.minLon, 0, 6);
    closeTo(b.maxLon, 180, 6);
    closeTo(b.maxLat, 85.0511287798066, 4);
    closeTo(b.minLat, 0, 6);
  });
});

// ---------------------------------------------------------------------------
// 方格网格换算（square-2^z ≡ 标准 Web Mercator XYZ）
// ---------------------------------------------------------------------------

describe('t37 · crsTileProjectedRect / crsPositionToTile（square-2^z）', () => {
  it('level 1 tile (0,0)：投影格 = 西北象限', () => {
    const spec = proj4GridSpecOf(MERC_CRS);
    const cell = crsTileProjectedRect(spec, 0, 0, 1);
    closeTo(cell.minX, -mercHalf, 6);
    closeTo(cell.maxX, 0, 6);
    closeTo(cell.minY, 0, 6); // 上半：projY ∈ [0, mercHalf]
    closeTo(cell.maxY, mercHalf, 6);
  });

  it('level 1 tile (1,1)：投影格 = 东南象限', () => {
    const spec = proj4GridSpecOf(MERC_CRS);
    const cell = crsTileProjectedRect(spec, 1, 1, 1);
    closeTo(cell.minX, 0, 6);
    closeTo(cell.maxX, mercHalf, 6);
    closeTo(cell.minY, -mercHalf, 6);
    closeTo(cell.maxY, 0, 6);
  });

  it('crsPositionToTile：已知投影点落格（lon 91°/lat 40° @z2 → (3,1)）', () => {
    const spec = proj4GridSpecOf(MERC_CRS);
    // 标准 Mercator 正算公式：lon 91° → x；lat 40° → y（列边界取 91° 避免整除边界抖动）
    const a = crsPositionToTile(spec, 2, mercX(91), mercY(40));
    assert.deepStrictEqual(a, { x: 3, y: 1 });
    // lon -89° / lat -40° → (1,2)
    const b = crsPositionToTile(spec, 2, mercX(-89), -mercY(40));
    assert.deepStrictEqual(b, { x: 1, y: 2 });
  });

  it('crsPositionToTile：网格外 → undefined；边缘钳制进末列/末行', () => {
    const spec = proj4GridSpecOf(MERC_CRS);
    assert.strictEqual(crsPositionToTile(spec, 2, mercHalf * 2, 0), undefined);
    assert.strictEqual(crsPositionToTile(spec, 2, 0, -mercHalf * 2), undefined);
    // 恰在东北角（maxX, maxY）：钳制到 (3,0)
    assert.deepStrictEqual(crsPositionToTile(spec, 2, mercHalf, mercHalf), { x: 3, y: 0 });
  });

  it('origin bottom-left（TMS 行序）：row 0 是最南行', () => {
    const spec = proj4GridSpecOf({ ...GEOD_CRS, origin: 'bottom-left' });
    const south = crsTileProjectedRect(spec, 0, 0, 1);
    closeTo(south.minY, -90, 12);
    closeTo(south.maxY, 0, 12);
    const north = crsTileProjectedRect(spec, 0, 1, 1);
    closeTo(north.minY, 0, 12);
    closeTo(north.maxY, 90, 12);
  });
});

// ---------------------------------------------------------------------------
// Cesium TilingScheme 数值（tileXYToRectangle / positionToTileXY）
// ---------------------------------------------------------------------------

describe('t37 · Proj4TilingScheme（merc 形 = 标准 XYZ 网格）', () => {
  it('网格数量：level z 为 2^z × 2^z', () => {
    const scheme = new Proj4TilingScheme(MERC_CRS);
    assert.strictEqual(scheme.getNumberOfXTilesAtLevel(0), 1);
    assert.strictEqual(scheme.getNumberOfXTilesAtLevel(3), 8);
    assert.strictEqual(scheme.getNumberOfYTilesAtLevel(3), 8);
    assert.strictEqual(scheme.getNumberOfXTilesAtLevel(2), 4);
  });

  it('tileXYToRectangle(0,0,1)：西半球、纬度 [0, 85.0511287798066]', () => {
    const scheme = new Proj4TilingScheme(MERC_CRS);
    const r = scheme.tileXYToRectangle(0, 0, 1);
    closeTo(r.west * DEG, -180, 6);
    closeTo(r.east * DEG, 0, 6);
    closeTo(r.south * DEG, 0, 6);
    closeTo(r.north * DEG, 85.0511287798066, 4);
  });

  it('tileXYToRectangle(1,1,1)：东半球、纬度 [-85.0511287798066, 0]', () => {
    const scheme = new Proj4TilingScheme(MERC_CRS);
    const r = scheme.tileXYToRectangle(1, 1, 1);
    closeTo(r.west * DEG, 0, 6);
    closeTo(r.east * DEG, 180, 6);
    closeTo(r.south * DEG, -85.0511287798066, 4);
    closeTo(r.north * DEG, 0, 6);
  });

  it('level 0 唯一瓦片 = 整个 validBounds；rectangle 属性 = validBounds', () => {
    const scheme = new Proj4TilingScheme(MERC_CRS);
    const r = scheme.tileXYToRectangle(0, 0, 0);
    // 反算外包 + validBounds 钳制 → 逐分量贴近（proj4 反算有 ~1e-9 弧度噪声）
    closeTo(r.west * DEG, -180, 9);
    closeTo(r.south * DEG, -85.0511287798066, 6);
    closeTo(r.east * DEG, 180, 9);
    closeTo(r.north * DEG, 85.0511287798066, 6);
    // rectangle 属性直接由 validBounds 构造 → 可精确相等
    const expected = Rectangle.fromDegrees(-180, -85.0511287798066, 180, 85.0511287798066);
    assert.strictEqual(Rectangle.equals(scheme.rectangle, expected), true);
  });

  it('positionToTileXY：经度/纬度换算行列；方案外 → undefined', () => {
    const scheme = new Proj4TilingScheme(MERC_CRS);
    const a = scheme.positionToTileXY({
      longitude: (90 * Math.PI) / 180,
      latitude: (40 * Math.PI) / 180,
    } as never, 2);
    assert.strictEqual(a?.x, 3);
    assert.strictEqual(a?.y, 1);
    // 方案矩形之外（纬度超 ±85.05…）→ undefined（Cesium 约定：ImageryLayer 跳过）
    const out = scheme.positionToTileXY({ longitude: 0, latitude: (89 * Math.PI) / 180 } as never, 2);
    assert.strictEqual(out, undefined);
  });

  it('rectangleToNativeRectangle：整域 → 投影包围盒（±mercHalf）', () => {
    const scheme = new Proj4TilingScheme(MERC_CRS);
    const native = scheme.rectangleToNativeRectangle(scheme.rectangle);
    assert.ok(Math.abs(native.west + mercHalf) < (0.01));
    assert.ok(Math.abs(native.north - mercHalf) < (0.01));
  });
});

describe('t37 · Proj4TilingScheme（geodetic-2x1 = Cesium GeographicTilingScheme 网格）', () => {
  it('网格数量：level z 为 2^(z+1) × 2^z', () => {
    const scheme = new Proj4TilingScheme(GEOD_CRS);
    assert.strictEqual(scheme.getNumberOfXTilesAtLevel(0), 2);
    assert.strictEqual(scheme.getNumberOfYTilesAtLevel(0), 1);
    assert.strictEqual(scheme.getNumberOfXTilesAtLevel(2), 8);
    assert.strictEqual(scheme.getNumberOfYTilesAtLevel(2), 4);
  });

  it('level 0 两张根瓦片：西/东半球 × 全纬度 [-90,90]（与 GeographicTilingScheme 一致）', () => {
    const scheme = new Proj4TilingScheme(GEOD_CRS);
    const west = scheme.tileXYToRectangle(0, 0, 0);
    closeTo(west.west * DEG, -180, 9);
    closeTo(west.south * DEG, -90, 9);
    closeTo(west.east * DEG, 0, 9);
    closeTo(west.north * DEG, 90, 9);
    const east = scheme.tileXYToRectangle(1, 0, 0);
    closeTo(east.west * DEG, 0, 9);
    closeTo(east.east * DEG, 180, 9);
  });

  it('level 2 精确度数网格：tile (3,1) = lon [-45,0] × lat [0,45]', () => {
    const scheme = new Proj4TilingScheme(GEOD_CRS);
    const r = scheme.tileXYToRectangle(3, 1, 2);
    closeTo(r.west * DEG, -45, 9);
    closeTo(r.south * DEG, 0, 9);
    closeTo(r.east * DEG, 0, 9);
    closeTo(r.north * DEG, 45, 9);
  });

  it('positionToTileXY：(-90,45)@z1 → (1,0)（lat 45 是 row0 北带的南边界）', () => {
    const scheme = new Proj4TilingScheme(GEOD_CRS);
    const t = scheme.positionToTileXY({
      longitude: (-90 * Math.PI) / 180,
      latitude: (45 * Math.PI) / 180,
    } as never, 1);
    assert.strictEqual(t?.x, 1);
    assert.strictEqual(t?.y, 0);
  });
});

// ---------------------------------------------------------------------------
// CGCS2000 3° 带（EPSG:4547，CM 114E）：已知 EPSG 手算对照
// ---------------------------------------------------------------------------

describe('t37 · Proj4TilingScheme（CGCS2000 3° 带 EPSG:4547）', () => {
  it('中央经线上 x = FE = 500000 精确；正反算闭合 ≤ 1e-9', () => {
    const scheme = new Proj4TilingScheme(CGCS4547);
    const native = scheme.rectangleToNativeRectangle(
      Rectangle.fromDegrees(114, 0, 114, 84),
    );
    // CM 上 x=500000（东偏），有限即可判定（y 为子午线弧长）
    closeTo(native.west, 500000, 3);
    assert.strictEqual(Number.isFinite(native.north), true);

    // 正反算闭合（经 scheme.projection 走一遍）
    const p = scheme.projection.project({
      longitude: (114 * Math.PI) / 180,
      latitude: (36 * Math.PI) / 180,
    } as never);
    const back = scheme.projection.unproject(p);
    closeTo(back.longitude * DEG, 114, 9);
    closeTo(back.latitude * DEG, 36, 9);
  });

  it('中央经线点落在网格中央列（level 3 → x=4）', () => {
    const scheme = new Proj4TilingScheme(CGCS4547);
    const t = scheme.positionToTileXY({
      longitude: (114 * Math.PI) / 180,
      latitude: (42 * Math.PI) / 180,
    } as never, 3);
    assert.strictEqual(t?.x, 4);
    assert.ok(t!.y >= (0));
    assert.ok(t!.y < (8));
    // level 0 单根瓦片
    const t0 = scheme.positionToTileXY({
      longitude: (114 * Math.PI) / 180,
      latitude: (42 * Math.PI) / 180,
    } as never, 0);
    assert.deepStrictEqual({ ...t0 }, { x: 0, y: 0 }); // 展开：Cartesian2 实例 → 纯对象
  });

  it('level 0 瓦片脚印 = validBounds（反算外包钳制回有效范围）', () => {
    const scheme = new Proj4TilingScheme(CGCS4547);
    const r = scheme.tileXYToRectangle(0, 0, 0);
    // 采样外包在子午线收敛处会越出带外（约 99.9°），钳制后 = validBounds
    closeTo(r.west * DEG, 112.5, 9);
    closeTo(r.east * DEG, 115.5, 9);
    closeTo(r.south * DEG, 0, 9);
    closeTo(r.north * DEG, 84, 6);
  });

  it('validBounds 外的位置 → undefined（非全球 CRS 的裁剪语义）', () => {
    const scheme = new Proj4TilingScheme(CGCS4547);
    assert.strictEqual(scheme.positionToTileXY({ longitude: (100 * Math.PI) / 180, latitude: (30 * Math.PI) / 180 } as never, 3), undefined);
    assert.strictEqual(scheme.positionToTileXY({ longitude: (114 * Math.PI) / 180, latitude: (-5 * Math.PI) / 180 } as never, 3), undefined);
  });
});

// ---------------------------------------------------------------------------
// crsTilesInRange / crsBoundsFromTileKeys
// ---------------------------------------------------------------------------

describe('t37 · crsTilesInRange（非全球 CRS 满格与子范围求交）', () => {
  it('merc 形满格 = 4^z；geodetic 形满格 = 2·4^z', () => {
    assert.strictEqual(crsTilesInRange([-180, -85, 180, 85], 0, MERC_CRS), 1);
    assert.strictEqual(crsTilesInRange([-180, -85, 180, 85], 2, MERC_CRS), 16);
    assert.strictEqual(crsTilesInRange([-180, -90, 180, 90], 0, GEOD_CRS), 2);
    assert.strictEqual(crsTilesInRange([-180, -90, 180, 90], 2, GEOD_CRS), 32);
  });

  it('geodetic 子范围精确计数：lon [0,180] × lat [0,90] @z1 = 2 列 × 2 行 = 4', () => {
    // z1：cols=4（lon 0..180 → 2 列）、rows=2（lat 0..90 → 2 行）
    assert.strictEqual(crsTilesInRange([0, 0, 180, 90], 1, GEOD_CRS), 4);
  });

  it('投影带 CRS：满格 = 4^z；与 validBounds 无交 → 0；非法 zoom → 0', () => {
    assert.strictEqual(crsTilesInRange([112.5, 0, 115.5, 84], 2, CGCS4547), 16);
    assert.strictEqual(crsTilesInRange([0, 0, 10, 10], 2, CGCS4547), 0);
    assert.strictEqual(crsTilesInRange([113, 10, 114, 20], -1, CGCS4547), 0);
    assert.strictEqual(crsTilesInRange([113, 10, 114, 20], 1.5 as never, CGCS4547), 0);
  });
});

describe('t37 · crsBoundsFromTileKeys（瓦片键 z/x/y → lon/lat 范围）', () => {
  it('geodetic level 1：键 "1/1/1" → lon [-90,0] × lat [-90,0]（精确）', () => {
    assert.deepStrictEqual(crsBoundsFromTileKeys(['1/1/1'], GEOD_CRS, false), [-90, -90, 0, 0]);
  });

  it('geodetic level 0：键 "0/1/0"（x=1 东半球根瓦片）→ [0,-90,180,90]', () => {
    assert.deepStrictEqual(crsBoundsFromTileKeys(['0/1/0'], GEOD_CRS, false), [0, -90, 180, 90]);
  });

  it('TMS 行序翻转：geodetic z1 键 "1/1/1"（tms）→ 北半 [−90,0,0,90]', () => {
    // tms：y_tms=1 → y_xyz = rows-1-y = 0（北带）；x=1 → lon [-90,0]
    assert.deepStrictEqual(crsBoundsFromTileKeys(['1/1/1'], GEOD_CRS, true), [-90, 0, 0, 90]);
  });

  it('merc 形：键 "1/1/1" → 东南象限 [0,-85.05…,180,0]', () => {
    const b = crsBoundsFromTileKeys(['1/1/1'], MERC_CRS, false);
    assert.notStrictEqual(b, undefined);
    if (!b) return;
    closeTo(b[0], 0, 6);
    closeTo(b[1], -85.0511287798066, 4);
    closeTo(b[2], 180, 6);
    closeTo(b[3], 0, 6);
  });

  it('多键并集取 min/max；非法键跳过；全非法 → undefined', () => {
    const b = crsBoundsFromTileKeys(['1/1/1', '1/2/1', 'junk'], GEOD_CRS, false);
    assert.deepStrictEqual(b, [-90, -90, 90, 0]);
    assert.strictEqual(crsBoundsFromTileKeys(['junk', 'x/y/z'], GEOD_CRS, false), undefined);
    assert.strictEqual(crsBoundsFromTileKeys([], GEOD_CRS, false), undefined);
  });

  it('投影带 CRS：level 0 单键 = validBounds（反算外包钳制）', () => {
    const b = crsBoundsFromTileKeys(['0/0/0'], CGCS4547, false);
    assert.notStrictEqual(b, undefined);
    if (!b) return;
    closeTo(b[0], 112.5, 9);
    closeTo(b[1], 0, 9);
    closeTo(b[2], 115.5, 9);
    closeTo(b[3], 84, 6);
  });
});

// ---------------------------------------------------------------------------
// resolveCrsInput 与注册表条目联动（scheme 构造入口的冒烟）
// ---------------------------------------------------------------------------

describe('t37 · 注册表条目 → Proj4TilingScheme 冒烟', () => {
  it('resolveCrsInput 命中注册表后可直接构造 scheme（含 origin/tileMatrix 缺省）', () => {
    const r = resolveCrsInput({ proj4: 'EPSG:4547', validBounds: [113, 5, 114.5, 60] });
    assert.strictEqual(r.ok, true);
    if (!r.ok) return;
    const scheme = new Proj4TilingScheme(r.crs);
    assert.strictEqual(scheme.getNumberOfXTilesAtLevel(0), 1);
    assert.deepStrictEqual(scheme.spec.validBounds, [113, 5, 114.5, 60]);
    assert.strictEqual(scheme.spec.origin, 'top-left');
    assert.strictEqual(scheme.spec.tileMatrix, 'square-2^z');
  });

  it('projectedBoundsOfCrs：非有限定义 → undefined（不抛错）', () => {
    assert.strictEqual(projectedBoundsOfCrs('乱码定义', [0, 0, 1, 1]), undefined);
  });
});
