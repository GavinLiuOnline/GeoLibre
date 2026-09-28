/**
 * editor/core · localCache/generate2d —— GeoJSON → XYZ PNG 瓦片缓存生成 单测
 *
 * 覆盖：
 * - XYZ 换算（lon/lat ↔ tile x/y，已知值 + round-trip + 与 Cesium
 *   WebMercatorTilingScheme 对齐）
 * - extent → 瓦片范围（世界/单瓦片/边界归属/墨卡托外/经度越界）
 * - GeoJSON 归一化（各几何类型、无效坐标、退化环、bbox）
 * - generateXyzFromGeoJSON 端到端（注入假画布：结构断言、样式、进度、
 *   空瓦片剔除、File 输入、错误分支）
 * - zip 桥接（复用 generate3d 的 kind 无关 generatedCacheToZipInputs / zipGeneratedCache）
 * - importGeneratedXyzToLayers（LocalXyzImageryProvider 注册 + metadata + 释放）
 */
import { Cartographic, Math as CesiumMath, WebMercatorTilingScheme } from 'cesium';
import type { GeoJSONData } from '@geolibre/gis-shared';
import JSZip from 'jszip';
import assert from "node:assert/strict";
import { mock } from "node:test";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MockInstance } from 'node:test';

import type { LayerInfo, LayerManager, LayerSource } from '../LayerManager';
import { parseXyzPath } from '../packages/xyz-cache/src/detect';
import { generatedCacheToZipInputs, zipGeneratedCache } from '../packages/xyz-cache/src/generate-3d';
import {
  DEFAULT_XYZ_STYLE,
  type GeoBounds,
  type TileContext2D,
  type TileCanvasFactory,
  MAX_GENERATE_ZOOM,
  geojsonExtent,
  generateXyzFromGeoJSON,
  importGeneratedXyzToLayers,
  latToTileY,
  lonToTileX,
  normalizeGeoJSONFeatures,
  projectLonLatToTilePixel,
  revokeGeneratedXyzLayerUrls,
  tileRangeForExtent,
  tileXToLon,
  tileYToLat,
} from '../packages/xyz-cache/src/generate-2d';
import { LocalXyzImageryProvider } from '../packages/xyz-cache/src/xyz-cache';

/** vitest toBeCloseTo 等价：|a-b| < 10^-d / 2 */
const closeTo = (actual: number, expected: number, digits = 9): void => {
  assert.ok(Math.abs(actual - expected) < Math.pow(10, -digits) / 2, `closeTo: ${actual} !~ ${expected} (digits=${digits})`);
};


// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

/** 单点（北京） */
const FC_POINT = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.4, 39.9] },
      properties: {},
    },
  ],
} as unknown as GeoJSONData;

/** 两个远距离点（z3 落在不同瓦片，且候选范围内有空瓦片） */
const FC_TWO_POINTS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [10, 10] }, properties: {} },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [60, 60] }, properties: {} },
  ],
} as unknown as GeoJSONData;

/** 点 + 线 + 面（同一瓦片内，供渲染结构断言） */
const FC_MIXED = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [10, 10] }, properties: {} },
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[11, 11], [12, 12]] },
      properties: {},
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [10, 10],
            [12, 10],
            [12, 12],
            [10, 12],
            [10, 10],
          ],
        ],
      },
      properties: {},
    },
  ],
} as unknown as GeoJSONData;

/** 造一个带 name 的 File（Node 22 提供全局 File/Blob） */
function geojsonFile(name: string, content: string): File {
  return new File([content], name, { type: 'application/geo+json' });
}

// ---------------------------------------------------------------------------
// 假画布工厂（记录绘制调用与样式快照）
// ---------------------------------------------------------------------------

interface FakeStyleSnapshot {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
}

interface FakeOp {
  op: string;
  args: unknown[];
  style: FakeStyleSnapshot;
}

interface FakeCanvasRecord {
  width: number;
  height: number;
  ops: FakeOp[];
  state: FakeStyleSnapshot;
}

