/**
 * t29：本地缓存导出（ZIP 下载 / Electron 原生另存为）单测。
 *
 * 覆盖：ZIP 结构与 metadata.files[].path 逐字一致、模板/缺文件/超限/未登记四类可读错误、
 * 文件名规则、进度单调、downloadBlob 对象 URL 释放、saveBlobAs 的 Electron 分支与回退。
 */
import JSZip from 'jszip';
import assert from "node:assert/strict";
import { mock } from "node:test";
import { describe, it } from "node:test";

import {
  EXPORT_MAX_BYTES,
  EXPORT_MAX_FILES,
  ExportCacheError,
  TEMPLATE_LAYER_EXPORT_HINT,
  assertExportWithinLimits,
  buildZipBlob,
  describeExportProgress,
  downloadBlob,
  exportCacheFilename,
  exportCacheLayer,
  exportCacheToDisk,
  formatExportTimestamp,
  resolveDesktopBridge,
  sanitizeExportFilename,
  sanitizeFileBase,
  saveBlobAs,
  type ExportCacheProgress,
  type SaveBlobResult,
} from '../packages/xyz-cache/src/export-cache';
import type { LocalCacheMetadata } from './types';

const FIXED_NOW = new Date(2024, 0, 2, 3, 4, 5); // 20240102-030405（本地时间）

function xyzMetadata(): LocalCacheMetadata {
  return {
    cacheKind: 'xyz',
    files: [
      { path: '0/0/0.png', size: 4 },
      { path: '1/0/0.png', size: 5 },
      { path: '1/1/0.png', size: 6 },
    ],
    totalBytes: 15,
    rootDir: 'region-cache',
    cacheSource: 'generated',
    detection: { xyzTemplate: '{z}/{x}/{y}.png', xyzExt: 'png', maxLevel: 1, tileCount: 3 },
  };
}

function xyzFiles(): Map<string, Blob> {
  return new Map<string, Blob>([
    ['0/0/0.png', new Blob(['aaaa'])],
    ['1/0/0.png', new Blob(['bbbbb'])],
    ['1/1/0.png', new Blob(['cccccc'])],
  ]);
}

function tilesetMetadata(): LocalCacheMetadata {
  return {
    cacheKind: '3dtiles',
    files: [
      { path: 'tileset.json', size: 10 },
      { path: 'model.glb', size: 7 },
      { path: 'Tiles/0/0/0.b3dm', size: 3 },
    ],
    totalBytes: 20,
    rootDir: 'model-cache',
    cacheSource: 'generated',
  };
}

function tilesetFiles(): Map<string, Blob> {
  return new Map<string, Blob>([
    ['tileset.json', new Blob(['{"asset":{}}'])],
    ['model.glb', new Blob(['glbglbg'])],
    ['Tiles/0/0/0.b3dm', new Blob(['b3d'])],
  ]);
}

async function zipNames(blob: Blob): Promise<string[]> {
  const inner = await new JSZip().loadAsync(await blob.arrayBuffer());
  return Object.keys(inner.files).sort();
}

