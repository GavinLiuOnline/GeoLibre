/**
 * editor/core · localCache —— 「模板 + 层级范围」免枚举导入 单测（t25）
 *
 * 用户实测场景：`file:///home/nuanyang/tiles`（2,426,811 个文件 / 15GB，
 * `{z}/{x}/{y}.jpg`，**无清单**）在浏览器里既不能枚举目录、也不能全量下载。
 *
 * 覆盖验收要点：
 * 1. **导入期零请求**：全局 fetch 与注入 loader 的调用次数都为 0（不枚举、不下载）；
 * 2. **按需请求**：只有 `provider.requestImage(x, y, level)` 被调用时才现算 URL 并加载，
 *    URL 形如 `<base>/<z>/<x>/<y>.<ext>`；
 * 3. 模板校验（缺占位符 / 空 / 非法层级 / file:// 被拒 + 可执行引导）；
 * 4. 越界（层级、坐标）返回空/透明而不是报错；加载失败走透明 PNG 兜底；
 * 5. `{s}` 子域轮转与 `{token}` 编码替换；
 * 6. metadata 契约（cacheKind/ files=[] / cacheSource='imported' / detection.*）与
 *    `isTemplateXyzLayer` 判定；
 * 7. 与既有 tiles / tileBlobs 模式不回归（优先级与懒加载 LRU）。
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { describe, it } from "node:test";

import type { LayerInfo, LayerManager, LayerSource } from '../LayerManager';
import { importLocalXyzByTemplate, isTemplateXyzLayer } from '../packages/xyz-cache/src/local-cache';
import type { TemplateImportResult } from '../packages/xyz-cache/src/local-cache';
import { LocalXyzImageryProvider } from '../packages/xyz-cache/src/xyz-cache';
import type { XyzTileImageLoader } from '../packages/xyz-cache/src/xyz-cache';

/** vitest toMatchObject 等价：递归子集匹配（期望对象为实际对象的子集） */
const matchShape = (actual: unknown, expected: Record<string, unknown>): void => {
  for (const [k, v] of Object.entries(expected)) {
    const av = (actual as Record<string, unknown>)[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) matchShape(av, v as Record<string, unknown>);
    else assert.deepStrictEqual(av, v, `matchShape: key ${k}`);
  }
};


/** vitest toBeCloseTo 等价：|a-b| < 10^-d / 2 */
const closeTo = (actual: number, expected: number, digits = 9): void => {
  assert.ok(Math.abs(actual - expected) < Math.pow(10, -digits) / 2, `closeTo: ${actual} !~ ${expected} (digits=${digits})`);
};


/** 假 LayerManager：只实现 addImageryLayerInstance（与既有 localCache.test.ts 同风格） */
function createFakeLayerManager(): {
  manager: LayerManager;
  calls: Array<{ name: string; provider: unknown; source: Partial<LayerSource>; options: Record<string, unknown> }>;
} {
  const calls: Array<{
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
      calls.push({ name, provider, source, options });
      return { id: `layer-${calls.length}`, name, type: 'imagery', show: true, opacity: 1 };
    },
  } as unknown as LayerManager;
  return { manager, calls };
}

/** 计数型图像加载器：记录被请求的 URL（模拟「Cesium 真正请求瓦片」） */
function createCountingLoader(): { loader: XyzTileImageLoader; urls: string[] } {
  const urls: string[] = [];
  const loader: XyzTileImageLoader = async (url) => {
    urls.push(url);
    return {} as unknown as never;
  };
  return { loader, urls };
}

const TEMPLATE = 'http://localhost:8090/{z}/{x}/{y}.jpg';
const TRANSPARENT_PREFIX = 'data:image/png;base64,';

/** 默认参数：0–18 层级 + 注入 loader，断言导入期零请求 */
async function importTemplate(
  overrides: Partial<Parameters<typeof importLocalXyzByTemplate>[1]> = {},
): Promise<{ result: TemplateImportResult; urls: string[]; calls: ReturnType<typeof createFakeLayerManager>['calls'] }> {
  const { manager, calls } = createFakeLayerManager();
  const { loader, urls } = createCountingLoader();
  const result = await importLocalXyzByTemplate(manager, {
    template: TEMPLATE,
    minZoom: 0,
    maxZoom: 18,
    loadImage: loader,
    ...overrides,
  });
  return { result, urls, calls };
}