/**
 * 可注入的假画布工厂：
 * - ink=false → getImageData 返回全透明（模拟「画了但无墨」→ 瓦片应被剔除）
 * - getImageData=false → 上下文不提供 getImageData（保守保留瓦片路径）
 */
function createFakeCanvasFactory(
  options: { ink?: boolean; getImageData?: boolean } = {},
): { factory: TileCanvasFactory; created: FakeCanvasRecord[] } {
  const created: FakeCanvasRecord[] = [];
  const factory: TileCanvasFactory = (width: number, height: number) => {
    const ops: FakeOp[] = [];
    const state: FakeStyleSnapshot = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      globalAlpha: 1,
    };
    const record = (op: string, args: unknown[]): void => {
      ops.push({ op, args, style: { ...state } });
    };
    const context = {
      get fillStyle(): string {
        return state.fillStyle;
      },
      set fillStyle(value: string) {
        state.fillStyle = value;
      },
      get strokeStyle(): string {
        return state.strokeStyle;
      },
      set strokeStyle(value: string) {
        state.strokeStyle = value;
      },
      get lineWidth(): number {
        return state.lineWidth;
      },
      set lineWidth(value: number) {
        state.lineWidth = value;
      },
      get globalAlpha(): number {
        return state.globalAlpha;
      },
      set globalAlpha(value: number) {
        state.globalAlpha = value;
      },
      lineJoin: '',
      lineCap: '',
      beginPath: () => record('beginPath', []),
      arc: (...args: unknown[]) => record('arc', args),
      moveTo: (...args: unknown[]) => record('moveTo', args),
      lineTo: (...args: unknown[]) => record('lineTo', args),
      closePath: () => record('closePath', []),
      fill: (...args: unknown[]) => record('fill', args),
      stroke: () => record('stroke', []),
      ...(options.getImageData === false
        ? {}
        : {
            getImageData: () => ({
              data: new Uint8ClampedArray(width * height * 4).fill(
                options.ink === false ? 0 : 255,
              ),
            }),
          }),
    };
    const record0: FakeCanvasRecord = {
      width,
      height,
      ops,
      state,
    };
    created.push(record0);
    return {
      context: context as unknown as TileContext2D,
      toPngBlob: async () => new Blob([`png-${width}x${height}`], { type: 'image/png' }),
    };
  };
  return { factory, created };
}

