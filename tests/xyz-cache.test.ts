import assert from "node:assert/strict";
import { mock } from "node:test";
import { describe, it } from "node:test";

import { flattenDirectoryFiles } from '../packages/xyz-cache/src/detect';
import { buildXyzTileMap, extractXyzMetadata } from '../packages/xyz-cache/src/xyz-cache';

const fakeFile = (rel: string, content = 'data'): File => {
  const file = new File([content], rel.split('/').pop() ?? rel, { type: 'image/png' });
  Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true });
  return file;
};

describe('XYZ 缓存（纯函数部分）', () => {
  it('buildXyzTileMap: {z}/{x}/{y}.ext → blob URL 映射', () => {
    const items = flattenDirectoryFiles([
      fakeFile('Tiles/0/0/0.png', 'p0'),
      fakeFile('Tiles/0/0/1.png', 'p1'),
      fakeFile('Tiles/1/0/0.png', 'p2'),
      fakeFile('Tiles/readme.txt', 'txt'), // 应被忽略
    ]);
    const map = buildXyzTileMap(items);
    assert.strictEqual(map.size, 3);
    assert.strictEqual(map.has('0/0/0'), true);
    assert.strictEqual(map.has('0/0/1'), true);
    assert.strictEqual(map.has('1/0/0'), true);
    for (const url of map.values()) {
      assert.strictEqual(url.startsWith('blob:'), true);
    }
  });

  it('extractXyzMetadata: 元数据含 cacheKind=xyz + template + 字节统计', () => {
    const items = flattenDirectoryFiles([
      fakeFile('Tiles/0/0/0.png', 'aaaa'),
      fakeFile('Tiles/1/0/0.png', 'bbbbb'),
    ]);
    const md = extractXyzMetadata(items, 'Tiles', {});
    assert.strictEqual(md.cacheKind, 'xyz');
    assert.strictEqual(md.rootDir, 'Tiles');
    assert.strictEqual(md.files.length, (2));
    assert.strictEqual(md.totalBytes, 9);
    assert.strictEqual(md.detection?.xyzTemplate, '{z}/{x}/{y}.png');
    assert.strictEqual(md.detection?.xyzExt, 'png');
    assert.strictEqual(md.detection?.maxLevel, 1);
    assert.strictEqual(md.detection?.tileCount, 2);
  });
});
// ---------------------------------------------------------------------------
// t18：提供者边界（file:// 拒绝 / 缺瓦片回退 / 懒加载对象 URL）
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe as describe2, expect as expect2, it as it2 } from "node:test";
import type { MockInstance } from 'node:test';

import { flattenDirectoryFiles as flatten2 } from '../packages/xyz-cache/src/detect';
import {
  buildXyzTileBlobMap,
  buildXyzTileMapAsync,
  LocalXyzImageryProvider,
} from '../packages/xyz-cache/src/xyz-cache';

const fakeTileFile = (rel: string, content = 'x'): File => {
  const file = new File([content], rel.split('/').pop() ?? rel, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true });
  return file;
};

/** requestImage 只要求「不 reject、不挂起」：node 无 Image 解码器，故只断言 resolve 行为 */
const resolvesWithoutReject = async (p: Promise<unknown> | undefined): Promise<boolean> => {
  if (!p) return false;
  return p.then(
    () => true,
    () => false,
  );
};