describe('t25 · 模板模式导入（免枚举 / 零下载）', () => {
  it('导入期零请求：不发 fetch、不调 loader、不枚举文件；只注册图层 + metadata', async () => {
    const fetchSpy = mock.method(globalThis, 'fetch');
    try {
      const { result, urls, calls } = await importTemplate();

      assert.strictEqual(fetchSpy.mock.calls.length, 0);
      assert.deepStrictEqual(urls, []); // 一张瓦片都没请求
      assert.strictEqual(result.kind, 'xyz');
      assert.strictEqual(result.template, TEMPLATE);

      // 图层注册走既有 addImageryLayerInstance 路径
      assert.strictEqual(calls.length, (1));
      assert.ok(calls[0]!.provider instanceof LocalXyzImageryProvider);
      assert.strictEqual(calls[0]!.source.url, TEMPLATE);
      assert.strictEqual(calls[0]!.options.maximumLevel, 18);

      // metadata 契约（t25）：files 为空 + 模板 + 来源标记
      matchShape(result.metadata, {
        cacheKind: 'xyz',
        files: [],
        totalBytes: 0,
        rootDir: '',
        cacheSource: 'imported',
      });
      matchShape(result.metadata.detection, {
        xyzTemplate: TEMPLATE,
        xyzExt: 'jpg',
        minLevel: 0,
        maxLevel: 18,
        tileCount: 0,
        sourceMode: 'template',
      });
      matchShape(result.info, { fileCount: 0, totalBytes: 0, xyzTemplate: TEMPLATE, xyzExt: 'jpg', maxLevel: 18 });
      assert.strictEqual(result.provider.urlTemplate, TEMPLATE);
      // 发布侧判定标记
      assert.strictEqual(isTemplateXyzLayer(result.metadata), true);
      assert.strictEqual(isTemplateXyzLayer(calls[0]!.source.metadata as Record<string, unknown>), true);
    } finally {
      fetchSpy.mock.restore();
    }
  });

  it('Cesium 首次请求时才现算 URL 并按需加载（每张瓦片 +1，URL 为 {z}/{x}/{y} 代入）', async () => {
    const { result, urls } = await importTemplate();
    assert.strictEqual(urls.length, (0));

    const provider = result.provider;
    await provider.requestImage(3, 5, 4);
    assert.deepStrictEqual(urls, ['http://localhost:8090/4/3/5.jpg']);

    await provider.requestImage(0, 0, 1);
    assert.deepStrictEqual(urls, ['http://localhost:8090/4/3/5.jpg', 'http://localhost:8090/1/0/0.jpg']);

    // 同步解析函数同样按需计算（供 UI/诊断使用）；z3 下 x/y 上限为 7
    assert.strictEqual(provider.resolveTileUrl('3/7/6', { x: 7, y: 6, level: 3 }), 'http://localhost:8090/3/7/6.jpg',);
  });

  it('越界（层级 / 坐标）返回空 → 透明 PNG，不报错也不请求模板 URL', async () => {
    const { result, urls } = await importTemplate({ minZoom: 2, maxZoom: 5 });
    const provider = result.provider;

    assert.strictEqual(provider.isTileInRange(2, 3, 6), false); // 层级越界
    assert.strictEqual(provider.isTileInRange(2, 3, 1), false);
    assert.strictEqual(provider.isTileInRange(4, 0, 2), false); // z2 的 x 最大为 3
    assert.strictEqual(provider.isTileInRange(0, 0, 2), true);
    assert.strictEqual(provider.resolveTileUrl('6/0/0', { x: 0, y: 0, level: 6 }), undefined);
    assert.strictEqual(provider.resolveTileUrl('2/4/0', { x: 4, y: 0, level: 2 }), undefined);

    // 越界请求：resolve 出一个「不会 reject」的 Promise，且不触碰模板 URL
    await provider.requestImage(0, 0, 9);
    assert.strictEqual(urls.length, (1));
    assert.strictEqual(urls[0]!.startsWith(TRANSPARENT_PREFIX), true);
  });

  it('加载失败走透明 PNG 兜底（注入 loader 首失败 → 回退；默认 loader 永不 reject）', async () => {
    const attempted: string[] = [];
    const failing: XyzTileImageLoader = async (url) => {
      attempted.push(url);
      if (!url.startsWith(TRANSPARENT_PREFIX)) throw new Error('network down');
      return {} as unknown as never;
    };
    const { result } = await importTemplate({ loadImage: failing });
    await result.provider.requestImage(1, 1, 1);
    assert.strictEqual(attempted[0], 'http://localhost:8090/1/1/1.jpg');
    assert.strictEqual(attempted[1]!.startsWith(TRANSPARENT_PREFIX), true);
  });

  it('{s} 子域轮转与 {token} 编码替换（模板模式同样生效）', async () => {
    const { result, urls } = await importTemplate({
      template: 'https://t{s}.example.com/{z}/{x}/{y}.jpg?tk={token}',
      subdomains: ['0', '1', '2', '3'],
      token: 'KEY-1',
      minZoom: 0,
      maxZoom: 18,
    });
    assert.strictEqual(result.metadata.detection?.xyzExt, 'jpg');
    await result.provider.requestImage(1, 2, 2);
    assert.strictEqual(urls[0], 'https://t3.example.com/2/1/2.jpg?tk=KEY-1');

    const encoded = await importTemplate({
      template: 'https://x.example.com/{z}/{x}/{y}.png?tk={token}',
      token: 'a b/c',
    });
    assert.strictEqual(encoded.result.provider.resolveTileUrl('1/1/1', { x: 1, y: 1, level: 1 }), 'https://x.example.com/1/1/1.png?tk=a%20b%2Fc',);
  });
});