describe('t29 exportCache · exportCacheLayer', () => {
  it('XYZ 生成缓存：ZIP 内路径与 metadata.files[].path 逐字一致', async () => {
    const result = await exportCacheLayer('layer-1', {
      registry: xyzFiles,
      metadata: xyzMetadata(),
      layerName: '框选区域 XYZ 缓存',
      now: FIXED_NOW,
    });

    assert.strictEqual(result.fileCount, 3);
    assert.strictEqual(result.totalBytes, 15);
    assert.strictEqual(result.kind, 'xyz');
    assert.strictEqual(result.rootDir, 'region-cache');
    assert.strictEqual(result.filename, '框选区域 XYZ 缓存-20240102-030405.zip');
    assert.ok(result.blob instanceof Blob);
    assert.ok(result.zipBytes > (0));

    const inner = await new JSZip().loadAsync(await result.blob.arrayBuffer());
    // 逐字一致 + 无目录条目（createFolders:false）
    assert.deepStrictEqual(Object.keys(inner.files).sort(), ['0/0/0.png', '1/0/0.png', '1/1/0.png']);
    assert.deepStrictEqual(Object.values(inner.files).filter((f) => f.dir), []);
    assert.strictEqual(await inner.file('1/1/0.png')?.async('string'), 'cccccc');
  });

  it('3D Tiles 缓存：tileset.json + 模型/瓦片文件路径保持（可与服务端发布包同构复用）', async () => {
    const result = await exportCacheLayer('layer-3d', {
      registry: tilesetFiles(),
      metadata: tilesetMetadata(),
      layerName: '建筑模型 3D Tiles 缓存',
      now: FIXED_NOW,
    });

    assert.strictEqual(result.fileCount, 3);
    assert.strictEqual(result.kind, '3dtiles');
    assert.deepStrictEqual(await zipNames(result.blob), ['Tiles/0/0/0.b3dm', 'model.glb', 'tileset.json']);
  });

  it('metadata 无文件清单（非模板）时退化为以会话登记表的 key 为路径', async () => {
    const result = await exportCacheLayer('layer-x', {
      registry: new Map<string, Blob>([['tileset.json', new Blob(['{}'])]]),
      metadata: { cacheKind: '3dtiles', files: [], totalBytes: 0, rootDir: '' },
      layerName: '无清单图层',
      now: FIXED_NOW,
    });
    assert.strictEqual(result.fileCount, 1);
    assert.deepStrictEqual(await zipNames(result.blob), ['tileset.json']);
  });

  it('清单中的文件在会话登记表缺失 → missing-files（不导出残缺包）', async () => {
    const files = xyzFiles();
    files.delete('1/1/0.png');
    await assert.rejects(exportCacheLayer('layer-1', { registry: files, metadata: xyzMetadata(), layerName: 'A' }), {
      name: 'ExportCacheError',
      code: 'missing-files',
    });
  });

  it('模板按需加载图层（t25）→ template + 可读引导（改用服务端托管 / 清单导入）', async () => {
    const metadata: LocalCacheMetadata = {
      cacheKind: 'xyz',
      files: [],
      totalBytes: 0,
      rootDir: '',
      detection: { xyzTemplate: 'http://localhost:8090/{z}/{x}/{y}.jpg', sourceMode: 'template' },
    };
    const error = await exportCacheLayer('layer-tpl', {
      registry: xyzFiles(),
      metadata,
      layerName: '按需加载',
    }).catch((err: unknown) => err);
    assert.ok(error instanceof ExportCacheError);
    assert.strictEqual((error as ExportCacheError).code, 'template');
    assert.strictEqual((error as ExportCacheError).message, TEMPLATE_LAYER_EXPORT_HINT);
  });

  it('本会话未登记内容 → unavailable（提示重新导入/重新生成）', async () => {
    await assert.rejects(exportCacheLayer('layer-1', { registry: new Map(), metadata: xyzMetadata(), layerName: 'A' }), { code: 'unavailable' });
    await assert.rejects(exportCacheLayer('layer-1', { metadata: xyzMetadata(), layerName: 'A' }), { code: 'unavailable' });
  });

  it('大缓存保护：文件数 / 字节超阈值 → too-large + 服务端托管引导', async () => {
    const error = await exportCacheLayer('layer-1', {
      registry: xyzFiles(),
      metadata: xyzMetadata(),
      layerName: '大缓存',
      limits: { maxFiles: 2 },
    }).catch((err: unknown) => err);
    assert.ok(error instanceof ExportCacheError);
    assert.strictEqual((error as ExportCacheError).code, 'too-large');
    assert.ok((error as ExportCacheError).message.includes('服务端'));
    assert.ok((error as ExportCacheError).message.includes('上限'));

    // 字节上限同样生效（打包前即可判定）
    await assert.rejects(exportCacheLayer('layer-1', {
        registry: xyzFiles(),
        metadata: xyzMetadata(),
        limits: { maxBytes: 10 },
      }), { code: 'too-large' });
  });

  it('assertExportWithinLimits：默认阈值与显式覆盖', () => {
    assert.doesNotThrow(() => assertExportWithinLimits(EXPORT_MAX_FILES, EXPORT_MAX_BYTES, undefined));
    assert.throws(() => assertExportWithinLimits(EXPORT_MAX_FILES + 1, 0, undefined), ExportCacheError);
    assert.throws(() => assertExportWithinLimits(0, EXPORT_MAX_BYTES + 1, undefined), ExportCacheError);
    assert.doesNotThrow(() =>
      assertExportWithinLimits(1_000_000, 0, { maxFiles: Number.POSITIVE_INFINITY }),);
  });

  it('进度单调且阶段为 collect → zip（ratio 0~1）', async () => {
    const seen: ExportCacheProgress[] = [];
    await exportCacheLayer('layer-1', {
      registry: xyzFiles(),
      metadata: xyzMetadata(),
      layerName: 'A',
      now: FIXED_NOW,
      onProgress: (p) => seen.push(p),
    });
    assert.ok(seen.length >= (2));
    assert.strictEqual(seen[0]?.phase, 'collect');
    assert.strictEqual(seen.some((p) => p.phase === 'zip'), true);
    for (const p of seen) {
      assert.ok(p.ratio >= (0));
      assert.ok(p.ratio <= (1));
      assert.ok(p.processed <= (p.total));
      assert.strictEqual(p.total, 3);
    }
    const ratios = seen.map((p) => p.ratio);
    assert.deepStrictEqual([...ratios].sort((a, b) => a - b), ratios);
  });

  it('进度回调抛异常不影响导出', async () => {
    const result = await exportCacheLayer('layer-1', {
      registry: xyzFiles(),
      metadata: xyzMetadata(),
      onProgress: () => {
        throw new Error('boom');
      },
    });
    assert.strictEqual(result.fileCount, 3);
  });
});