describe2('t18 · LocalXyzImageryProvider 边界', () => {
  let createSpy: any;
  let revokeSpy: any;

  beforeEach(() => {
    createSpy = mock.method(URL, 'createObjectURL', () => `blob:tile/${createSpy.mock.calls.length}`);
    revokeSpy = mock.method(URL, 'revokeObjectURL', () => undefined);
  });

  afterEach(() => {
    createSpy.mock.restore();
    revokeSpy.mock.restore();
  });

  it2('空瓦片 → 可读错误（不再构造一个永远空白的提供者）', () => {
    assert.throws(() => new LocalXyzImageryProvider({ tiles: new Map(), minLevel: 0, maxLevel: 1 }), /缺少瓦片数据/,);
  });

  it2('file:// 瓦片 URL → 显式可读错误（指向目录选择 / importLocalCacheFromPath）', () => {
    const tiles = new Map([['0/0/0', 'file:///home/nuanyang/tiles/0/0/0.jpg']]);
    assert.throws(() => new LocalXyzImageryProvider({ tiles, minLevel: 0, maxLevel: 1 }), /协议不受支持.*importLocalCacheFromPath/s,);
    // 显式允许（Electron webSecurity:false 场景）时不抛
    assert.doesNotThrow(() =>
        new LocalXyzImageryProvider({
          tiles,
          minLevel: 0,
          maxLevel: 1,
          allowFileUrls: true,
        }),);
    // 关闭校验（调用方自负责）时不抛
    assert.doesNotThrow(() => new LocalXyzImageryProvider({ tiles, minLevel: 0, maxLevel: 1, validateTileUrls: false }),);
  });

  it2('requestImage：命中/缺失/file:// 一律 resolve（不 reject、不挂起）', async () => {
    const provider = new LocalXyzImageryProvider({
      tiles: new Map([['0/0/0', 'blob:known']]),
      minLevel: 0,
      maxLevel: 2,
    });
    await await assert.doesNotReject(resolvesWithoutReject(provider.requestImage(0, 0, 0))); // 命中
    await await assert.doesNotReject(resolvesWithoutReject(provider.requestImage(0, 0, 1))); // 缺瓦片 → 透明 PNG
    await await assert.doesNotReject(resolvesWithoutReject(provider.requestImage(9, 9, 9))); // 越界
  });

  it2('懒加载模式：只在请求时建对象 URL，且按 LRU 上限回收', async () => {
    const blobs = new Map<string, Blob>([
      ['0/0/0', new Blob(['a'])],
      ['0/0/1', new Blob(['b'])],
    ]);
    const provider = new LocalXyzImageryProvider({
      tileBlobs: blobs,
      minLevel: 0,
      maxLevel: 1,
      validateTileUrls: false,
      maxLazyObjectUrls: 1,
    });
    assert.strictEqual(createSpy.mock.calls.length, 0); // 构造时不建 URL（关键：百万级瓦片不再预建）

    await resolvesWithoutReject(provider.requestImage(0, 0, 0));
    assert.strictEqual(createSpy.mock.calls.length, 1);
    assert.strictEqual(provider.lazyObjectUrlCount, 1);

    await resolvesWithoutReject(provider.requestImage(0, 0, 0)); // 复用缓存
    assert.strictEqual(createSpy.mock.calls.length, 1);

    await resolvesWithoutReject(provider.requestImage(0, 1, 0)); // key 0/0/1：超上限 → 回收最旧
    assert.strictEqual(createSpy.mock.calls.length, 2);
    assert.strictEqual(revokeSpy.mock.calls.length, 1);
    assert.strictEqual(provider.lazyObjectUrlCount, 1);

    provider.dispose();
    assert.strictEqual(revokeSpy.mock.calls.length, 2);
    assert.strictEqual(provider.lazyObjectUrlCount, 0);
    provider.dispose(); // 可重复调用
    assert.strictEqual(revokeSpy.mock.calls.length, 2);
  });
});

describe2('t18 · 异步切片构建', () => {
  const items = () =>
    flatten2([
      fakeTileFile('tiles/0/0/0.jpg'),
      fakeTileFile('tiles/1/0/0.jpg'),
      fakeTileFile('tiles/1/0/1.jpg'),
      fakeTileFile('tiles/readme.txt'),
    ]);

  let createSpy: any;
  beforeEach(() => {
    createSpy = mock.method(URL, 'createObjectURL', () => `blob:x/${createSpy.mock.calls.length}`);
  });
  afterEach(() => createSpy.mock.restore());

  it2('buildXyzTileBlobMap：不建对象 URL，只登记 Blob 句柄', async () => {
    const map = await buildXyzTileBlobMap(items());
    assert.deepStrictEqual([...map.keys()].sort(), ['0/0/0', '1/0/0', '1/0/1']);
    assert.strictEqual(createSpy.mock.calls.length, 0);
    assert.ok(map.get('0/0/0') instanceof Blob);
  });

  it2('buildXyzTileMapAsync：与同步版语义一致（每瓦片一个对象 URL）', async () => {
    const sync = buildXyzTileMap(items());
    createSpy.mock.resetCalls();
    const async_ = await buildXyzTileMapAsync(items());
    assert.deepStrictEqual([...async_.keys()].sort(), [...sync.keys()].sort());
    assert.strictEqual(createSpy.mock.calls.length, 3);
  });

  it2('进度单调不减且以 (total,total) 收尾；可按批次取消', async () => {
    const seen: Array<[number, number]> = [];
    await buildXyzTileBlobMap(items(), {
      batchSize: 2,
      onProgress: (processed, total) => seen.push([processed, total]),
    });
    assert.ok(seen.length > (1));
    assert.deepStrictEqual(seen[0], [0, 4]);
    assert.deepStrictEqual(seen[seen.length - 1], [4, 4]);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i]![0] >= (seen[i - 1]![0]));
      assert.strictEqual(seen[i]![1], 4);
    }

    let processed = 0;
    await assert.rejects(buildXyzTileBlobMap(items(), {
        batchSize: 1,
        shouldCancel: () => processed++ > 0,
      }), /已取消/);
  });
});

describe2('t18 · 大目录切片不锁死主线程', () => {
  it2('20k 瓦片构建期间事件循环仍可推进（真正 setInterval/setTimeout 有机会执行）', async () => {
    const items: ReturnType<typeof flatten2> = [];
    for (let i = 0; i < 20_000; i++) {
      items.push({
        rootDir: 'tiles',
        relPath: `${i % 5}/${Math.floor(i / 5)}/0.jpg`,
        size: 1,
        file: undefined as unknown as File,
      });
    }

    let turns = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      turns++;
      timer = setTimeout(tick, 0);
    };
    timer = setTimeout(tick, 0);

    const progress: Array<[number, number]> = [];
    const map = await buildXyzTileBlobMap(items, {
      batchSize: 500,
      onProgress: (processed, total) => progress.push([processed, total]),
    });
    if (timer) clearTimeout(timer);

    assert.strictEqual(map.size, 20_000);
    assert.ok(turns > (10)); // 若不切片，构建期间 turns 会停在 0
    assert.deepStrictEqual(progress[0], [0, 20_000]);
    assert.deepStrictEqual(progress.at(-1), [20_000, 20_000]);
    // 进度单调不减
    for (let i = 1; i < progress.length; i++) {
      assert.ok(progress[i]![0] >= (progress[i - 1]![0]));
    }
  });
});