function createFakeLayerManager(): {
  manager: LayerManager;
  imageryCalls: Array<{
    name: string;
    provider: unknown;
    source: Partial<LayerSource>;
    options: Record<string, unknown>;
  }>;
} {
  const imageryCalls: Array<{
    name: string;
    provider: unknown;
    source: Partial<LayerSource>;
    options: Record<string, unknown>;
  }> = [];
  const manager = {
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
  return { manager, imageryCalls };
}

// ---------------------------------------------------------------------------
// XYZ 换算
// ---------------------------------------------------------------------------

describe('generate2d · XYZ 换算', () => {
  it('已知值：z0 世界瓦片、赤道/本初子午线边界归属、NYC 经典瓦片', () => {
    assert.strictEqual(lonToTileX(0, 0), 0);
    assert.strictEqual(latToTileY(0, 0), 0);
    // 边界语义：lon 0 归属东侧瓦片（tile 1 = [0,180)），lat 0 归属南侧瓦片
    assert.strictEqual(lonToTileX(0, 1), 1);
    assert.strictEqual(latToTileY(0, 1), 1);
    // OSM 经典样例：(-74.0059, 40.7143) @ z3 → tile 2/3
    assert.strictEqual(lonToTileX(-74.0059, 3), 2);
    assert.strictEqual(latToTileY(40.7143, 3), 3);
    // 墨卡托上界 → y=0；南极纬度钳制 → y=n-1
    assert.strictEqual(latToTileY(85.0511287798066, 3), 0);
    assert.strictEqual(latToTileY(-90, 3), 7);
    // 输出钳制：任何输入都不越界
    assert.strictEqual(lonToTileX(180, 3), 7);
    assert.strictEqual(lonToTileX(-180, 3), 0);
    assert.strictEqual(latToTileY(90, 3), 0);
    assert.strictEqual(latToTileY(-85.0511287798066, 3), 7);
  });

  it('round-trip：瓦片边缘内偏一点换算回同一瓦片', () => {
    for (const zoom of [2, 5, 9]) {
      const n = 2 ** zoom;
      for (const x of [0, 3, Math.floor(n / 2), n - 1]) {
        assert.strictEqual(lonToTileX(tileXToLon(x, zoom) + 1e-4, zoom), x);
        assert.strictEqual(lonToTileX(tileXToLon(x + 1, zoom) - 1e-4, zoom), x);
      }
      for (const y of [0, 3, Math.floor(n / 2), n - 1]) {
        // y 瓦片纬度窗口为 (南边缘, 北边缘]
        assert.strictEqual(latToTileY(tileYToLat(y, zoom) - 1e-4, zoom), y);
        assert.strictEqual(latToTileY(tileYToLat(y + 1, zoom) + 1e-4, zoom), y);
      }
    }
  });

  it('与 Cesium WebMercatorTilingScheme 对齐：positionToTileXY / tileXYToRectangle', () => {
    const scheme = new WebMercatorTilingScheme();
    const samples: Array<[number, number]> = [
      [0, 0],
      [116.3912, 39.9075],
      [-74.0059, 40.7143],
      [-45.5, -45.5],
      [179.5, 80],
      [-120, -80],
    ];
    for (const [lon, lat] of samples) {
      for (const zoom of [1, 2, 3, 5, 8]) {
        const tile = scheme.positionToTileXY(Cartographic.fromDegrees(lon, lat), zoom);
        assert.notStrictEqual(tile, undefined);
        assert.strictEqual(lonToTileX(lon, zoom), tile!.x);
        assert.strictEqual(latToTileY(lat, zoom), tile!.y);
      }
    }
    for (const [x, y, zoom] of [
      [0, 0, 0],
      [1, 1, 1],
      [2, 3, 3],
      [4, 2, 3],
      [301, 383, 10],
    ] as Array<[number, number, number]>) {
      const rect = scheme.tileXYToRectangle(x, y, zoom);
      closeTo(tileXToLon(x, zoom), CesiumMath.toDegrees(rect.west), 6);
      closeTo(tileYToLat(y, zoom), CesiumMath.toDegrees(rect.north), 6);
    }
  });

  it('像素投影与切片换算同源：瓦片内点投影结果落在 [0, tileSize)', () => {
    // 点 (10,10) @ z3 位于瓦片 (4,3)，像素应在瓦片内部
    const [px, py] = projectLonLatToTilePixel(10, 10, 3, 4, 3, 256);
    assert.ok(px > (0));
    assert.ok(px < (256));
    assert.ok(py > (0));
    assert.ok(py < (256));
    // 同一点在相邻瓦片投影出界（交给画布裁剪）
    const [nx] = projectLonLatToTilePixel(10, 10, 3, 3, 3, 256);
    assert.ok(nx > (256));
  });
});

// ---------------------------------------------------------------------------
// extent → 瓦片范围
// ---------------------------------------------------------------------------

describe('generate2d · tileRangeForExtent', () => {
  it('世界范围 z1 → 2×2；z0 → 单瓦片', () => {
    assert.deepStrictEqual(tileRangeForExtent([-180, -90, 180, 90], 1), {
      minTileX: 0,
      maxTileX: 1,
      minTileY: 0,
      maxTileY: 1,
    });
    assert.deepStrictEqual(tileRangeForExtent([-180, -90, 180, 90], 0), {
      minTileX: 0,
      maxTileX: 0,
      minTileY: 0,
      maxTileY: 0,
    });
  });

  it('小范围 z10 → 单瓦片（与换算函数一致）', () => {
    // z10 的 y=384/385 瓦片边界在 40.71396°，取 40.72~40.75 保证单瓦片
    const range = tileRangeForExtent([-74.01, 40.72, -74.0, 40.75], 10);
    assert.deepStrictEqual(range, {
      minTileX: lonToTileX(-74.01, 10),
      maxTileX: lonToTileX(-74.0, 10),
      minTileY: latToTileY(40.75, 10),
      maxTileY: latToTileY(40.72, 10),
    });
    assert.strictEqual(range!.minTileX, range!.maxTileX);
    assert.strictEqual(range!.minTileY, range!.maxTileY);
  });

  it('边界经纬度瓦片仍入选（floor 语义：边界点可见于归属瓦片），空瓦片由要素预筛剔除', () => {
    // maxLon=0 恰在 tile x=1 的左边缘：内容可出现在其 px=0 处
    assert.deepStrictEqual(tileRangeForExtent([-180, -10, 0, 10], 1), {
      minTileX: 0,
      maxTileX: 1,
      minTileY: 0,
      maxTileY: 1,
    });
    // minLat=0 恰在 tile y=1 的北边缘（可见于 py=0）
    assert.deepStrictEqual(tileRangeForExtent([-10, 0, 10, 10], 1), {
      minTileX: 0,
      maxTileX: 1,
      minTileY: 0,
      maxTileY: 1,
    });
  });

  it('纬度自动钳制到 Web Mercator：北极带单行瓦片', () => {
    const range = tileRangeForExtent([-10, 84, 10, 89.9], 1);
    assert.deepStrictEqual(range, { minTileX: 0, maxTileX: 1, minTileY: 0, maxTileY: 0 });
  });

  it('与墨卡托世界无交（纬度带外 / 经度越界）→ undefined', () => {
    assert.strictEqual(tileRangeForExtent([-10, -89.9, 10, -85.2], 3), undefined);
    assert.strictEqual(tileRangeForExtent([-10, 86, 10, 89.9], 3), undefined);
    assert.strictEqual(tileRangeForExtent([200, -10, 300, 10], 3), undefined);
  });
});

// ---------------------------------------------------------------------------
// GeoJSON 归一化
// ---------------------------------------------------------------------------

describe('generate2d · geojsonExtent / normalizeGeoJSONFeatures', () => {
  it('extent 为全部要素 bbox 的并集', () => {
    const data = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [116, 40] }, properties: {} },
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[100, 20], [120, 50]] },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
          },
          properties: {},
        },
      ],
    } as unknown as GeoJSONData;
    assert.deepStrictEqual(geojsonExtent(data), [0, 0, 120, 50]);
  });

  it('空集合 / 全 null geometry → undefined；null geometry 的 Feature 被忽略', () => {
    assert.strictEqual(geojsonExtent({ type: 'FeatureCollection', features: [] } as never), undefined);
    const withNull = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: null, properties: {} }],
    } as unknown as GeoJSONData;
    assert.strictEqual(geojsonExtent(withNull), undefined);
    assert.deepStrictEqual(normalizeGeoJSONFeatures(withNull), []);
  });

  it('几何类型归一化：MultiPoint/MultiLineString/Polygon(含洞)/MultiPolygon', () => {
    const features = normalizeGeoJSONFeatures({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'MultiPoint', coordinates: [[1, 1], [2, 2], [3, 3]] },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
              [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]],
            ],
          },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [[[0, 0], [1, 0], [1, 1], [0, 0]]],
              [[[5, 5], [6, 5], [6, 6], [5, 5]]],
            ],
          },
          properties: {},
        },
      ],
    } as never);
    assert.deepStrictEqual(features.map((f) => f.kind), ['point', 'line', 'polygon', 'polygon']);
    assert.strictEqual(features[0]!.rings.length, (3));
    assert.strictEqual(features[1]!.rings.length, (2));
    assert.strictEqual(features[2]!.rings.length, (2)); // 外环 + 洞
    assert.strictEqual(features[3]!.rings.length, (2)); // 两个面各 1 环
    assert.deepStrictEqual(features[3]!.bbox, [0, 0, 6, 6]);
  });

  it('无效坐标跳过、退化环丢弃；Geometry 顶层数据可用', () => {
    const features = normalizeGeoJSONFeatures({
      type: 'MultiLineString',
      coordinates: [
        [[0, 0], [Number.NaN, 5], [10, 10]],
        [[1, 1]],
      ],
    } as never);
    assert.strictEqual(features.length, (1));
    assert.deepStrictEqual(features[0]!.rings, [[[0, 0], [10, 10]]]);
    // 纯无效 Point → 无要素
    assert.deepStrictEqual(normalizeGeoJSONFeatures({ type: 'Point', coordinates: [Number.NaN, 5] } as never), []);
  });
});

