/**
 * editor/core · localCache —— t37 CRS 集成单测
 *
 * 覆盖 proj4 CRS 在整条链路上的贯通与回归隔离：
 * 1. LocalXyzImageryProvider：metadata.crs 优先于 tilingMode（不回归内置快路径）；
 *    rectangle = bounds ∩ validBounds；
 * 2. rebuildXyzLayer：crs patch 写 metadata.crs 并移除 tilingMode（互斥）、crs=null 回退、
 *    JSON round-trip 后可再次重建（metadata 往返闭环）、非法 crs 失败不动旧图层；
 * 3. boundsFromTileKeys / estimateXyzScale 的 crs 分支（scale 此前漏传 crs，回归锁定）；
 * 4. importLocalXyzByTemplate 透传 crs → metadata.crs（tilingMode 不写）。
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MockInstance } from 'node:test';
import { Rectangle, WebMercatorTilingScheme } from 'cesium';

import type { LayerInfo, LayerManager, LayerSource } from '../LayerManager';
import { boundsFromTileKeys } from '../packages/xyz-cache/src/bounds';
import { findCrsEntry, resolveCrsInput } from '../packages/xyz-cache/src/crs-registry';
import { importLocalXyzByTemplate } from '../packages/xyz-cache/src/local-cache';
import { rebuildXyzLayer } from '../packages/xyz-cache/src/rebuild-xyz';
import { estimateXyzScale } from '../packages/xyz-cache/src/scale';
import type { LocalCacheMetadata, XyzLayerCrs } from './types';
import { LocalXyzImageryProvider } from '../packages/xyz-cache/src/xyz-cache';
import type { XyzTileImageLoader } from '../packages/xyz-cache/src/xyz-cache';

// ---------------------------------------------------------------------------
// 公共夹具
// ---------------------------------------------------------------------------

/** CGCS2000 3° 带 CM 114E（注册表条目展开，自包含） */
const CGCS4547: XyzLayerCrs = {
  kind: 'proj4',
  proj4: findCrsEntry('EPSG:4547')!.proj4,
  validBounds: [112.5, 0, 115.5, 84],
  id: 'EPSG:4547',
  label: findCrsEntry('EPSG:4547')!.label,
};

const baseMetadata = (extra: Record<string, unknown> = {}): LocalCacheMetadata =>
  ({
    cacheKind: 'xyz',
    files: [{ path: '1/0/0.jpg', size: 4 }],
    totalBytes: 4,
    rootDir: 'tiles',
    detection: { xyzTemplate: '{z}/{x}/{y}.jpg', xyzExt: 'jpg', maxLevel: 1, tileCount: 1 },
    ...extra,
  }) as LocalCacheMetadata;

const sourceOf = (metadata: LocalCacheMetadata): LayerSource =>
  ({ metadata: metadata as unknown as Record<string, unknown> });

const blobProvider = (): LocalXyzImageryProvider =>
  new LocalXyzImageryProvider({
    tileBlobs: new Map([['1/0/0', new Blob(['x'], { type: 'image/jpeg' })]]),
    minLevel: 0,
    maxLevel: 5,
  });

const info = (name = '缓存图层'): LayerInfo => ({
  id: 'layer-1',
  name,
  type: 'imagery',
  show: true,
  opacity: 0.8,
});

interface FakeHarness {
  manager: LayerManager;
  removedIds: string[];
  added: Array<{ name: string; provider: LocalXyzImageryProvider; source: Partial<LayerSource>; options: Record<string, unknown> }>;
}

const fakeManager = (
  layerInfo: LayerInfo,
  source: LayerSource,
  provider: LocalXyzImageryProvider,
): FakeHarness => {
  const removedIds: string[] = [];
  const added: FakeHarness['added'] = [];
  const manager = {
    get: (id: string) => (id === layerInfo.id ? layerInfo : undefined),
    getLayerSource: (id: string) => (id === layerInfo.id ? source : undefined),
    getImageryProvider: (id: string) => (id === layerInfo.id ? provider : undefined),
    remove: (id: string) => {
      removedIds.push(id);
    },
    addImageryLayerInstance: (
      name: string,
      nextProvider: LocalXyzImageryProvider,
      nextSource: Partial<LayerSource>,
      options: Record<string, unknown>,
    ): LayerInfo => {
      added.push({ name, provider: nextProvider, source: nextSource, options });
      return { ...layerInfo, name };
    },
  } as unknown as LayerManager;
  return { manager, removedIds, added };
};

