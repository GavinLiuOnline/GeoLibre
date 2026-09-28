/**
 * editor/core · localCache/rebuildXyz 单测（t30）
 *
 * 覆盖「应用设置并重载」：坐标系切换 / TMS / 范围应用与清除、metadata 回写、
 * 图层 id/名称保持、失败时旧图层无损（先构建新 provider 再移除旧图层），
 * 以及非 XYZ 图层 / 非 LocalXyzImageryProvider 的可读错误。
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MockInstance } from 'node:test';
import { GeographicTilingScheme, Rectangle, WebMercatorTilingScheme } from 'cesium';

import type { LayerInfo, LayerManager, LayerSource } from '../LayerManager';
import type { LocalCacheMetadata } from './types';
import { LocalXyzImageryProvider } from '../packages/xyz-cache/src/xyz-cache';
import { rebuildXyzLayer } from '../packages/xyz-cache/src/rebuild-xyz';

// ---------------------------------------------------------------------------
// 假 LayerManager + 真实 LocalXyzImageryProvider
// ---------------------------------------------------------------------------

interface FakeHarness {
  manager: LayerManager;
  removedIds: string[];
  added: Array<{ name: string; provider: LocalXyzImageryProvider; source: Partial<LayerSource>; options: Record<string, unknown> }>;
}

const fakeManager = (
  info: LayerInfo,
  source: LayerSource,
  provider: LocalXyzImageryProvider,
): FakeHarness => {
  const removedIds: string[] = [];
  const added: FakeHarness['added'] = [];
  const manager = {
    get: (id: string) => (id === info.id ? info : undefined),
    getLayerSource: (id: string) => (id === info.id ? source : undefined),
    getImageryProvider: (id: string) => (id === info.id ? provider : undefined),
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
      return { ...info, name };
    },
  } as unknown as LayerManager;
  return { manager, removedIds, added };
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

/** 把 LocalCacheMetadata 适配成 LayerSource（LayerSource.metadata 是 Record<string, unknown>） */
const sourceOf = (metadata: LocalCacheMetadata): LayerSource =>
  ({ metadata: metadata as unknown as Record<string, unknown> });

const blobProvider = (tms = false): LocalXyzImageryProvider =>
  new LocalXyzImageryProvider({
    tileBlobs: new Map([['1/0/0', new Blob(['x'], { type: 'image/jpeg' })]]),
    minLevel: 0,
    maxLevel: 5,
    tms,
  });

const info = (name = '缓存图层'): LayerInfo => ({
  id: 'layer-1',
  name,
  type: 'imagery',
  show: true,
  opacity: 0.8,
});

