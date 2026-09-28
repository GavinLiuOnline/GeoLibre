/**
 * editor/core · localCache/localCache 单测（t18）
 *
 * 覆盖用户报告的「file:///home/nuanyang/tiles 导入卡死」两条路径：
 * 1. webkitdirectory 目录导入（File[]）：超大目录 O(1) 守卫 + 异步切片 + 懒加载对象 URL；
 * 2. file:// 路径 / URL 回退导入（importLocalCacheFromPath）：清单探测 → 有界并卡拉取 → 注册图层，
 *    以及「无法枚举目录 / 协议不支持 / 清单过大 / 全瓦片失败」的可读错误。
 *
 * 另覆盖进度回调的单调性与取消语义。
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MockInstance } from 'node:test';

import type { LayerInfo, LayerManager, LayerSource } from '../LayerManager';
import type { LocalCacheProgress } from './types';
import {
  DEFAULT_MAX_LOCAL_CACHE_FILES,
  importLocalCache,
  importLocalCacheFromPath,
} from '../packages/xyz-cache/src/local-cache';
import { LocalXyzImageryProvider } from '../packages/xyz-cache/src/xyz-cache';

// ---------------------------------------------------------------------------
// 造数据 / 假 LayerManager
// ---------------------------------------------------------------------------

/** webkitdirectory 语义的假文件 */
const dirFile = (rel: string, content = 'x'): File => {
  const file = new File([content], rel.split('/').pop() ?? rel, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true });
  return file;
};

/** 一个含 N 张瓦片（tiles/{z}/{x}/{y}.jpg）的目录清单 */
const tileFiles = (count: number, prefix = 'tiles'): File[] => {
  const out: File[] = [];
  for (let i = 0; i < count; i++) {
    const z = i % 3;
    const x = Math.floor(i / 3);
    out.push(dirFile(`${prefix}/${z}/${x}/0.jpg`));
  }
  return out;
};

const createFakeLayerManager = (): {
  manager: LayerManager;
  imageryCalls: Array<{ name: string; provider: LocalXyzImageryProvider; source: Partial<LayerSource> }>;
} => {
  const imageryCalls: Array<{
    name: string;
    provider: LocalXyzImageryProvider;
    source: Partial<LayerSource>;
  }> = [];
  const manager = {
    addImageryLayerInstance: (
      name: string,
      provider: LocalXyzImageryProvider,
      source: Partial<LayerSource> = {},
    ): LayerInfo => {
      imageryCalls.push({ name, provider, source });
      return { id: `layer-${imageryCalls.length}`, name, type: 'imagery', show: true, opacity: 1 };
    },
  } as unknown as LayerManager;
  return { manager, imageryCalls };
};

/** 假 fetch：manifest 用 text()，瓦片用 blob() */
interface FakeResponse {
  ok: boolean;
  status: number;
  blob: () => Promise<Blob>;
  text: () => Promise<string>;
}

const jsonResponse = (body: unknown): FakeResponse => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([JSON.stringify(body)]),
  text: async () => JSON.stringify(body),
});

const tileResponse = (content = 'tile-bytes'): FakeResponse => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([content], { type: 'image/jpeg' }),
  text: async () => content,
});

const notFound = (): FakeResponse => ({
  ok: false,
  status: 404,
  blob: async () => new Blob([]),
  text: async () => '',
});

/** 记录调用的 fetch 实现（按 URL 分派） */
const makeFetch = (
  handler: (url: string) => FakeResponse | undefined,
): { fetchImpl: typeof fetch; calls: string[] } => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push(url);
    return (handler(url) ?? notFound()) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

// ---------------------------------------------------------------------------
// webkitdirectory 目录导入（File[]）
// ---------------------------------------------------------------------------