describe('t25 · 基准地址推导与校验', () => {
  it('baseUrl → `<base>/{z}/{x}/{y}.<ext>`（尾斜杠归一、ext 默认 jpg）', async () => {
    const { manager } = createFakeLayerManager();
    const { loader } = createCountingLoader();
    const result = await importLocalXyzByTemplate(manager, {
      baseUrl: 'http://localhost:8090/',
      loadImage: loader,
    });
    assert.strictEqual(result.template, 'http://localhost:8090/{z}/{x}/{y}.jpg');
    assert.strictEqual(result.metadata.detection?.xyzExt, 'jpg');
    assert.strictEqual(result.rootDir, 'localhost:8090');

    const png = await importLocalXyzByTemplate(manager, {
      baseUrl: 'https://cdn.example.com/tiles',
      ext: 'png',
      loadImage: loader,
    });
    assert.strictEqual(png.template, 'https://cdn.example.com/tiles/{z}/{x}/{y}.png');
    assert.strictEqual(png.metadata.detection?.xyzExt, 'png');
    assert.strictEqual(png.rootDir, 'tiles');
  });

  it('模板缺 {z}/{x}/{y} / 全空 / 层级非法 / 缺瓦片数据 → 可读错误', async () => {
    const { manager } = createFakeLayerManager();
    const { loader } = createCountingLoader();
    await assert.rejects(importLocalXyzByTemplate(manager, { template: 'http://localhost:8090/tiles.jpg', loadImage: loader }), /\{z\}\/\{x\}\/\{y\}/);
    await assert.rejects(importLocalXyzByTemplate(manager, { loadImage: loader }), /瓦片模板不能为空/);
    await assert.rejects(importLocalXyzByTemplate(manager, { template: TEMPLATE, minZoom: 5, maxZoom: 2, loadImage: loader }), /层级范围非法/);
    await assert.rejects(importLocalXyzByTemplate(manager, { template: TEMPLATE, maxZoom: 31, loadImage: loader }), /层级范围非法/);
    assert.throws(() => new LocalXyzImageryProvider({ minLevel: 0, maxLevel: 1 }), /缺少瓦片数据/);
    assert.throws(() => new LocalXyzImageryProvider({ urlTemplate: 'http://x/{z}/{y}.jpg', minLevel: 0, maxLevel: 1 }), /\{z\}\/\{x\}\/\{y\}/);
  });

  it('file:// 模板默认拒绝并给「静态服务 + 模板模式」引导；Electron（allowFileUrls）放行', async () => {
    const { manager } = createFakeLayerManager();
    const { loader } = createCountingLoader();
    const fileTemplate = 'file:///home/nuanyang/tiles/{z}/{x}/{y}.jpg';

    await assert.rejects(importLocalXyzByTemplate(manager, { template: fileTemplate, loadImage: loader }), /python3 -m http\.server 8090/);

    const electron = await importLocalXyzByTemplate(manager, {
      template: fileTemplate,
      allowFileUrls: true,
      loadImage: loader,
    });
    assert.strictEqual(electron.provider.urlTemplate, fileTemplate);
    assert.strictEqual(electron.provider.resolveTileUrl('18/1/1', { x: 1, y: 1, level: 18 }), 'file:///home/nuanyang/tiles/18/1/1.jpg',);
  });

  it('可选 bounds 限定请求矩形（避免模板模式对全世界拉瓦片）', async () => {
    const { result } = await importTemplate({ bounds: [116, 39, 117, 40] });
    const rect = result.provider.rectangle;
    closeTo(rect.west, (116 * Math.PI) / 180, 6);
    closeTo(rect.south, (39 * Math.PI) / 180, 6);
    closeTo(rect.east, (117 * Math.PI) / 180, 6);
    closeTo(rect.north, (40 * Math.PI) / 180, 6);
  });

  it('tilingMode=geographic → 使用 GeographicTilingScheme（默认 web-mercator）', async () => {
    const mercator = await importTemplate();
    const geographic = await importTemplate({ tilingMode: 'geographic' });
    assert.ok(mercator.result.provider.tilingScheme.constructor.name.includes('WebMercator'));
    assert.ok(geographic.result.provider.tilingScheme.constructor.name.includes('Geographic'));
  });
});