// ---------------------------------------------------------------------------

describe('t37 · LocalXyzImageryProvider 的 crs 接入', () => {
  it('crs 优先于 tilingMode：给 crs 时切片方案为 proj4 网格（root=1），内置快路径不受影响', () => {
    const provider = new LocalXyzImageryProvider({
      tileBlobs: new Map([['0/0/0', new Blob(['x'])]]),
      minLevel: 0,
      maxLevel: 5,
      tilingMode: 'geographic', // 干扰项：geographic 内置方案 level 1 有 4 列
      crs: CGCS4547,
    });
    assert.strictEqual(provider.crs, CGCS4547);
    // proj4 square-2^z：level 0 → 1×1（geographic 内置是 2×1）
    assert.strictEqual(provider.tilingScheme.getNumberOfXTilesAtLevel(0), 1);
    assert.strictEqual(provider.tilingScheme.getNumberOfYTilesAtLevel(0), 1);
    assert.ok(!(provider.tilingScheme instanceof WebMercatorTilingScheme));

    // 回归：无 crs 时 tilingMode 内置方案照旧
    const builtin = new LocalXyzImageryProvider({
      tileBlobs: new Map([['0/0/0', new Blob(['x'])]]),
      minLevel: 0,
      maxLevel: 5,
      tilingMode: 'geographic',
    });
    assert.strictEqual(builtin.crs, undefined);
    assert.strictEqual(builtin.tilingScheme.getNumberOfXTilesAtLevel(0), 2);
  });

  it('rectangle：有 bounds 时 = bounds ∩ validBounds；无 bounds 时 = validBounds', () => {
    const withBounds = new LocalXyzImageryProvider({
      tileBlobs: new Map([['0/0/0', new Blob(['x'])]]),
      minLevel: 0,
      maxLevel: 5,
      crs: CGCS4547,
      bounds: [113, 10, 114, 20],
    });
    assert.strictEqual(Rectangle.equals(withBounds.rectangle, Rectangle.fromDegrees(113, 10, 114, 20)), true);

    const noBounds = new LocalXyzImageryProvider({
      tileBlobs: new Map([['0/0/0', new Blob(['x'])]]),
      minLevel: 0,
      maxLevel: 5,
      crs: CGCS4547,
    });
    assert.strictEqual(Rectangle.equals(noBounds.rectangle, Rectangle.fromDegrees(112.5, 0, 115.5, 84)), true);

    // bounds 与 validBounds 无交 → 回退 validBounds（rectangle 不为空）
    const disjoint = new LocalXyzImageryProvider({
      tileBlobs: new Map([['0/0/0', new Blob(['x'])]]),
      minLevel: 0,
      maxLevel: 5,
      crs: CGCS4547,
      bounds: [0, 0, 10, 10],
    });
    assert.strictEqual(Rectangle.equals(disjoint.rectangle, Rectangle.fromDegrees(112.5, 0, 115.5, 84)), true);
  });
});

