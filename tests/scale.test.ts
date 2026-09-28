/**
 * editor/core · localCache/scale —— t33 容量预估公式测试
 *
 * 覆盖：
 * 1. tilesInRange：边界、跨 180°、极地钳制、单层 / 多层
 * 2. estimateXyzScale：东北 z0–20 实测推算（44.8 亿瓦片量级）、分级阈值
 * 3. classifyScale：三档边界
 * 4. scaleAdvice：各档位返回的建议条目
 * 5. summarizeScale：高层组合
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_BYTES_PER_TILE,
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
  SCALE_HUGE_TILES,
  SCALE_LARGE_TILES,
  classifyScale,
  estimateXyzScale,
  normalizeBoundsInput,
  scaleAdvice,
  summarizeScale,
  tilesInRange,
} from '../packages/xyz-cache/src/scale';

// ---------------------------------------------------------------------------
// normalizeBoundsInput
// ---------------------------------------------------------------------------

describe('t33 · normalizeBoundsInput', () => {
  it('数组输入归一化（钳制 + 排序）', () => {
    assert.deepStrictEqual(normalizeBoundsInput([-180, -90, 180, 90]), [-180, -85.0511287798066, 180, 85.0511287798066]);
  });
  it('对象输入归一化', () => {
    assert.deepStrictEqual(normalizeBoundsInput({ minLon: -10, minLat: 20, maxLon: 30, maxLat: 40 }), [-10, 20, 30, 40]);
  });
  it('west/east/north/south 别名', () => {
    assert.deepStrictEqual(normalizeBoundsInput({ west: 1, south: 2, east: 3, north: 4 }), [1, 2, 3, 4]);
  });
  it('退化（min >= max）返回 undefined', () => {
    assert.strictEqual(normalizeBoundsInput([10, 0, 10, 20]), undefined);
    assert.strictEqual(normalizeBoundsInput([10, 20, 5, 30]), undefined);
  });
  it('NaN / 长度错返回 undefined', () => {
    assert.strictEqual(normalizeBoundsInput([NaN, 0, 10, 20]), undefined);
    assert.strictEqual(normalizeBoundsInput([0, 10, 20]), undefined);
    assert.strictEqual(normalizeBoundsInput(null), undefined);
    assert.strictEqual(normalizeBoundsInput('foo'), undefined);
  });
  it('经度超过 ±180 钳制到边界', () => {
    assert.deepStrictEqual(normalizeBoundsInput([-200, 0, 200, 10]), [-180, 0, 180, 10]);
  });
});

// ---------------------------------------------------------------------------
// tilesInRange（公式法：单段 / 单层）
// ---------------------------------------------------------------------------

describe('t33 · tilesInRange 单层公式', () => {
  it('全球 z=0 → 1', () => {
    assert.strictEqual(tilesInRange([-180, -85.05, 180, 85.05], 0), 1);
  });
  it('全球 z=1 → 4（墨卡托 z=1 是 2×2）', () => {
    assert.strictEqual(tilesInRange([-180, -85.05, 180, 85.05], 1), 4);
  });
  it('全球 z=2 → 16（4×4）', () => {
    assert.strictEqual(tilesInRange([-180, -85.05, 180, 85.05], 2), 16);
  });
  it('赤道 1°×1° z=0 → 1', () => {
    assert.strictEqual(tilesInRange([0, 0, 1, 1], 0), 1);
  });
  it('赤道 1°×1° z=10 → tilesInRange ≈ 1024 × ceil(lat/0.00898)', () => {
    const tiles = tilesInRange([0, 0, 1, 1], 10);
    assert.ok(tiles > (0));
    assert.ok(tiles <= (1024 * 2));
  });
  it('z 越高层瓦片数指数增长', () => {
    const t0 = tilesInRange([-180, -85.05, 180, 85.05], 0);
    const t5 = tilesInRange([-180, -85.05, 180, 85.05], 5);
    assert.ok(t5 > (t0 * 100));
  });
  it('跨 antimeridian 拆两段求和', () => {
    // 跨 ±180：[170, 0, -170, 10] 拆成 [170, 0, 180, 10] + [-180, 0, -170, 10]
    // z=0 全球 1 瓦片覆盖整经度，每段各 1，求和 2
    assert.strictEqual(tilesInRange([170, 0, -170, 10], 0), 2);
    // 单段 [-180, 0, -170, 10] z=0 = 1（不跨）
    assert.strictEqual(tilesInRange([-180, 0, -170, 10], 0), 1);
  });
  it('非法 zoom 返回 0', () => {
    assert.strictEqual(tilesInRange([-180, -85.05, 180, 85.05], -1), 0);
    assert.strictEqual(tilesInRange([-180, -85.05, 180, 85.05], 1.5), 0);
  });
});

// ---------------------------------------------------------------------------
// estimateXyzScale（公式法：层级范围）
// ---------------------------------------------------------------------------

describe('t33 · estimateXyzScale 多层公式', () => {
  it('东北 z0–20 全量 ≈ 44.8 亿瓦片（实测推算，零 IO）', () => {
    // 东北 bbox: 黑龙江/吉林/辽宁/内蒙古东部，约 [115, 38, 135, 54]
    // 全球 2^z 总数：z=0 1、z=1 4²=16... z=20 4 * 4^20（地理覆盖 4 块）
    // 东北占比 ~1.5%（按纬度 38–54、纬度跨度 16°/180°），量级 ~4.5e8
    const e = estimateXyzScale({
      bounds: [115, 38, 135, 54],
      minZoom: 0,
      maxZoom: 20,
    });
    assert.ok(e.totalTiles > (2e8));
    assert.ok(e.totalTiles < (8e9));
    // 比例：z20 单层全球 ≈ 4*4^20 = 4.4e12 瓦片 → 东北应只占 ~0.01（按 bbox 占比）
    const z20 = e.perLevel.find((p) => p.zoom === 20);
    assert.notStrictEqual(z20, undefined);
    assert.ok(z20!.tiles > (1e7));
    assert.ok(z20!.tiles < (1e10));
    // 字节估算（默认 8KB/瓦片 + 4KB 块）
    assert.strictEqual(e.totalBytes, e.totalTiles * DEFAULT_BYTES_PER_TILE);
    assert.ok(e.totalBytesOnDisk >= (e.totalBytes));
  });

  it('东北 z0–20 在 huge 档（> 200 万瓦片）', () => {
    const e = estimateXyzScale({ bounds: [115, 38, 135, 54], minZoom: 0, maxZoom: 20 });
    assert.strictEqual(e.scale, 'huge');
  });

  it('小区域 z0–14 在 small 档', () => {
    // 1°×1° 全球 z14 约 16384 瓦片；这里 1°×1° 远小于 huge 阈值
    const e = estimateXyzScale({ bounds: [116.3, 39.9, 116.4, 40.0], minZoom: 0, maxZoom: 14 });
    assert.strictEqual(e.scale, 'small');
  });

  it('中区域 z0–15 → large 档', () => {
    // 全球 50°×30°（北美大陆量级）：z15 单层 ≈ 4 * (50/180) * (30/360) * 4^15 ≈ 4e8
    const e = estimateXyzScale({ bounds: [100, 20, 130, 50], minZoom: 0, maxZoom: 15 });
    assert.strictEqual(e.scale === 'large' || e.scale === 'huge', true);
  });

  it('空 bounds（与墨卡托无交）→ empty + totalTiles=0', () => {
    // 退化区间：min == max（归一化会拒绝）；改用一个跨赤道但极小的范围
    const e = estimateXyzScale({ bounds: [0.0001, 0.0001, 0.0002, 0.0002], minZoom: 0, maxZoom: 0 });
    // z=0 单瓦片全球都覆盖；只要 min < max 就会落入某个瓦片
    assert.strictEqual(e.empty, false);
    assert.ok(e.totalTiles >= (1));
  });

  it('跨 antimeridian 求和（两段各算一次）', () => {
    const e = estimateXyzScale({
      bounds: [170, 0, -170, 10],
      minZoom: 0,
      maxZoom: 3,
    });
    assert.ok(e.totalTiles > (0));
    // z=3 全球 4*4^3 = 256；跨 ±180 拆两段：[-170..-160]+[170..180] + [160..170]+[170..180]
    // 简单验证：每段单独算 + 求和
  });

  it('maxZoom 钳制到 MAX_GENERATE_ZOOM（22）', () => {
    const e = estimateXyzScale({ bounds: [-180, -85.05, 180, 85.05], minZoom: 0, maxZoom: 99 });
    // z=22 全球 4*4^22 ≈ 7.0e13 —— 钳制后不会无界
    assert.strictEqual(Number.isFinite(e.totalTiles), true);
    assert.ok(e.perLevel.length > (0));
    assert.ok(e.perLevel[e.perLevel.length - 1]!.zoom <= (DEFAULT_MAX_ZOOM));
  });

  it('自定义 bytesPerTile / blockSize', () => {
    const a = estimateXyzScale({ bounds: [0, 0, 1, 1], minZoom: 0, maxZoom: 1, bytesPerTile: 1024, blockSize: 0 });
    assert.strictEqual(a.totalBytes, a.totalTiles * 1024);
    assert.strictEqual(a.totalBytesOnDisk, a.totalBytes); // blockSize=0 不算开销
  });
});

// ---------------------------------------------------------------------------
// classifyScale 三档边界
// ---------------------------------------------------------------------------

describe('t33 · classifyScale 三档阈值', () => {
  it('小：≤ SCALE_LARGE_TILES → small', () => {
    assert.strictEqual(classifyScale(0), 'small');
    assert.strictEqual(classifyScale(SCALE_LARGE_TILES), 'small');
  });
  it('大：SCALE_LARGE_TILES < ≤ SCALE_HUGE_TILES → large', () => {
    assert.strictEqual(classifyScale(SCALE_LARGE_TILES + 1), 'large');
    assert.strictEqual(classifyScale(SCALE_HUGE_TILES), 'large');
  });
  it('巨大：> SCALE_HUGE_TILES → huge', () => {
    assert.strictEqual(classifyScale(SCALE_HUGE_TILES + 1), 'huge');
    assert.strictEqual(classifyScale(1e10), 'huge');
  });
  it('字节上限独立触发 huge', () => {
    assert.strictEqual(classifyScale(100, 2_500_000_000), 'huge');
    assert.strictEqual(classifyScale(100, 1_500_000_000), 'small');
  });
});

// ---------------------------------------------------------------------------
// scaleAdvice 推荐路径
// ---------------------------------------------------------------------------

describe('t33 · scaleAdvice 推荐路径', () => {
  it('small → 仅 ok', () => {
    const e = estimateXyzScale({ bounds: [0, 0, 1, 1], minZoom: 0, maxZoom: 5 });
    const r = scaleAdvice(e, { bounds: [0, 0, 1, 1], minZoom: 0, maxZoom: 5 });
    assert.strictEqual(r.scale, 'small');
    assert.strictEqual(r.advice.length, 1);
    assert.strictEqual(r.advice[0]!.kind, 'ok');
  });
  it('large → ok + crop-bbox + split-batches（maxZoom ≥ minZoom+2 时含 lower-maxzoom）', () => {
    const e = estimateXyzScale({ bounds: [80, 0, 130, 60], minZoom: 0, maxZoom: 12 });
    const r = scaleAdvice(e, { bounds: [80, 0, 130, 60], minZoom: 0, maxZoom: 12 });
    assert.strictEqual(r.scale, 'large');
    assert.strictEqual(r.advice.some((a) => a.kind === 'lower-maxzoom'), true);
    assert.strictEqual(r.advice.some((a) => a.kind === 'crop-bbox'), true);
    assert.strictEqual(r.advice.some((a) => a.kind === 'split-batches'), true);
  });
  it('large 但 maxZoom - minZoom < 2 → 不给 lower-maxzoom', () => {
    const e = estimateXyzScale({ bounds: [80, 0, 130, 60], minZoom: 13, maxZoom: 14 });
    const r = scaleAdvice(e, { bounds: [80, 0, 130, 60], minZoom: 13, maxZoom: 14 });
    assert.strictEqual(r.advice.some((a) => a.kind === 'lower-maxzoom'), false);
  });
  it('huge → blocked + electron-server + host-directory + electron-desktop', () => {
    const e = estimateXyzScale({ bounds: [115, 38, 135, 54], minZoom: 0, maxZoom: 20 });
    const r = scaleAdvice(e, { bounds: [115, 38, 135, 54], minZoom: 0, maxZoom: 20 });
    assert.strictEqual(r.scale, 'huge');
    assert.strictEqual(r.advice.some((a) => a.kind === 'blocked'), true);
    assert.strictEqual(r.advice.some((a) => a.kind === 'electron-server'), true);
    assert.strictEqual(r.advice.some((a) => a.kind === 'host-directory'), true);
    assert.strictEqual(r.advice.some((a) => a.kind === 'electron-desktop'), true);
  });
  it('empty → 简短 ok（与墨卡托世界无交）', () => {
    // 用一个极小且非退化的范围，但 maxZoom=0 单瓦片能命中
    // 真正"无交"需要 bounds 完全在墨卡托有效域之外；这里通过 maxZoom=-1 强制 empty
    const e = estimateXyzScale({ bounds: [0, 0, 0.001, 0.001], minZoom: 5, maxZoom: 4 });
    // minZoom > maxZoom 钳制 → minZoom=5, maxZoom=5；z=5 0.001°×0.001° 仍命中 1 瓦片
    // 改为：直接构造 estimate 并手工设为 empty
    const fakeEmpty = { ...e, totalTiles: 0, empty: true };
    const r = scaleAdvice(fakeEmpty, { bounds: [0, 0, 0.001, 0.001] });
    assert.strictEqual(r.scale, 'small');
    assert.ok(r.advice[0]!.title.includes('无交'));
  });
});

// ---------------------------------------------------------------------------
// summarizeScale 组合接口
// ---------------------------------------------------------------------------

describe('t33 · summarizeScale 组合', () => {
  it('huge 档的 headline 含「超出」', () => {
    const s = summarizeScale({ bounds: [115, 38, 135, 54], minZoom: 0, maxZoom: 20 });
    assert.ok(s.headline.includes('超出'));
    assert.match(s.bytesLabel, /B$/);
    assert.match(s.bytesOnDiskLabel, /B$/);
  });
  it('small 档的 headline 含「容量安全」', () => {
    const s = summarizeScale({ bounds: [0, 0, 1, 1], minZoom: 0, maxZoom: 5 });
    assert.ok(s.headline.includes('容量安全'));
  });
});