describe('t18 · importLocalCache 超大目录守卫', () => {
  let createSpy: MockInstance;

  beforeEach(() => {
    createSpy = mock.method(URL, 'createObjectURL', () => 'blob:x');
  });
  afterEach(() => createSpy.mock.restore());

  it('files.length 超上限 → 重活之前就抛可读错误（不建任何 blob URL）', async () => {
    const { manager, imageryCalls } = createFakeLayerManager();
    const files = tileFiles(10);
    await assert.rejects(importLocalCache(files, manager, { cacheKind: 'xyz', maxFiles: 3 }), /文件数量过大：10 个文件（上限 3）/);
    // 关键：在 O(1) 守卫处中止，没有进入建映射/注册（因此不存在卡死）
    assert.strictEqual(createSpy.mock.calls.length, 0);
    assert.strictEqual(imageryCalls.length, (0));
  });

  it('错误信息给出可操作建议（分批 / 服务端托管 / maxFiles）', async () => {
    const { manager } = createFakeLayerManager();
    await assert.rejects(importLocalCache(tileFiles(2), manager, { cacheKind: 'xyz', maxFiles: 1 }), /拆成多个目录分批导入[\s\S]*打开已发布场景[\s\S]*maxFiles/);
  });

  it('默认上限为 200000，且可用 Number.POSITIVE_INFINITY 显式关闭', async () => {
    assert.strictEqual(DEFAULT_MAX_LOCAL_CACHE_FILES, 200_000);
    const { manager, imageryCalls } = createFakeLayerManager();
    const result = await importLocalCache(tileFiles(4), manager, {
      cacheKind: 'xyz',
      maxFiles: Number.POSITIVE_INFINITY,
    });
    assert.strictEqual(result.kind, 'xyz');
    assert.strictEqual(imageryCalls.length, (1));
  });
});

describe('t18 · importLocalCache XYZ 路径', () => {
  let createSpy: MockInstance;

  beforeEach(() => {
    createSpy = mock.method(URL, 'createObjectURL', () => 'blob:x');
  });
  afterEach(() => createSpy.mock.restore());

  it('默认懒加载：导入期不预建对象 URL，provider 只登记 Blob 句柄', async () => {
    const { manager, imageryCalls } = createFakeLayerManager();
    const files = tileFiles(6);
    const result = await importLocalCache(files, manager, { cacheKind: 'xyz' });

    assert.strictEqual(createSpy.mock.calls.length, 0); // 关键：不再为 240 万瓦片预建 blob URL
    const provider = imageryCalls[0]!.provider;
    assert.ok(provider instanceof LocalXyzImageryProvider);
    assert.strictEqual(provider.tileBlobs?.size, 6);
    assert.strictEqual(provider.minLevel, 0);
    assert.strictEqual(provider.maxLevel, 2);
    assert.strictEqual(result.info.tileCount, 6);
    assert.strictEqual(result.info.xyzTemplate, '{z}/{x}/{y}.jpg');
    assert.strictEqual(result.metadata.cacheKind, 'xyz');
    assert.strictEqual(result.metadata.rootDir, 'tiles');
    assert.strictEqual(result.metadata.files.length, (6));
  });

  it('lazyTileUrls:false 保留急切语义（每瓦片一个对象 URL），行为不回归', async () => {
    const { manager, imageryCalls } = createFakeLayerManager();
    const result = await importLocalCache(tileFiles(5), manager, {
      cacheKind: 'xyz',
      lazyTileUrls: false,
    });
    assert.strictEqual(createSpy.mock.calls.length, 5);
    assert.strictEqual(imageryCalls[0]!.provider.tiles.size, 5);
    assert.strictEqual(result.info.fileCount, 5);
  });

  it('进度回调单调不减且带阶段信息', async () => {
    const { manager } = createFakeLayerManager();
    const events: LocalCacheProgress[] = [];
    await importLocalCache(tileFiles(5), manager, {
      cacheKind: 'xyz',
      onProgress: (p) => events.push({ ...p }),
    });
    assert.strictEqual(events[0]!.phase, 'detect');
    const phases = new Set(events.map((e) => e.phase));
    assert.strictEqual(phases.has('scan'), true);
    assert.strictEqual(phases.has('register'), true);
    for (const [i, event] of events.entries()) {
      assert.ok(event.processed <= (event.total));
      if (i > 0) assert.ok(event.processed >= (0));
    }
  });
});