// ---------------------------------------------------------------------------
// generateXyzFromGeoJSON 端到端（假画布）
// ---------------------------------------------------------------------------

describe('generate2d · generateXyzFromGeoJSON', () => {
  it('单点 z3：文件清单 / GeneratedCache 结构 / metadata / stats 完整', async () => {
    const { factory, created } = createFakeCanvasFactory();
    const ratios: number[] = [];
    const cache = await generateXyzFromGeoJSON(FC_POINT, {
      minZoom: 3,
      maxZoom: 3,
      canvasFactory: factory,
      onProgress: (r) => ratios.push(r),
    });

    // lonToTileX(116.4,3)=6、latToTileY(39.9,3)=3
    assert.strictEqual(cache.kind, 'xyz');
    assert.strictEqual(cache.entry, '');
    assert.deepStrictEqual(cache.files.map((f) => f.path), ['3/6/3.png']);
    assert.strictEqual(cache.files[0]!.blob.type, 'image/png');

    assert.strictEqual(cache.metadata.cacheKind, 'xyz');
    assert.strictEqual(cache.metadata.cacheSource, 'generated');
    assert.strictEqual(cache.metadata.rootDir, '');
    assert.deepStrictEqual(cache.metadata.detection, {
      xyzTemplate: '{z}/{x}/{y}.png',
      xyzExt: 'png',
      maxLevel: 3,
      tileCount: 1,
    });
    assert.deepStrictEqual(cache.metadata.files.map((f) => f.path), ['3/6/3.png']);
    assert.strictEqual(cache.metadata.totalBytes, cache.files[0]!.blob.size);

    assert.deepStrictEqual(cache.stats, {
      fileCount: 1,
      totalBytes: cache.files[0]!.blob.size,
      maxZoom: 3,
    });

    // 只创建了一个画布，尺寸 = tileSize
    assert.strictEqual(created.length, (1));
    assert.strictEqual(created[0]!.width, 256);
    assert.strictEqual(created[0]!.height, 256);

    // progress 单调：0 → 1
    assert.strictEqual(ratios[0], 0);
    assert.strictEqual(ratios.at(-1), 1);
    for (let i = 1; i < ratios.length; i++) assert.ok(ratios[i]! >= (ratios[i - 1]!));
  });

  it('多层级：z0~z1 的点 (116.4,39.9) → 0/0/0.png 与 1/1/0.png', async () => {
    const { factory } = createFakeCanvasFactory();
    const cache = await generateXyzFromGeoJSON(FC_POINT, {
      minZoom: 0,
      maxZoom: 1,
      canvasFactory: factory,
    });
    // z1：x=floor((296.4/360)*2)=1，39.9°N 在北半片 → y=0
    assert.deepStrictEqual(cache.files.map((f) => f.path), ['0/0/0.png', '1/1/0.png']);
    assert.strictEqual(cache.stats.maxZoom, 1);
    assert.strictEqual(cache.metadata.detection?.maxLevel, 1);
    assert.strictEqual(cache.metadata.detection?.tileCount, 2);
  });

  it('bbox 预筛：候选范围内的空瓦片不产出文件、不创建画布', async () => {
    const { factory, created } = createFakeCanvasFactory();
    const cache = await generateXyzFromGeoJSON(FC_TWO_POINTS, {
      minZoom: 3,
      maxZoom: 3,
      canvasFactory: factory,
    });
    // 候选 4 块，仅 2 块有内容（(10,10)→4/3、(60,60)→5/2）
    assert.deepStrictEqual(cache.files.map((f) => f.path), ['3/4/3.png', '3/5/2.png']);
    assert.strictEqual(created.length, (2));
    assert.strictEqual(cache.metadata.detection?.tileCount, 2);
  });

  it('全透明瓦片（画了但无墨）不产出文件；全部为空时报错', async () => {
    const inkless = createFakeCanvasFactory({ ink: false });
    await assert.rejects(generateXyzFromGeoJSON(FC_TWO_POINTS, {
        minZoom: 3,
        maxZoom: 3,
        canvasFactory: inkless.factory,
      }), /未生成任何 XYZ 瓦片/);

    // 无 getImageData 的上下文 → 保守保留瓦片
    const noProbe = createFakeCanvasFactory({ getImageData: false });
    const cache = await generateXyzFromGeoJSON(FC_TWO_POINTS, {
      minZoom: 3,
      maxZoom: 3,
      canvasFactory: noProbe.factory,
    });
    assert.strictEqual(cache.files.length, (2));
  });

  it('样式可控：点/线/面分别应用 pointColor/lineColor+lineWidth/fillColor+fillOpacity', async () => {
    const { factory, created } = createFakeCanvasFactory();
    await generateXyzFromGeoJSON(FC_MIXED, {
      minZoom: 3,
      maxZoom: 3,
      canvasFactory: factory,
      style: {
        pointColor: '#123456',
        pointRadius: 9,
        lineColor: '#abcdef',
        lineWidth: 5,
        fillColor: '#654321',
        fillOpacity: 0.5,
      },
    });

    assert.strictEqual(created.length, (1));
    const { ops, state } = created[0]!;

    // 点：arc 半径 = pointRadius，填充色 = pointColor
    const arc = ops.find((o) => o.op === 'arc')!;
    assert.strictEqual(arc.args[2], 9);
    assert.strictEqual(arc.style.fillStyle, '#123456');
    assert.strictEqual(arc.style.globalAlpha, 1);

    // 面：evenodd 填充 + fillOpacity，随后 globalAlpha 复位为 1
    const polyFill = ops.find((o) => o.op === 'fill' && o.args[0] === 'evenodd')!;
    assert.strictEqual(polyFill.style.fillStyle, '#654321');
    assert.strictEqual(polyFill.style.globalAlpha, 0.5);
    const strokeOps = ops.filter((o) => o.op === 'stroke');
    assert.strictEqual(strokeOps.length, (2)); // 线 + 面轮廓
    for (const s of strokeOps) {
      assert.strictEqual(s.style.strokeStyle, '#abcdef');
      assert.strictEqual(s.style.lineWidth, 5);
    }
    assert.strictEqual(state.globalAlpha, 1); // 复位，不影响后续绘制

    // 线：1 moveTo + 1 lineTo；面（5 点环）：1 moveTo + 4 lineTo → 共 7
    const lineOps = ops.filter((o) => o.op === 'moveTo' || o.op === 'lineTo');
    assert.strictEqual(lineOps.length, (7));
    assert.strictEqual(ops.filter((o) => o.op === 'closePath').length, (1));
  });

  it('默认样式生效（DEFAULT_XYZ_STYLE）', async () => {
    const { factory, created } = createFakeCanvasFactory();
    await generateXyzFromGeoJSON(FC_POINT, { minZoom: 3, maxZoom: 3, canvasFactory: factory });
    const arc = created[0]!.ops.find((o) => o.op === 'arc')!;
    assert.strictEqual(arc.args[2], DEFAULT_XYZ_STYLE.pointRadius);
    assert.strictEqual(arc.style.fillStyle, DEFAULT_XYZ_STYLE.pointColor);
  });

  it('File 输入与非 GeoJSON 文件报错', async () => {
    const { factory } = createFakeCanvasFactory();
    const cache = await generateXyzFromGeoJSON(
      geojsonFile('point.geojson', JSON.stringify(FC_POINT)),
      { minZoom: 3, maxZoom: 3, canvasFactory: factory },
    );
    assert.deepStrictEqual(cache.files.map((f) => f.path), ['3/6/3.png']);

    await assert.rejects(generateXyzFromGeoJSON(geojsonFile('bad.json', '{oops'), {
        minZoom: 3,
        maxZoom: 3,
        canvasFactory: factory,
      }), /GeoJSON 文件解析失败/);
    await assert.rejects(generateXyzFromGeoJSON(
        geojsonFile('g.json', JSON.stringify({ type: 'GeometryCollection', geometries: [] })),
        { minZoom: 3, maxZoom: 3, canvasFactory: factory },
      ), /数据类型不受支持/);
    await assert.rejects(generateXyzFromGeoJSON(
        geojsonFile('empty.geojson', JSON.stringify({ type: 'FeatureCollection', features: [] })),
        { minZoom: 3, maxZoom: 3, canvasFactory: factory },
      ), /不含任何有效几何要素/);
  });

  it('参数校验：缩放级别 / 瓦片边长 / bounds', async () => {
    const { factory } = createFakeCanvasFactory();
    const opts = { canvasFactory: factory };
    await assert.rejects(generateXyzFromGeoJSON(FC_POINT, { ...opts, minZoom: 3, maxZoom: 2 }), /缩放级别非法/);
    await assert.rejects(generateXyzFromGeoJSON(FC_POINT, { ...opts, minZoom: -1, maxZoom: 3 }), /缩放级别非法/);
    await assert.rejects(generateXyzFromGeoJSON(FC_POINT, { ...opts, minZoom: 0.5, maxZoom: 3 }), /缩放级别非法/);
    await assert.rejects(generateXyzFromGeoJSON(FC_POINT, { ...opts, minZoom: 0, maxZoom: MAX_GENERATE_ZOOM + 1 }), /缩放级别非法/);
    await assert.rejects(generateXyzFromGeoJSON(FC_POINT, { ...opts, minZoom: 3, maxZoom: 3, tileSize: 0 }), /瓦片边长非法/);
    await assert.rejects(generateXyzFromGeoJSON(FC_POINT, {
        ...opts,
        minZoom: 3,
        maxZoom: 3,
        bounds: [0, 0, 10, -5],
      }), /bounds 非法/);
    await assert.rejects(generateXyzFromGeoJSON(FC_POINT, {
        ...opts,
        minZoom: 3,
        maxZoom: 3,
        bounds: [200, 0, 300, 10],
      }), /bounds 非法/);
    // bounds 与墨卡托世界无交
    await assert.rejects(generateXyzFromGeoJSON(FC_POINT, {
        ...opts,
        minZoom: 3,
        maxZoom: 3,
        bounds: [-10, -89.9, 10, -85.2] as GeoBounds,
      }), /无交集/);
  });

  it('bounds 裁剪生成范围：小 bounds 不产生范围外瓦片', async () => {
    const { factory } = createFakeCanvasFactory();
    const cache = await generateXyzFromGeoJSON(FC_TWO_POINTS, {
      minZoom: 3,
      maxZoom: 3,
      canvasFactory: factory,
      bounds: [5, 5, 20, 20], // 只覆盖点 (10,10) 附近
    });
    assert.deepStrictEqual(cache.files.map((f) => f.path), ['3/4/3.png']);
  });
});