describe('t29 exportCache · 文件名', () => {
  it('formatExportTimestamp 为 yyyyMMdd-HHmmss', () => {
    assert.strictEqual(formatExportTimestamp(FIXED_NOW), '20240102-030405');
  });

  it('exportCacheFilename：<图层名>-<时间戳>.zip，并做安全化', () => {
    assert.strictEqual(exportCacheFilename('建筑模型', FIXED_NOW), '建筑模型-20240102-030405.zip');
    assert.strictEqual(exportCacheFilename('a/b:c*d?"e<f>g|h', FIXED_NOW), 'a-b-c-d-e-f-g-h-20240102-030405.zip');
    assert.strictEqual(exportCacheFilename('   ', FIXED_NOW), '缓存-20240102-030405.zip');
  });

  it('sanitizeFileBase / sanitizeExportFilename：去目录段、补 .zip', () => {
    assert.strictEqual(sanitizeFileBase('x/y\\z'), 'x-y-z');
    assert.strictEqual(sanitizeFileBase('...name...'), 'name');
    assert.strictEqual(sanitizeExportFilename('/tmp/out/我的缓存'), '我的缓存.zip');
    assert.strictEqual(sanitizeExportFilename('cache.ZIP'), 'cache.ZIP');
  });

  it('显式 filename 覆盖默认命名', async () => {
    const result = await exportCacheLayer('layer-1', {
      registry: xyzFiles(),
      metadata: xyzMetadata(),
      filename: 'custom.zip',
    });
    assert.strictEqual(result.filename, 'custom.zip');
  });
});

describe('t29 exportCache · downloadBlob / saveBlobAs', () => {
  function fakeDocument(): { doc: Document; anchor: Record<string, unknown> } {
    const anchor: Record<string, unknown> = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      clicks: 0,
      click(this: { clicks: number }) {
        this.clicks++;
      },
    };
    const doc = {
      createElement: () => anchor,
      body: { appendChild: () => undefined, removeChild: () => undefined },
    } as unknown as Document;
    return { doc, anchor };
  }

  it('downloadBlob：<a download> + createObjectURL，用后 revoke', () => {
    const { doc, anchor } = fakeDocument();
    const revoked: string[] = [];
    const objectUrl = downloadBlob(new Blob(['x']), 'a.zip', {
      document: doc,
      url: { createObjectURL: () => 'blob:fake-1', revokeObjectURL: (u) => revoked.push(u) },
      revokeDelayMs: 0,
    });
    assert.strictEqual(objectUrl, 'blob:fake-1');
    assert.strictEqual(anchor.href, 'blob:fake-1');
    assert.strictEqual(anchor.download, 'a.zip');
    assert.strictEqual(anchor.clicks, 1);
    assert.deepStrictEqual(revoked, ['blob:fake-1']);
  });

  it('downloadBlob：缺 DOM / createObjectURL → unsupported 可读错误', () => {
    assert.throws(() => downloadBlob(new Blob(['x']), 'a.zip', { document: undefined }), ExportCacheError,);
  });

  it('resolveDesktopBridge：无 window.gisDesktop 返回 undefined，有则返回对象', () => {
    assert.strictEqual(resolveDesktopBridge({}), undefined);
    const bridge = { saveAs: async () => null };
    assert.strictEqual(resolveDesktopBridge({ gisDesktop: bridge }), bridge);
  });

  it('saveBlobAs：Electron 存在时走原生另存为并写盘（不触发浏览器下载）', async () => {
    const calls: { filename: string; text: string; isArrayBuffer: boolean }[] = [];
    const download = mock.fn();
    const result = await saveBlobAs(new Blob(['hello']), 'a.zip', {
      desktop: {
        saveAs: async (req) => {
          calls.push({
            filename: req.filename,
            text: new TextDecoder().decode(req.data),
            isArrayBuffer: req.data instanceof ArrayBuffer,
          });
          return '/home/u/a.zip';
        },
      },
      download,
    });
    assert.deepStrictEqual(result, { method: 'electron', path: '/home/u/a.zip' });
    assert.strictEqual(download.mock.calls.length, 0);
    assert.deepStrictEqual(calls, [{ filename: 'a.zip', text: 'hello', isArrayBuffer: true }]);
  });

  it('saveBlobAs：原生对话框取消（返回 null）不回退下载', async () => {
    const download = mock.fn();
    const result = await saveBlobAs(new Blob(['hello']), 'a.zip', {
      desktop: { saveAs: async () => null },
      download,
    });
    assert.deepStrictEqual(result, { method: 'canceled' });
    assert.strictEqual(download.mock.calls.length, 0);
  });

  it('saveBlobAs：原生通道抛错 → 回退浏览器下载并说明原因', async () => {
    const download = mock.fn();
    const result = await saveBlobAs(new Blob(['hello']), 'a.zip', {
      desktop: {
        saveAs: async () => {
          throw new Error('IPC 未注册');
        },
      },
      download,
    });
    assert.strictEqual(result.method, 'download');
    assert.ok(result.fallbackReason.includes('IPC 未注册'));
    assert.strictEqual(download.mock.calls.length, 1);
  });

  it('saveBlobAs：无桌面桥 → 直接浏览器下载', async () => {
    const download = mock.fn();
    const result = await saveBlobAs(new Blob(['hello']), 'a.zip', { desktop: undefined, download });
    assert.deepStrictEqual(result, { method: 'download' });
    assert.strictEqual(download.mock.calls.length, 1);
  });
});