describe('t37 · rebuildXyzLayer 的 crs 语义', () => {
  let createSpy: any;
  let revokeSpy: any;

  beforeEach(() => {
    createSpy = mock.method(URL, 'createObjectURL', () => `blob:mock/${createSpy.mock.calls.length}`);
    revokeSpy = mock.method(URL, 'revokeObjectURL', () => undefined);
  });
  afterEach(() => {
    createSpy.mock.restore();
    revokeSpy.mock.restore();
  });

  it('应用 crs：metadata.crs 写入、tilingMode 移除；provider 用 proj4 方案', async () => {
    const { manager, removedIds, added } = fakeManager(
      info(),
      sourceOf(baseMetadata({ tilingMode: 'web-mercator' })),
      blobProvider(),
    );

    const result = await rebuildXyzLayer(manager, 'layer-1', { crs: CGCS4547 });

    assert.strictEqual(result.crs?.id, 'EPSG:4547');
    assert.deepStrictEqual(removedIds, ['layer-1']);
    assert.strictEqual(added[0]!.provider.crs?.id, 'EPSG:4547');
    assert.strictEqual(added[0]!.provider.tilingScheme.getNumberOfXTilesAtLevel(0), 1);
    const nextMetadata = added[0]!.source.metadata as unknown as LocalCacheMetadata;
    assert.strictEqual(nextMetadata.crs?.kind, 'proj4');
    assert.strictEqual(nextMetadata.tilingMode, undefined);
  });

  it('crs=null：显式清除自定义 CRS，回退 tilingMode（缺省 web-mercator）', async () => {
    const { manager, added } = fakeManager(
      info(),
      sourceOf(baseMetadata({ crs: CGCS4547 })),
      new LocalXyzImageryProvider({
        tileBlobs: new Map([['0/0/0', new Blob(['x'])]]),
        minLevel: 0,
        maxLevel: 5,
        crs: CGCS4547,
      }),
    );
    const result = await rebuildXyzLayer(manager, 'layer-1', { crs: null });
    assert.strictEqual(result.crs, undefined);
    assert.strictEqual(result.tilingMode, 'web-mercator');
    const nextMetadata = added[0]!.source.metadata as unknown as LocalCacheMetadata;
    assert.strictEqual(nextMetadata.crs, undefined);
    assert.strictEqual(nextMetadata.tilingMode, 'web-mercator');
    assert.ok(added[0]!.provider.tilingScheme instanceof WebMercatorTilingScheme);
  });

  it('JSON round-trip：序列化后的 metadata.crs 可再次重建（自包含，不依赖注册表）', async () => {
    // 第一次重建得到带 crs 的 metadata
    const first = fakeManager(info(), sourceOf(baseMetadata({ tilingMode: 'web-mercator' })), blobProvider());
    await rebuildXyzLayer(first.manager, 'layer-1', { crs: CGCS4547 });
    const withCrs = first.added[0]!.source.metadata as unknown as LocalCacheMetadata;

    // 模拟场景保存/打开：JSON 往返
    const restored: unknown = JSON.parse(JSON.stringify(withCrs));

    // 第二次重建：不传 crs patch → 沿用 metadata.crs
    const second = fakeManager(
      info(),
      sourceOf(restored as LocalCacheMetadata),
      blobProvider(),
    );
    const result = await rebuildXyzLayer(second.manager, 'layer-1', {});
    assert.strictEqual(result.crs?.id, 'EPSG:4547');
    assert.strictEqual(result.crs?.proj4, CGCS4547.proj4);
    assert.deepStrictEqual(result.crs?.validBounds, CGCS4547.validBounds);
    assert.strictEqual(second.added[0]!.provider.tilingScheme.getNumberOfXTilesAtLevel(0), 1);
  });

  it('非法 crs → 可读错误，旧图层无损', async () => {
    const { manager, removedIds } = fakeManager(info(), sourceOf(baseMetadata()), blobProvider());
    await assert.rejects(rebuildXyzLayer(manager, 'layer-1', { crs: { kind: 'proj4', proj4: '乱码', validBounds: [0, 0, 1, 1] } as XyzLayerCrs }),);
    assert.deepStrictEqual(removedIds, []);
  });
});