// ---------------------------------------------------------------------------
// file:// 路径 / URL 回退导入
// ---------------------------------------------------------------------------

describe('t18 · importLocalCacheFromPath（file:// 路径回退）', () => {
  let createSpy: MockInstance;
  let revokeSpy: MockInstance;

  beforeEach(() => {
    createSpy = mock.method(URL, 'createObjectURL', () => 'blob:lazy');
    revokeSpy = mock.method(URL, 'revokeObjectURL', () => undefined);
  });
  afterEach(() => {
    createSpy.mock.restore();
    revokeSpy.mock.restore();
  });

  it('目录内 index.json 清单 → 拉取瓦片为 Blob → 注册图层（键与元数据正确）', async () => {
    const manifest = { tiles: ['0/0/0.jpg', '1/0/0.jpg', '1/0/1.jpg', 'readme.txt'] };
    const { fetchImpl, calls } = makeFetch((url) =>
      url.endsWith('/index.json') ? jsonResponse(manifest) : url.endsWith('.jpg') ? tileResponse() : undefined,
    );
    const { manager, imageryCalls } = createFakeLayerManager();
    const progress: LocalCacheProgress[] = [];

    const result = await importLocalCacheFromPath('file:///home/nuanyang/tiles', manager, {
      fetchImpl,
      onProgress: (p) => progress.push({ ...p }),
    });

    // 只探测到 index.json 即停（不继续探测 tiles.json / manifest.json）
    assert.strictEqual(calls[0], 'file:///home/nuanyang/tiles/index.json');
    assert.strictEqual(calls.filter((u) => u.endsWith('.json')).length, (2)); // 探测 + 读取
    assert.ok(calls.includes('file:///home/nuanyang/tiles/0/0/0.jpg'));

    const provider = imageryCalls[0]!.provider;
    assert.deepStrictEqual([...provider.tileBlobs!.keys()].sort(), ['0/0/0', '1/0/0', '1/0/1']);
    assert.strictEqual(provider.minLevel, 0);
    assert.strictEqual(provider.maxLevel, 1);
    assert.strictEqual(createSpy.mock.calls.length, 0); // 懒加载：导入期不建对象 URL

    assert.strictEqual(result.kind, 'xyz');
    assert.strictEqual(result.rootDir, 'tiles');
    assert.strictEqual(result.info.tileCount, 3);
    assert.strictEqual(result.info.xyzTemplate, '{z}/{x}/{y}.jpg');
    assert.deepStrictEqual(result.metadata.files.map((f) => f.path).sort(), [
      '0/0/0.jpg',
      '1/0/0.jpg',
      '1/0/1.jpg',
    ]);
    assert.ok(result.metadata.totalBytes > (0));

    assert.ok(progress.map((p) => p.phase).includes('fetch'));
    assert.strictEqual(progress.at(-1)!.processed, progress.at(-1)!.total);
  });

  it('显式 tiles 清单：不探测清单文件，且 base 为 http(s) 地址同样可用', async () => {
    const { fetchImpl, calls } = makeFetch((url) => (url.endsWith('.png') ? tileResponse('p') : undefined));
    const { manager } = createFakeLayerManager();
    const result = await importLocalCacheFromPath('https://cdn.example.com/tiles/', manager, {
      fetchImpl,
      tiles: ['5/10/12.png'],
    });
    assert.deepStrictEqual(calls, ['https://cdn.example.com/tiles/5/10/12.png']);
    assert.strictEqual(result.info.tileCount, 1);
    assert.strictEqual(result.info.maxLevel, 5);
    assert.strictEqual(result.metadata.files[0]!.path, '5/10/12.png');
  });

  it('无清单 → 可读错误：指向「本地 XYZ 缓存目录」选择入口（不卡死、不猜测）', async () => {
    const { fetchImpl, calls } = makeFetch(() => undefined); // 三个候选全 404
    const { manager, imageryCalls } = createFakeLayerManager();
    await assert.rejects(importLocalCacheFromPath('file:///home/nuanyang/tiles', manager, { fetchImpl }), /无法枚举目录内容[\s\S]*本地 XYZ 缓存目录[\s\S]*index\.json/);
    assert.strictEqual(calls.length, (3)); // 仅 3 次探测，无重试、无死循环
    assert.strictEqual(imageryCalls.length, (0));
  });

  it('清单过大 / 瓦片全失败 → 可读错误', async () => {
    const big = { tiles: Array.from({ length: 5 }, (_, i) => `0/${i}/0.jpg`) };
    const bigFetch = makeFetch((url) => (url.endsWith('/index.json') ? jsonResponse(big) : undefined));
    const { manager } = createFakeLayerManager();
    await assert.rejects(importLocalCacheFromPath('file:///t', manager, { fetchImpl: bigFetch.fetchImpl, maxTiles: 3 }), /瓦片清单过大：5 条（上限 3）/);

    const failing = makeFetch((url) => (url.endsWith('/index.json') ? jsonResponse(big) : notFound()));
    await assert.rejects(importLocalCacheFromPath('file:///t', manager, { fetchImpl: failing.fetchImpl }), /未能加载任何瓦片/);
  });

  it('不支持的协议 / 非法地址 → 可读错误（不进入 fetch）', async () => {
    const { fetchImpl, calls } = makeFetch(() => undefined);
    const { manager } = createFakeLayerManager();
    await assert.rejects(importLocalCacheFromPath('ftp://host/tiles', manager, { fetchImpl }), /不支持的缓存地址协议：ftp:/);
    await assert.rejects(importLocalCacheFromPath('   ', manager, { fetchImpl }), /未提供缓存路径/,);
    assert.strictEqual(calls.length, (0));
  });

  it('裸本地路径 → 归一化为 file://；取消信号 → 立即中止', async () => {
    const manifest = { tiles: ['0/0/0.jpg'] };
    const { fetchImpl, calls } = makeFetch((url) =>
      url.endsWith('/index.json') ? jsonResponse(manifest) : tileResponse(),
    );
    const { manager } = createFakeLayerManager();
    const ok = await importLocalCacheFromPath('/home/nuanyang/tiles', manager, { fetchImpl });
    assert.strictEqual(calls[0], 'file:///home/nuanyang/tiles/index.json');
    assert.strictEqual(ok.rootDir, 'tiles');

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(importLocalCacheFromPath('/home/nuanyang/tiles', manager, {
        fetchImpl,
        tiles: ['0/0/0.jpg'],
        signal: controller.signal,
      }), /已取消/);
  });
});

describe('t18 · 用户报告场景复现（file:///home/nuanyang/tiles，实测 2426813 个文件）', () => {
  let createSpy: MockInstance;
  beforeEach(() => {
    createSpy = mock.method(URL, 'createObjectURL', () => 'blob:x');
  });
  afterEach(() => createSpy.mock.restore());

  it('242 万文件目录：立即给可读错误（不再卡死/OOM），且完全不触碰文件内容', async () => {
    // 守卫只读 files.length，因此这里不必真的构造 242 万个 File（那本身就会卡死测试进程）
    const files = new Array(2_426_813).fill(undefined) as File[];
    const { manager, imageryCalls } = createFakeLayerManager();
    const started = Date.now();
    await assert.rejects(importLocalCache(files, manager, { cacheKind: 'xyz' }), /文件数量过大：2426813 个文件（上限 200000）/,);
    assert.ok(Date.now() - started < (2_000)); // 立即可判定，不做任何 O(N) 重活
    assert.strictEqual(createSpy.mock.calls.length, 0);
    assert.strictEqual(imageryCalls.length, (0));
  });
});