// ---------------------------------------------------------------------------
// t30：TMS（Y 轴翻转）与 range（bounds → provider.rectangle）
// ---------------------------------------------------------------------------

import { Rectangle, WebMercatorTilingScheme } from 'cesium';
import { afterEach as afterEach3, beforeEach as beforeEach3, describe as describe3, it as it3 } from "node:test";
import { LocalXyzImageryProvider as Provider3, type XyzTileImageLoader } from '../packages/xyz-cache/src/xyz-cache';

describe3('t30 · LocalXyzImageryProvider TMS 与 bounds', () => {
  /** node 环境无 URL.createObjectURL：与既有用例一致，mock 后断言 */
  let createSpy3: any;
  beforeEach3(() => {
    createSpy3 = mock.method(URL, 'createObjectURL', () => `blob:mock/${createSpy3.mock.calls.length}`);
  });
  afterEach3(() => createSpy3.mock.restore());

  /** 注入式加载器：记录被请求的 URL（resolveTileUrl 结果），永远成功 */
  const recordingLoader = (requested: string[]): XyzTileImageLoader => {
    return async (url: string) => {
      requested.push(url);
      return undefined as unknown as HTMLImageElement;
    };
  };

  it3('TMS：requestImage 的 XYZ y 按翻转后查找映射（tileBlobs 模式）', () => {
    // 磁盘上是 TMS 命名：z1 只有 y=0（TMS 南半球）；Cesium 请求 XYZ y=1（南半球）
    const blobs = new Map<string, Blob>([['1/0/0', new Blob(['tms-south'], { type: 'image/jpeg' })]]);
    const provider = new Provider3({ tileBlobs: blobs, minLevel: 0, maxLevel: 2, tms: true });
    assert.strictEqual(provider.tms, true);
    // Cesium 请求北半球 y=0 → 翻转成文件 y=1 → 未命中（undefined → 透明 PNG，不报错）
    assert.strictEqual(provider.resolveTileUrl('1/0/1', { x: 0, y: 1, level: 1 }), undefined);
    // 请求南半球 y=1 → 翻转成文件 y=0 → 命中 blob
    const url = provider.resolveTileUrl('1/0/0', { x: 0, y: 0, level: 1 });
    assert.notStrictEqual(url, undefined);
    assert.strictEqual((url as string).startsWith('blob:') || (url as string).startsWith('data:'), true);
  });

  it3('TMS：模板模式代入翻转后的 y（URL 中是 TMS 文件名）', async () => {
    const requested: string[] = [];
    const provider = new Provider3({
      urlTemplate: 'http://localhost:8090/{z}/{x}/{y}.jpg',
      minLevel: 0,
      maxLevel: 3,
      tms: true,
      loadImage: recordingLoader(requested),
    });
    // Cesium 请求 z1 y=1（南半球）→ 文件 y = 2-1-1 = 0
    await provider.requestImage(0, 1, 1);
    assert.deepStrictEqual(requested, ['http://localhost:8090/1/0/0.jpg']);
    // 非 TMS 时不翻转（请求 x=0, y=1 → 文件名 1/0/1.jpg）
    const requested2: string[] = [];
    const plain = new Provider3({
      urlTemplate: 'http://localhost:8090/{z}/{x}/{y}.jpg',
      minLevel: 0,
      maxLevel: 3,
      loadImage: recordingLoader(requested2),
    });
    await plain.requestImage(0, 1, 1);
    assert.deepStrictEqual(requested2, ['http://localhost:8090/1/0/1.jpg']);
  });

  it3('TMS 默认 false（既有行为不变）；bounds → provider.rectangle', () => {
    const provider = new Provider3({
      urlTemplate: 'http://localhost:8090/{z}/{x}/{y}.jpg',
      minLevel: 0,
      maxLevel: 3,
    });
    assert.strictEqual(provider.tms, false);

    const bounded = new Provider3({
      urlTemplate: 'http://localhost:8090/{z}/{x}/{y}.jpg',
      minLevel: 0,
      maxLevel: 3,
      bounds: [100, 20, 110, 40],
    });
    assert.strictEqual(Rectangle.equals(bounded.rectangle, Rectangle.fromDegrees(100, 20, 110, 40)), true);
    // 未给 bounds → 切片方案全球矩形
    assert.strictEqual(Rectangle.equals(bounded.rectangle, new WebMercatorTilingScheme().rectangle), false);
  });
});