// ---------------------------------------------------------------------------
// zip 桥接（复用 generate3d 的 kind 无关实现）
// ---------------------------------------------------------------------------

describe('generate2d · zip 桥接', () => {
  it('generatedCacheToZipInputs / zipGeneratedCache 对 xyz 缓存同样可用', async () => {
    const { factory } = createFakeCanvasFactory();
    const cache = await generateXyzFromGeoJSON(FC_POINT, {
      minZoom: 3,
      maxZoom: 3,
      canvasFactory: factory,
    });

    const inputs = generatedCacheToZipInputs(cache);
    assert.strictEqual(inputs.rootDir, '');
    assert.deepStrictEqual(inputs.entries.map((e) => e.path), ['3/6/3.png']);
    assert.strictEqual(inputs.entries.every((e) => e.data instanceof Blob), true);

    const result = await zipGeneratedCache(cache);
    assert.strictEqual(result.fileCount, 1);
    assert.strictEqual(result.totalBytes, cache.metadata.totalBytes);
    const zip = await JSZip.loadAsync(await result.zip.arrayBuffer());
    assert.deepStrictEqual(Object.keys(zip.files), ['3/6/3.png']);
  });

  it('多层级生成的文件路径全部可被 parseXyzPath 识别', async () => {
    const { factory } = createFakeCanvasFactory();
    const cache = await generateXyzFromGeoJSON(FC_TWO_POINTS, {
      minZoom: 2,
      maxZoom: 3,
      canvasFactory: factory,
    });
    for (const file of cache.files) {
      const info = parseXyzPath(file.path);
      assert.notStrictEqual(info, null);
      assert.strictEqual(info!.ext, 'png');
    }
  });
});

