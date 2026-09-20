/**
 * editor/core · localCache/generate2d —— 框选区域（bbox + 数据源）生成 XYZ 缓存 单测（t20）
 *
 * 覆盖：
 * - buildXyzTileUrl：{z}/{x}/{y} 代入、{s} 子域轮转（含缺省子域）、{token} 编码
 * - source='selectedVector'：bbox 输入（可小于数据 extent）、复用矢量渲染管线
 *   （点/线/面）、产物与 generateXyzFromGeoJSON 同构（可被 parseXyzPath 识别）、
 *   进度单调、缺数据源 / 空要素 / 非法输入的可读错误
 * - source='basemap'：注入假 loader 走通并发拉取 → PNG 重编码、瓦片缺失与
 *   全透明瓦片的双重剔除、URL 模板代入、maximumLevel 钳制、连续失败提前中止、
 *   数据源缺失 / 模板非法的可读错误
 *
 * 全部在 node 环境用假画布 + 假 loader 断言结构，不触网、不依赖 DOM。
 */
import type { GeoJSONData } from '@geolibre/gis-shared';
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseXyzPath } from '../packages/xyz-cache/src/detect';
import {
  BASEMAP_FAILURE_LIMIT,
  buildXyzTileUrl,
  generateXyzFromRegion,
  type TileCanvasFactory,
  type TileContext2D,
  type XyzTileImage,
  type XyzTileLoader,
  type XyzTileRequest,
} from '../packages/xyz-cache/src/generate-2d';
import { latToTileY, lonToTileX, tileRangeForExtent } from '../packages/xyz-cache/src/generate-2d';

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

const FC_POINT = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: {} }],
} as unknown as GeoJSONData;

const FC_TWO_POINTS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [10, 10] }, properties: {} },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [60, 60] }, properties: {} },
  ],
} as unknown as GeoJSONData;

const FC_MIXED = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [10, 10] }, properties: {} },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[11, 11], [12, 12]] }, properties: {} },
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

const FC_EMPTY = { type: 'FeatureCollection', features: [] } as unknown as GeoJSONData;

/** OSM 风格底图模板 */
const OSM_TEMPLATE = 'https://tile.example.com/{z}/{x}/{y}.png';

// ---------------------------------------------------------------------------
// 假画布 / 假 loader
// ---------------------------------------------------------------------------

interface FakeOp {
  op: string;
  args: unknown[];
}

interface FakeCanvasRecord {
  width: number;
  height: number;
  ops: FakeOp[];
}

/**
 * 假画布工厂：记录 drawImage / 矢量绘制调用，并按 `ink` 控制 getImageData 结果
 * （ink=false 模拟「拉了瓦片但全透明」→ 应被空瓦片剔除）。
 */
function createFakeCanvasFactory(
  options: { ink?: boolean; getImageData?: boolean } = {},
): { factory: TileCanvasFactory; created: FakeCanvasRecord[] } {
  const created: FakeCanvasRecord[] = [];
  const factory: TileCanvasFactory = (width, height) => {
    const ops: FakeOp[] = [];
    const record = (op: string, args: unknown[] = []): void => {
      ops.push({ op, args });
    };
    const context = {
      lineJoin: '',
      lineCap: '',
      globalAlpha: 1,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      beginPath: () => record('beginPath'),
      arc: (...args: unknown[]) => record('arc', args),
      moveTo: (...args: unknown[]) => record('moveTo', args),
      lineTo: (...args: unknown[]) => record('lineTo', args),
      closePath: () => record('closePath'),
      fill: (...args: unknown[]) => record('fill', args),
      stroke: () => record('stroke'),
      drawImage: (...args: unknown[]) => record('drawImage', args),
      ...(options.getImageData === false
        ? {}
        : {
            getImageData: () => ({
              data: new Uint8ClampedArray(width * height * 4).fill(options.ink === false ? 0 : 255),
            }),
          }),
    };
    created.push({ width, height, ops });
    return {
      context: context as unknown as TileContext2D,
      toPngBlob: async () => new Blob([`png-${width}x${height}`], { type: 'image/png' }),
    };
  };
  return { factory, created };
}