describe('t37 · bounds / scale 的 crs 分支', () => {
  it('boundsFromTileKeys（crs）：CGCS 3° 带内一枚 z2 瓦片 → 反算范围落在 validBounds 内', () => {
    // level 2：网格 8×8，取靠近中央的瓦片 (4,3)
    const b = boundsFromTileKeys(['2/4/3'], { crs: CGCS4547 });
    assert.notStrictEqual(b, undefined);
    if (!b) return;
    assert.ok(b[0] >= (112.5 - 1e-6));
    assert.ok(b[2] <= (115.5 + 1e-6));
    assert.ok(b[1] >= (-1e-6));
    assert.ok(b[3] <= (84 + 1e-6));
    // 瓦片尺寸有限（不退化成全带）
    assert.ok(b[2] - b[0] < (1));
  });

  it('estimateXyzScale（crs）：满格计数 = Σ4^z（回归锁定：crs 必须真正参与估算）', () => {
    const est = estimateXyzScale({
      bounds: [112.5, 0, 115.5, 84],
      minZoom: 0,
      maxZoom: 2,
      crs: CGCS4547,
    });
    assert.deepStrictEqual(est.perLevel.map((l) => l.tiles), [1, 4, 16]);
    assert.strictEqual(est.totalTiles, 21);
    assert.strictEqual(est.empty, false);

    // 与 validBounds 无交 → 0
    const none = estimateXyzScale({
      bounds: [0, 0, 10, 10],
      minZoom: 0,
      maxZoom: 2,
      crs: CGCS4547,
    });
    assert.strictEqual(none.totalTiles, 0);
    assert.strictEqual(none.empty, true);
  });
});

describe('t37 · importLocalXyzByTemplate 透传 crs', () => {
  const fakeLayers = (): { manager: LayerManager; calls: Array<{ source: Partial<LayerSource>; provider: unknown }> } => {
    const calls: Array<{ source: Partial<LayerSource>; provider: unknown }> = [];
    const manager = {
      addImageryLayerInstance: (
        _name: string,
        provider: unknown,
        source: Partial<LayerSource> = {},
        _options: Record<string, unknown> = {},
      ): LayerInfo => {
        calls.push({ source, provider });
        return { id: `layer-${calls.length}`, name: _name, type: 'imagery', show: true, opacity: 1 };
      },
    } as unknown as LayerManager;
    return { manager, calls };
  };

  const loader: XyzTileImageLoader = async () => ({}) as unknown as never;

  it('给 crs 时：metadata.crs 写入、tilingMode 不写；provider 用 proj4 方案', async () => {
    const { manager, calls } = fakeLayers();
    const result = await importLocalXyzByTemplate(manager, {
      template: 'http://localhost:8090/{z}/{x}/{y}.jpg',
      minZoom: 0,
      maxZoom: 10,
      crs: CGCS4547,
      loadImage: loader,
    });
    assert.strictEqual(result.kind, 'xyz');
    assert.strictEqual(result.metadata.crs?.id, 'EPSG:4547');
    assert.strictEqual(result.metadata.tilingMode, undefined);
    const provider = calls[0]!.provider as LocalXyzImageryProvider;
    assert.strictEqual(provider.crs?.id, 'EPSG:4547');
    assert.strictEqual(provider.tilingScheme.getNumberOfXTilesAtLevel(0), 1);
  });

  it('不给 crs 时行为回归：metadata.tilingMode 照旧写入', async () => {
    const { manager, calls } = fakeLayers();
    const result = await importLocalXyzByTemplate(manager, {
      template: 'http://localhost:8090/{z}/{x}/{y}.jpg',
      minZoom: 0,
      maxZoom: 10,
      loadImage: loader,
    });
    assert.strictEqual(result.metadata.crs, undefined);
    assert.strictEqual(result.metadata.tilingMode, 'web-mercator');
    assert.ok(calls[0]!.provider instanceof LocalXyzImageryProvider);
  });
});

describe('t37 · resolveCrsInput 与注册表（链路入口冒烟）', () => {
  it('注册表条目展开 → crs 对象可直接进入 provider/rebuild 链路', () => {
    const r = resolveCrsInput({ proj4: 'EPSG:4544', validBounds: [104, 10, 106, 60] });
    assert.strictEqual(r.ok, true);
    if (!r.ok) return;
    assert.strictEqual(r.crs.proj4, findCrsEntry('EPSG:4544')!.proj4);
    assert.deepStrictEqual(r.crs.validBounds, [104, 10, 106, 60]);
    assert.ok(r.crs.label.includes('CGCS2000'));
  });
});