// ---------------------------------------------------------------------------
// 预览桥接
// ---------------------------------------------------------------------------

describe('generate2d · importGeneratedXyzToLayers', () => {
  const created = new Map<string, Blob>();
  let createSpy: MockInstance;
  let revokeSpy: MockInstance;

  beforeEach(() => {
    created.clear();
    createSpy = mock.method(URL, 'createObjectURL', (obj: Blob | MediaSource) => {
      const url = `blob:xyz-test/${created.size}`;
      created.set(url, obj as Blob);
      return url;
    });
    revokeSpy = mock.method(URL, 'revokeObjectURL', () => undefined);
  });

  afterEach(() => {
    createSpy.mock.restore();
    revokeSpy.mock.restore();
  });

  it('注册 LocalXyzImageryProvider 图层：瓦片映射 / 层级 / metadata / 默认名', async () => {
    const { factory } = createFakeCanvasFactory();
    const cache = await generateXyzFromGeoJSON(FC_POINT, {
      minZoom: 3,
      maxZoom: 3,
      canvasFactory: factory,
    });
    const { manager, imageryCalls } = createFakeLayerManager();

    const layerId = await importGeneratedXyzToLayers(cache, manager);

    assert.strictEqual(layerId, 'imagery-1');
    assert.strictEqual(imageryCalls.length, (1));
    assert.strictEqual(imageryCalls[0]!.name, '生成的 XYZ 瓦片缓存');
    assert.ok(imageryCalls[0]!.provider instanceof LocalXyzImageryProvider);
    const provider = imageryCalls[0]!.provider as LocalXyzImageryProvider;
    assert.strictEqual(provider.tiles.has('3/6/3'), true);
    assert.strictEqual(provider.minLevel, 3);
    assert.strictEqual(provider.maxLevel, 3);
    assert.strictEqual(imageryCalls[0]!.source.url, '{z}/{x}/{y}.png');
    assert.strictEqual(imageryCalls[0]!.source.metadata?.cacheSource, 'generated');
    assert.strictEqual(imageryCalls[0]!.source.metadata?.cacheKind, 'xyz');
    assert.strictEqual(imageryCalls[0]!.options.maximumLevel, 3);

    // 释放：每个瓦片 URL 被 revoke，且重复调用安全
    revokeGeneratedXyzLayerUrls(layerId);
    assert.strictEqual(revokeSpy.mock.calls.length, 1);
    revokeGeneratedXyzLayerUrls(layerId);
    assert.strictEqual(revokeSpy.mock.calls.length, 1);
  });

  it('自定义图层名 / 非 xyz 结果 / 无瓦片给出明确错误', async () => {
    const { factory } = createFakeCanvasFactory();
    const cache = await generateXyzFromGeoJSON(FC_POINT, {
      minZoom: 3,
      maxZoom: 3,
      canvasFactory: factory,
    });
    const { manager, imageryCalls } = createFakeLayerManager();
    await importGeneratedXyzToLayers(cache, manager, { name: '我的瓦片' });
    assert.strictEqual(imageryCalls[0]!.name, '我的瓦片');

    await assert.rejects(importGeneratedXyzToLayers({ ...cache, kind: '3dtiles' }, manager), /仅支持 xyz 缓存/);
    await assert.rejects(importGeneratedXyzToLayers({ ...cache, files: [] }, manager), /不含任何可识别的 XYZ 瓦片/);
  });
});