describe('t29 exportCache · exportCacheToDisk', () => {
  it('打包 + 落盘：进度覆盖 collect/zip/save，返回保存方式', async () => {
    const phases: string[] = [];
    const result = await exportCacheToDisk('layer-1', {
      registry: xyzFiles,
      metadata: xyzMetadata(),
      layerName: '框选区域 XYZ 缓存',
      now: FIXED_NOW,
      desktop: {
        saveAs: async () => '/tmp/out.zip',
      },
      onProgress: (p) => phases.push(p.phase),
    });
    assert.strictEqual(result.filename, '框选区域 XYZ 缓存-20240102-030405.zip');
    assert.strictEqual(result.fileCount, 3);
    assert.deepStrictEqual(result.save, { method: 'electron', path: '/tmp/out.zip' });
    assert.strictEqual(phases[0], 'collect');
    assert.ok(phases.includes('zip'));
    assert.strictEqual(phases[phases.length - 1], 'save');
    assert.deepStrictEqual(await zipNames(result.blob), ['0/0/0.png', '1/0/0.png', '1/1/0.png']);
  });
});

describe('t29 exportCache · buildZipBlob（通用打包，t31 工程包复用）', () => {
  it('任意条目 → ZIP：路径原样保留，含嵌套结构（工程包式清单）', async () => {
    const progress: string[] = [];
    const built = await buildZipBlob(
      [
        { path: 'manifest.json', data: JSON.stringify({ formatVersion: 1 }) },
        { path: 'scene.json', data: '{"version":1}' },
        { path: 'caches/layer-1/0/0/0.png', data: new Blob(['png']) },
        { path: 'assets/model.glb', data: new Uint8Array([1, 2, 3]) },
      ],
      {
        label: '工程包',
        onProgress: (p) => progress.push(p.phase),
      },
    );

    assert.strictEqual(built.fileCount, 4);
    assert.ok(built.totalBytes > (0));
    assert.ok(built.zipBytes > (0));
    assert.strictEqual(progress[0], 'collect');
    assert.ok(progress.includes('zip'));

    const inner = await new JSZip().loadAsync(await built.blob.arrayBuffer());
    assert.deepStrictEqual(Object.keys(inner.files).sort(), [
      'assets/model.glb',
      'caches/layer-1/0/0/0.png',
      'manifest.json',
      'scene.json',
    ]);
    assert.deepStrictEqual(Object.values(inner.files).filter((f) => f.dir), []);
  });

  it('空条目 → empty 可读错误；超限 → too-large（不改既有缓存导出行为）', async () => {
    await assert.rejects(buildZipBlob([], { label: '工程包' }), { code: 'empty' });
    await assert.rejects(buildZipBlob([{ path: 'a.png', data: new Blob(['aaaa']) }], { limits: { maxBytes: 2 } }), { code: 'too-large' });
  });
});

describe('t29 exportCache · describeExportProgress', () => {
  it('三个阶段都有可读文案', () => {
    const base = { processed: 1, total: 3, totalBytes: 2048, ratio: 0.5 };
    assert.ok(describeExportProgress({ ...base, phase: 'collect' }).includes('3 个'));
    assert.ok(describeExportProgress({ ...base, phase: 'zip' }).includes('50%'));
    assert.ok(describeExportProgress({ ...base, phase: 'save', zipBytes: 1024 }).includes('保存到本地'));
  });
});