describe('t25 · 与既有 tiles / tileBlobs 模式不回归', () => {
  it('三种来源并存时的优先级：tiles > tileBlobs > urlTemplate', () => {
    const provider = new LocalXyzImageryProvider({
      tiles: new Map([['2/0/0', 'http://explicit/1/0/0.jpg']]),
      tileBlobs: new Map([['2/1/0', new Blob(['x'])]] as [string, Blob][]),
      urlTemplate: TEMPLATE,
      minLevel: 0,
      maxLevel: 18,
    });
    assert.strictEqual(provider.resolveTileUrl('2/0/0', { x: 0, y: 0, level: 2 }), 'http://explicit/1/0/0.jpg');
    assert.strictEqual(provider.resolveTileUrl('2/1/0', { x: 1, y: 0, level: 2 })?.startsWith('blob:'), true);
    assert.strictEqual(provider.resolveTileUrl('2/2/0', { x: 2, y: 0, level: 2 }), 'http://localhost:8090/2/2/0.jpg');
  });

  it('tileBlobs 懒加载仍按需建对象 URL（模板模式不改变 LRU 语义）', () => {
    const createSpy = mock.method(URL, 'createObjectURL', () => 'blob:lazy');
    try {
      const provider = new LocalXyzImageryProvider({
        tileBlobs: new Map([['0/0/0', new Blob(['x'])]] as [string, Blob][]),
        minLevel: 0,
        maxLevel: 1,
      });
      assert.strictEqual(createSpy.mock.calls.length, 0);
      provider.resolveTileUrl('0/0/0');
      assert.strictEqual(createSpy.mock.calls.length, 1);
      assert.strictEqual(provider.lazyObjectUrlCount, 1);
    } finally {
      createSpy.mock.restore();
    }
  });

  it('isTemplateXyzLayer：模板标记 / 兼容判定 / 非模板不误判', () => {
    assert.strictEqual(isTemplateXyzLayer(undefined), false);
    assert.strictEqual(isTemplateXyzLayer({ cacheKind: '3dtiles', files: [] }), false);
    // 有文件清单 → 不是模板模式
    assert.strictEqual(isTemplateXyzLayer({
        cacheKind: 'xyz',
        files: [{ path: '0/0/0.jpg', size: 1 }],
        detection: { xyzTemplate: '{z}/{x}/{y}.jpg' },
      }), false);
    // 兼容判定：模板存在 + 无文件清单（无 sourceMode）
    assert.strictEqual(isTemplateXyzLayer({ cacheKind: 'xyz', files: [], detection: { xyzTemplate: '{z}/{x}/{y}.jpg' } }), true);
  });
});