const FAKE_IMAGE = {} as unknown as XyzTileImage;

/** 造一个记录请求的假 loader：available 决定该瓦片是否存在（undefined = 404） */
function createFakeLoader(
  available?: (tile: { zoom: number; x: number; y: number }) => boolean,
): { loader: XyzTileLoader; calls: XyzTileRequest[] } {
  const calls: XyzTileRequest[] = [];
  const loader: XyzTileLoader = async (request) => {
    calls.push(request);
    return !available || available(request) ? FAKE_IMAGE : undefined;
  };
  return { loader, calls };
}

/** 候选瓦片路径全集（与引擎枚举口径一致，用于顺序断言） */
function candidatePaths(bounds: [number, number, number, number], minZoom: number, maxZoom: number): string[] {
  const out: string[] = [];
  for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
    const range = tileRangeForExtent(bounds, zoom);
    if (!range) continue;
    for (let x = range.minTileX; x <= range.maxTileX; x++) {
      for (let y = range.minTileY; y <= range.maxTileY; y++) out.push(`${zoom}/${x}/${y}.png`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// URL 模板代入
// ---------------------------------------------------------------------------

describe('generateXyzFromRegion · buildXyzTileUrl', () => {
  it('代入 {z}/{x}/{y} 与 {s}（子域轮转）/ {token}（URL 编码）', () => {
    assert.strictEqual(buildXyzTileUrl(OSM_TEMPLATE, { zoom: 3, x: 6, y: 3 }), 'https://tile.example.com/3/6/3.png',);
    // 显式子域：按 (x + y) % n 轮转（x+y=3 → 下标 0）
    assert.strictEqual(buildXyzTileUrl('https://t{s}.example.com/{z}/{x}/{y}.png', { zoom: 1, x: 1, y: 2 }, ['1', '2', '3']), 'https://t1.example.com/1/1/2.png');
    // 缺省子域 a/b/c（x+y=1 → 下标 1）
    assert.strictEqual(buildXyzTileUrl('https://t{s}.example.com/{z}/{x}/{y}', { zoom: 0, x: 0, y: 1 }), 'https://tb.example.com/0/0/1',);
    // token 需要 URL 编码
    assert.strictEqual(buildXyzTileUrl('https://x.example.com/{z}/{x}/{y}?tk={token}', { zoom: 2, x: 1, y: 1 }, [], 'a b/c'), 'https://x.example.com/2/1/1?tk=a%20b%2Fc');
    // 不含可选占位符时原样保留
    const plain = 'https://x.example.com/{z}/{x}/{y}.jpg';
    assert.strictEqual(buildXyzTileUrl(plain, { zoom: 4, x: 5, y: 6 }), 'https://x.example.com/4/5/6.jpg');
  });
});

// ---------------------------------------------------------------------------
// source='selectedVector'
// ---------------------------------------------------------------------------

describe('generateXyzFromRegion · selectedVector 数据源', () => {
  it('bbox 输入 + 点数据 → 同构 xyz 产物（可被 parseXyzPath 识别）', async () => {
    const { factory } = createFakeCanvasFactory();
    const ratios: number[] = [];
    const bbox: [number, number, number, number] = [116.4, 39.9, 116.4, 39.9];
    const cache = await generateXyzFromRegion({
      bbox,
      minZoom: 3,
      maxZoom: 3,
      source: 'selectedVector',
      data: FC_POINT,
      canvasFactory: factory,
      onProgress: (r) => ratios.push(r),
    });

    const expected = `3/${lonToTileX(116.4, 3)}/${latToTileY(39.9, 3)}.png`;
    assert.strictEqual(cache.kind, 'xyz');
    assert.strictEqual(cache.entry, '');
    assert.deepStrictEqual(cache.files.map((f) => f.path), [expected]);
    assert.strictEqual(cache.metadata.cacheKind, 'xyz');
    assert.strictEqual(cache.metadata.cacheSource, 'generated');
    assert.strictEqual(cache.metadata.rootDir, '');
    assert.strictEqual(cache.metadata.detection?.maxLevel, 3);
    assert.strictEqual(cache.metadata.detection?.tileCount, 1);
    assert.strictEqual(cache.stats.fileCount, 1);
    assert.strictEqual(cache.stats.maxZoom, 3);
    // 产物路径可被下游（importGeneratedXyzToLayers）解析
    assert.deepStrictEqual(parseXyzPath(cache.files[0]!.path), {
      level: 3,
      x: lonToTileX(116.4, 3),
      y: latToTileY(39.9, 3),
      ext: 'png',
    });
    // 进度：首个 0、末个 1、单调不减
    assert.strictEqual(ratios[0], 0);
    assert.strictEqual(ratios[ratios.length - 1], 1);
    for (let i = 1; i < ratios.length; i++) assert.ok(ratios[i]! >= (ratios[i - 1]!));
  });

  it('bbox 可小于数据 extent：只产出覆盖 bbox 的瓦片（远端数据不参与）', async () => {
    const { factory } = createFakeCanvasFactory();
    const bbox: [number, number, number, number] = [9, 9, 11, 11];
    const cache = await generateXyzFromRegion({
      bbox,
      minZoom: 5,
      maxZoom: 5,
      source: 'selectedVector',
      data: FC_TWO_POINTS,
      canvasFactory: factory,
    });
    const range = tileRangeForExtent(bbox, 5)!;
    for (const file of cache.files) {
      const info = parseXyzPath(file.path)!;
      assert.strictEqual(info.level, 5);
      assert.ok(info.x >= (range.minTileX));
      assert.ok(info.x <= (range.maxTileX));
      assert.ok(info.y >= (range.minTileY));
      assert.ok(info.y <= (range.maxTileY));
    }
    // 远端点 [60, 60] 所在瓦片不在 bbox 候选范围内
    const farKey = `${lonToTileX(60, 5)}/${latToTileY(60, 5)}`;
    assert.notStrictEqual(farKey, `${lonToTileX(10, 5)}/${latToTileY(10, 5)}`);
    assert.strictEqual(cache.files.some((f) => f.path === `5/${farKey}.png`), false);
    assert.ok(cache.files.length > (0));
  });

  it('复用矢量渲染管线：点 arc / 线 stroke / 面 fill(evenodd) + 样式生效', async () => {
    const { factory, created } = createFakeCanvasFactory();
    await generateXyzFromRegion({
      bbox: [10, 10, 12, 12],
      minZoom: 3,
      maxZoom: 3,
      source: 'selectedVector',
      data: FC_MIXED,
      style: { pointRadius: 7, pointColor: '#123456', lineColor: '#654321', lineWidth: 5, fillColor: '#abcdef', fillOpacity: 0.5 },
      canvasFactory: factory,
    });
    const ops = created.flatMap((c) => c.ops);
    assert.strictEqual(ops.some((o) => o.op === 'arc' && o.args[2] === 7), true);
    assert.strictEqual(ops.some((o) => o.op === 'fill' && o.args[0] === 'evenodd'), true);
    assert.strictEqual(ops.some((o) => o.op === 'stroke'), true);
    assert.strictEqual(ops.every((o) => o.op !== 'drawImage'), true);
    // 有墨 → 每个被绘制的候选瓦片都产出一个文件
    assert.ok(created.length > (0));
  });

  it('全透明瓦片（无墨）被剔除 → 抛可读错误', async () => {
    const { factory } = createFakeCanvasFactory({ ink: false });
    await assert.rejects(generateXyzFromRegion({
        bbox: [116.4, 39.9, 116.4, 39.9],
        minZoom: 3,
        maxZoom: 3,
        source: 'selectedVector',
        data: FC_POINT,
        canvasFactory: factory,
      }), /未生成任何 XYZ 瓦片/);
  });

  it('数据源缺失 / 空要素 → 可读错误', async () => {
    const { factory } = createFakeCanvasFactory();
    await assert.rejects(generateXyzFromRegion({
        bbox: [0, 0, 1, 1],
        minZoom: 0,
        maxZoom: 0,
        source: 'selectedVector',
        canvasFactory: factory,
      }), /矢量数据源缺失/);
    await assert.rejects(generateXyzFromRegion({
        bbox: [0, 0, 1, 1],
        minZoom: 0,
        maxZoom: 0,
        source: 'selectedVector',
        data: FC_EMPTY,
        canvasFactory: factory,
      }), /不含任何有效几何要素/);
  });
});

// ---------------------------------------------------------------------------
// source='basemap'
// ---------------------------------------------------------------------------

describe('generateXyzFromRegion · basemap 数据源', () => {
  const BBOX: [number, number, number, number] = [9, 9, 11, 11];

  it('逐瓦片拉取 → PNG 重编码；缺失瓦片按空瓦片剔除；产物顺序与候选枚举一致', async () => {
    const { factory, created } = createFakeCanvasFactory();
    const wide: [number, number, number, number] = [9, 9, 40, 40];
    const { loader, calls } = createFakeLoader((tile) => (tile.x + tile.y) % 2 === 0);
    const cache = await generateXyzFromRegion({
      bbox: wide,
      minZoom: 2,
      maxZoom: 4,
      tileSize: 256,
      source: 'basemap',
      basemap: { urlTemplate: OSM_TEMPLATE, label: 'OSM', maximumLevel: 19 },
      loadTile: loader,
      concurrency: 2,
      canvasFactory: factory,
    });

    const all = candidatePaths(wide, 2, 4);
    assert.strictEqual(calls.map((c) => c.url).length, (all.length));
    // 请求 URL 已完全代入占位符
    for (const call of calls) assert.match(call.url, /^https:\/\/tile\.example\.com\/\d+\/\d+\/\d+\.png$/);
    // 只有 loader 给出图像的瓦片产出文件，且顺序 = 候选枚举顺序的子序列
    const available = all.filter((p) => {
      const info = parseXyzPath(p)!;
      return (info.x + info.y) % 2 === 0;
    });
    assert.ok(available.length > (0));
    assert.ok(available.length < (all.length));
    assert.deepStrictEqual(cache.files.map((f) => f.path), available);
    // 每张产出瓦片都 drawImage 到 256×256 画布
    assert.strictEqual(created.length, available.length);
    assert.strictEqual(created.every((c) => c.width === 256 && c.height === 256), true);
    assert.strictEqual(created.every((c) => c.ops.some((o) => o.op === 'drawImage')), true);
    assert.strictEqual(cache.metadata.cacheKind, 'xyz');
  });

  it('全部瓦片 404 → 抛可读错误；拉全透明瓦片 → 被剔除后同样报错', async () => {
    const { factory } = createFakeCanvasFactory();
    const { loader } = createFakeLoader(() => false);
    await assert.rejects(generateXyzFromRegion({
        bbox: BBOX,
        minZoom: 2,
        maxZoom: 2,
        source: 'basemap',
        basemap: { urlTemplate: OSM_TEMPLATE },
        loadTile: loader,
        canvasFactory: factory,
      }), /没有可用影像/);

    const transparent = createFakeCanvasFactory({ ink: false });
    const okLoader = createFakeLoader(() => true);
    await assert.rejects(generateXyzFromRegion({
        bbox: BBOX,
        minZoom: 2,
        maxZoom: 2,
        source: 'basemap',
        basemap: { urlTemplate: OSM_TEMPLATE },
        loadTile: okLoader.loader,
        canvasFactory: transparent.factory,
      }), /没有可用影像/);
  });

  it('loader 抛错（跨域/鉴权）且无产物 → 提前中止并保留首个可读原因', async () => {
    const { factory } = createFakeCanvasFactory();
    const calls: XyzTileRequest[] = [];
    const loader: XyzTileLoader = async (request) => {
      calls.push(request);
      throw new Error('底图服务拒绝访问（HTTP 401）');
    };
    const wide: [number, number, number, number] = [-30, -30, 30, 30];
    await assert.rejects(generateXyzFromRegion({
        bbox: wide,
        minZoom: 0,
        maxZoom: 8,
        source: 'basemap',
        basemap: { urlTemplate: OSM_TEMPLATE, label: '天地图 影像' },
        loadTile: loader,
        concurrency: 3,
        canvasFactory: factory,
      }), /HTTP 401|未产出任何缓存文件/);
    const total = candidatePaths(wide, 0, 8).length;
    assert.ok(total > (BASEMAP_FAILURE_LIMIT * 2));
    assert.ok(calls.length < (total));
    assert.ok(calls.length <= (BASEMAP_FAILURE_LIMIT + 3));
  });

  it('maximumLevel 钳制 maxZoom（底图没有更高层级瓦片）', async () => {
    const { factory } = createFakeCanvasFactory();
    const { loader, calls } = createFakeLoader(() => true);
    const cache = await generateXyzFromRegion({
      bbox: BBOX,
      minZoom: 0,
      maxZoom: 22,
      source: 'basemap',
      basemap: { urlTemplate: OSM_TEMPLATE, maximumLevel: 2 },
      loadTile: loader,
      canvasFactory: factory,
    });
    assert.deepStrictEqual(new Set(calls.map((c) => c.zoom)), new Set([0, 1, 2]));
    for (const file of cache.files) assert.ok(Number(file.path.split('/')[0]) <= (2));
    assert.strictEqual(cache.stats.maxZoom, 2);
  });

  it('maximumLevel 低于 minZoom / 数据源缺失 / 模板非法 → 可读错误', async () => {
    const { factory } = createFakeCanvasFactory();
    const { loader } = createFakeLoader(() => true);
    await assert.rejects(generateXyzFromRegion({
        bbox: BBOX,
        minZoom: 5,
        maxZoom: 8,
        source: 'basemap',
        basemap: { urlTemplate: OSM_TEMPLATE, maximumLevel: 3, label: 'OSM' },
        loadTile: loader,
        canvasFactory: factory,
      }), /最大层级为 z3/);

    await assert.rejects(generateXyzFromRegion({
        bbox: BBOX,
        minZoom: 2,
        maxZoom: 3,
        source: 'basemap',
        canvasFactory: factory,
      }), /底图数据源缺失/);

    await assert.rejects(generateXyzFromRegion({
        bbox: BBOX,
        minZoom: 2,
        maxZoom: 3,
        source: 'basemap',
        basemap: { urlTemplate: 'https://tile.example.com/tile.png' },
        loadTile: loader,
        canvasFactory: factory,
      }), /URL 模板非法/);
  });

  it('{s} / {token} 模板代入后请求真实 URL', async () => {
    const { factory } = createFakeCanvasFactory();
    const { loader, calls } = createFakeLoader(() => true);
    await generateXyzFromRegion({
      bbox: BBOX,
      minZoom: 1,
      maxZoom: 1,
      source: 'basemap',
      basemap: {
        urlTemplate: 'https://t{s}.tianditu.example.com/DataServer?T=img_w&x={x}&y={y}&l={z}&tk={token}',
        subdomains: ['0', '1', '2', '3'],
        token: 'KEY-1',
        maximumLevel: 18,
      },
      loadTile: loader,
      canvasFactory: factory,
    });
    assert.ok(calls.length > (0));
    for (const call of calls) {
      assert.match(call.url, /^https:\/\/t[0-3]\.tianditu\.example\.com\/DataServer\?T=img_w&x=\d+&y=\d+&l=1&tk=KEY-1$/);
    }
  });

  it('非法 bbox / 缩放 / 瓦片边长 → 可读错误', async () => {
    const { factory } = createFakeCanvasFactory();
    const { loader } = createFakeLoader(() => true);
    const base = {
      minZoom: 0,
      maxZoom: 1,
      source: 'basemap' as const,
      basemap: { urlTemplate: OSM_TEMPLATE },
      loadTile: loader,
      canvasFactory: factory,
    };
    await assert.rejects(generateXyzFromRegion({ ...base, bbox: [10, 10, 5, 5] }), /bounds 非法/);
    await assert.rejects(generateXyzFromRegion({ ...base, bbox: [-200, 0, 10, 10] }), /bounds 非法/);
    await assert.rejects(generateXyzFromRegion({ ...base, bbox: BBOX, maxZoom: 30 }), /缩放级别非法/);
    await assert.rejects(generateXyzFromRegion({ ...base, bbox: BBOX, tileSize: 0 }), /瓦片边长非法/);
  });
});