describe('t30 · rebuildXyzLayer（应用设置并重载）', () => {
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

  it('切换坐标系：新 provider 用 GeographicTilingScheme，metadata 回写，id/名称保持', async () => {
    const metadata = baseMetadata({ tilingMode: 'web-mercator' });
    const provider = blobProvider();
    const { manager, removedIds, added } = fakeManager(info(), sourceOf(metadata), provider);

    const result = await rebuildXyzLayer(manager, 'layer-1', { tilingMode: 'geographic' });

    assert.strictEqual(result.tilingMode, 'geographic');
    assert.strictEqual(result.layer.id, 'layer-1');
    assert.strictEqual(result.layer.name, '缓存图层');
    assert.deepStrictEqual(removedIds, ['layer-1']);
    assert.strictEqual(added.length, (1));
    assert.strictEqual(added[0]!.options.id, 'layer-1');
    assert.ok(added[0]!.provider.tilingScheme instanceof GeographicTilingScheme);
    const nextMetadata = added[0]!.source.metadata as unknown as LocalCacheMetadata;
    assert.strictEqual(nextMetadata.tilingMode, 'geographic');
    // show / opacity 保留
    assert.strictEqual(added[0]!.options.show, true);
    assert.strictEqual(added[0]!.options.opacity, 0.8);
  });

  it('开启 TMS：新 provider.tms = true 并写回 metadata；缺省补丁保持原设置', async () => {
    const metadata = baseMetadata({ tms: false });
    const provider = blobProvider(false);
    const { manager, added } = fakeManager(info(), sourceOf(metadata), provider);

    await rebuildXyzLayer(manager, 'layer-1', { tms: true });
    assert.strictEqual(added[0]!.provider.tms, true);
    assert.strictEqual((added[0]!.source.metadata as unknown as LocalCacheMetadata).tms, true);

    // 缺省补丁：保持 metadata 现状（web-mercator + 非 TMS）
    const harness2 = fakeManager(info(), sourceOf(baseMetadata()), blobProvider());
    await rebuildXyzLayer(harness2.manager, 'layer-1', {});
    assert.strictEqual(harness2.added[0]!.provider.tms, false);
    assert.ok(harness2.added[0]!.provider.tilingScheme instanceof WebMercatorTilingScheme);
  });

  it('应用范围：bounds → provider.rectangle 与 metadata；null 清除范围回全球', async () => {
    const { manager, added } = fakeManager(info(), sourceOf(baseMetadata()), blobProvider());
    await rebuildXyzLayer(manager, 'layer-1', { bounds: [100, 20, 110, 40] });
    assert.strictEqual(Rectangle.equals(added[0]!.provider.rectangle, Rectangle.fromDegrees(100, 20, 110, 40)), true);
    assert.deepStrictEqual((added[0]!.source.metadata as unknown as LocalCacheMetadata).bounds, [100, 20, 110, 40]);

    // 清除：metadata.bounds 删除，rectangle 回退切片方案矩形
    const { manager: m2, added: a2 } = fakeManager(
      info(),
      sourceOf(baseMetadata({ bounds: [100, 20, 110, 40] })),
      blobProvider(),
    );
    await rebuildXyzLayer(m2, 'layer-1', { bounds: null });
    assert.strictEqual((a2[0]!.source.metadata as unknown as LocalCacheMetadata).bounds, undefined);
    assert.strictEqual(a2[0]!.provider.rectangle.equals(new WebMercatorTilingScheme().rectangle), true);
  });

  it('非法 bounds → 可读错误，且旧图层未被移除（先建新 provider 再移除）', async () => {
    const { manager, removedIds } = fakeManager(info(), sourceOf(baseMetadata()), blobProvider());
    await assert.rejects(rebuildXyzLayer(manager, 'layer-1', { bounds: [120, 0, 110, 10] }), /范围非法/,);
    assert.deepStrictEqual(removedIds, []);
  });

  it('非 XYZ 缓存图层 / 非 LocalXyzImageryProvider → 可读错误，不动图层', async () => {
    const harness = fakeManager(
      info(),
      sourceOf(baseMetadata({ cacheKind: '3dtiles' } as never)),
      blobProvider(),
    );
    await assert.rejects(rebuildXyzLayer(harness.manager, 'layer-1', {}), /不是 XYZ 缓存图层/);

    const harness2 = fakeManager(info(), sourceOf(baseMetadata()), {} as never);
    await assert.rejects(rebuildXyzLayer(harness2.manager, 'layer-1', {}), /不支持在线重建/,);
  });

  it('tileBlobs 数据来源在重建时原样继承（懒加载 URL 先释放再按需重建）', async () => {
    const provider = blobProvider();
    // 触发一次 requestImage 让懒加载 URL 建立，再 rebuild → 旧 provider 释放时 revoke 该 URL
    await provider.requestImage(0, 0, 1);
    assert.ok(provider.lazyObjectUrlCount > (0));
    const { manager, added } = fakeManager(info(), sourceOf(baseMetadata()), provider);
    await rebuildXyzLayer(manager, 'layer-1', { tms: true });
    // 旧 provider 被释放（tileBlobs 懒加载 URL revoke）；新 provider 继承同一 tileBlobs 映射
    assert.ok(revokeSpy.mock.calls.length > 0);
    assert.strictEqual(added[0]!.provider.tileBlobs, provider.tileBlobs);
  });
});
