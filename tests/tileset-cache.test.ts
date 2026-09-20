/**
 * editor/core · localCache/tilesetCache —— 3D Tiles 缓存导入与预览 单测（t16）
 *
 * 覆盖 t9 遗留缺口：真实 tileset.json 的 content 挂在 **root 层**
 * （`{ asset, geometricError, root: { content, children } }`），
 * 必须对 root 递归补写，否则本地目录导入的 3D Tiles 预览时相对 URI 无法解析。
 *
 * 覆盖点：
 * - rewriteTilesetJsonText：root.content.uri 改写 / root.children 多级递归 /
 *   外部 tileset ref 改写 / 未命中映射保留 / http 与 blob 保留 / 无 root 容错 /
 *   顶层 tile 节点形态兼容（不回归）
 * - prepareLocalTileset 全链路：detect → buildTilesetUrlMap → rewrite → Blob → fromUrl
 *   结构断言（含多级 children、入口 tilesetBlobUrl、metadata 抽取）
 */
import { Cesium3DTileset } from 'cesium';
import assert from "node:assert/strict";
import { mock } from "node:test";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MockInstance } from 'node:test';

import { flattenDirectoryFiles } from '../packages/xyz-cache/src/detect';
import {
  buildTilesetUrlMap,
  extractTilesetMetadata,
  loadTilesetJsonText,
  prepareLocalTileset,
  revokeTilesetUrlMap,
  rewriteTilesetJsonText,
} from '../packages/xyz-cache/src/tileset-cache';

// ---------------------------------------------------------------------------
// 测试数据 / 工具
// ---------------------------------------------------------------------------

/** 真实结构的 3D Tiles 1.0 数据集：root.content.uri + 两级 children */
const REAL_TILESET_JSON = JSON.stringify({
  asset: { version: '1.0', tilesetVersion: 'v1' },
  geometricError: 500,
  root: {
    boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
    geometricError: 50,
    refine: 'ADD',
    content: { uri: '0/0/0.b3dm' },
    children: [
      {
        boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] },
        geometricError: 0,
        content: { uri: '1/0/0.b3dm' },
      },
      {
        boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] },
        geometricError: 0,
        content: { uri: 'sub/tileset.json' },
        children: [
          {
            boundingVolume: { box: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2] },
            geometricError: 0,
            content: { uri: 'sub/2/0/0.b3dm' },
            children: [
              { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, content: { uri: 'deep/3/0/0.b3dm' } },
            ],
          },
        ],
      },
    ],
  },
});

/** 造一个带 webkitRelativePath 的 File（webkitdirectory 语义） */
const dirFile = (rel: string, content: string | Blob = 'data'): File => {
  const name = rel.split('/').pop() ?? rel;
  const file = new File([content], name, { type: 'application/octet-stream' });
  Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true });
  return file;
};

/** 带根目录段的假数据集文件清单（相对路径 = webkitRelativePath 去掉根段） */
const DATASET_FILES = (): File[] => [
  dirFile('Cache/tileset.json', REAL_TILESET_JSON),
  dirFile('Cache/0/0/0.b3dm', 'root-content'),
  dirFile('Cache/1/0/0.b3dm', 'child-content'),
  dirFile('Cache/sub/tileset.json', '{"asset":{"version":"1.0"},"geometricError":1,"root":{}}'),
  dirFile('Cache/sub/2/0/0.b3dm', 'sub-content'),
  dirFile('Cache/deep/3/0/0.b3dm', 'deep-content'),
];

interface BlobSpy {
  /** 交给 Cesium 的入口 blob URL */
  entryUrl: string | undefined;
  /** 入口 blob 的文本 */
  entryText: () => Promise<string>;
}

describe('tilesetCache · rewriteTilesetJsonText（root 层重写）', () => {
  const urlMap = (): Map<string, string> =>
    new Map<string, string>([
      ['0/0/0.b3dm', 'blob:root-content'],
      ['1/0/0.b3dm', 'blob:child-content'],
      ['sub/tileset.json', 'blob:sub-json'],
      ['sub/2/0/0.b3dm', 'blob:sub-content'],
      ['deep/3/0/0.b3dm', 'blob:deep-content'],
    ]);

  it('真实结构样本：root.content.uri 与多级 children 全部改写为 blob URL', () => {
    const json = rewriteTilesetJsonText(REAL_TILESET_JSON, urlMap()) as unknown as {
      asset: { version: string };
      geometricError: number;
      root: {
        boundingVolume: { box: number[] };
        content: { uri: string };
        children: Array<{ content: { uri: string }; children?: unknown[] }>;
      };
    };

    // root 自身（t16 修复点）
    assert.strictEqual(json.root.content.uri, 'blob:root-content');
    // root 的直接子节点
    assert.strictEqual(json.root.children[0]!.content.uri, 'blob:child-content');
    // 外部 tileset 引用（children[1].content.uri）也被改写
    assert.strictEqual(json.root.children[1]!.content.uri, 'blob:sub-json');
    // 三层以下子孙递归
    const sub = json.root.children[1]!.children![0] as {
      content: { uri: string };
      children: Array<{ content: { uri: string } }>;
    };
    assert.strictEqual(sub.content.uri, 'blob:sub-content');
    assert.strictEqual(sub.children[0]!.content.uri, 'blob:deep-content');

    // 非 URI 字段透传（不改动）
    assert.strictEqual(json.asset.version, '1.0');
    assert.strictEqual(json.geometricError, 500);
    assert.deepStrictEqual(json.root.boundingVolume.box, [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
  });

  it('未命中映射 / http / blob / data 的 URI 原样保留', () => {
    const text = JSON.stringify({
      asset: { version: '1.1' },
      root: {
        content: { uri: 'unknown.b3dm' },
        children: [
          { content: { uri: 'https://cdn.example.com/tile.b3dm' } },
          { content: { uri: 'blob:existing' } },
          { content: { uri: 'data:application/octet-stream;base64,AAAA' } },
          { content: { uri: '0/0/0.b3dm' } },
        ],
      },
    });
    const json = rewriteTilesetJsonText(text, urlMap()) as unknown as {
      root: { content: { uri: string }; children: Array<{ content: { uri: string } }> };
    };
    assert.strictEqual(json.root.content.uri, 'unknown.b3dm');
    assert.strictEqual(json.root.children[0]!.content.uri, 'https://cdn.example.com/tile.b3dm');
    assert.strictEqual(json.root.children[1]!.content.uri, 'blob:existing');
    assert.strictEqual(json.root.children[2]!.content.uri, 'data:application/octet-stream;base64,AAAA');
    assert.strictEqual(json.root.children[3]!.content.uri, 'blob:root-content');
  });

  it('容错：root 缺失 / root 为 null / 空 root → 不抛错，且顶层 tile 节点形态仍被改写（不回归）', () => {
    // 1) 无 root 字段
    const noRoot = rewriteTilesetJsonText(
      JSON.stringify({ asset: { version: '1.0' }, geometricError: 10 }),
      urlMap(),
    ) as unknown as { asset: { version: string } };
    assert.strictEqual(noRoot.asset.version, '1.0');

    // 2) root: null
    const nullRoot = rewriteTilesetJsonText(
      JSON.stringify({ asset: { version: '1.0' }, root: null, content: { uri: '0/0/0.b3dm' } }),
      urlMap(),
    ) as unknown as { root: null; content: { uri: string } };
    assert.strictEqual(nullRoot.root, null);
    assert.strictEqual(nullRoot.content.uri, 'blob:root-content');

    // 3) 空 root 对象
    const emptyRoot = rewriteTilesetJsonText(
      JSON.stringify({ asset: { version: '1.0' }, geometricError: 1, root: {} }),
      urlMap(),
    ) as unknown as { root: Record<string, unknown> };
    assert.deepStrictEqual(emptyRoot.root, {});

    // 4) 扁平 tile 节点形态（content/children 挂在顶层）仍走原路径
    const flat = rewriteTilesetJsonText(
      JSON.stringify({
        asset: { version: '0.0' },
        content: { uri: '0/0/0.b3dm', url: '1/0/0.b3dm' },
        children: [{ content: { uri: 'deep/3/0/0.b3dm' } }],
      }),
      urlMap(),
    ) as unknown as {
      content: { uri: string; url: string };
      children: Array<{ content: { uri: string } }>;
    };
    assert.strictEqual(flat.content.uri, 'blob:root-content');
    assert.strictEqual(flat.content.url, 'blob:child-content');
    assert.strictEqual(flat.children[0]!.content.uri, 'blob:deep-content');
  });

  it('非法 JSON 直接抛错（保持既有语义）', () => {
    assert.throws(() => rewriteTilesetJsonText('not-json', urlMap()));
  });
});

// ---------------------------------------------------------------------------
// 全链路：detect → urlMap → rewrite → Blob → Cesium3DTileset.fromUrl
// ---------------------------------------------------------------------------

describe('tilesetCache · prepareLocalTileset 全链路', () => {
  let created: Map<string, Blob>;
  let createSpy: MockInstance;
  let revokeSpy: MockInstance;
  let fromUrlSpy: MockInstance;

  beforeEach(() => {
    created = new Map<string, Blob>();
    createSpy = mock.method(URL, 'createObjectURL', (obj: Blob | MediaSource) => {
      const url = `blob:test/${created.size}`;
      created.set(url, obj as Blob);
      return url;
    });
    revokeSpy = mock.method(URL, 'revokeObjectURL', () => undefined);
    fromUrlSpy = mock.method(Cesium3DTileset, 'fromUrl', async () => ({ isDestroyed: () => false } as never));
  });

  afterEach(() => {
    createSpy.mock.restore();
    revokeSpy.mock.restore();
    fromUrlSpy.mock.restore();
  });

  it('本地目录真实结构 3D Tiles：入口探测 + root/多级 children 重写 + 喂给 Cesium 的是重写后 blob', async () => {
    const items = flattenDirectoryFiles(DATASET_FILES());
    assert.strictEqual(items.length, (6));
    assert.strictEqual(items.every((it) => it.rootDir === 'Cache'), true);

    const result = await prepareLocalTileset(items, { name: '本地缓存' });

    // 入口探测（相对缓存根）
    assert.strictEqual(result.tilesetPath, 'tileset.json');
    // urlMap：6 个文件各自一个 blob URL（含入口 tileset.json 自身）
    assert.strictEqual(result.urlMap.size, 6);
    for (const url of result.urlMap.values()) assert.strictEqual(url.startsWith('blob:'), true);

    // 交给 Cesium 的是「重写后的 tileset.json」blob URL
    const entryUrl = fromUrlSpy.mock.calls[0]!.arguments[0] as string;
    assert.strictEqual(entryUrl, result.tilesetBlobUrl);
    assert.strictEqual(entryUrl.startsWith('blob:'), true);
    assert.deepStrictEqual(fromUrlSpy.mock.calls[0]!.arguments[1], { maximumScreenSpaceError: 16 });

    const rewritten = JSON.parse(await created.get(entryUrl)!.text()) as {
      asset: { version: string; tilesetVersion: string };
      root: {
        geometricError: number;
        content: { uri: string };
        children: Array<{ content: { uri: string }; children?: unknown[] }>;
      };
    };
    // root 层（t16 修复点）：相对路径 → 该 b3dm 文件自身的 blob URL
    assert.strictEqual(rewritten.root.content.uri, result.urlMap.get('0/0/0.b3dm'));
    assert.strictEqual(created.get(rewritten.root.content.uri)!.size, items.find((it) => it.relPath === '0/0/0.b3dm')!.size);
    // 直接子节点
    assert.strictEqual(rewritten.root.children[0]!.content.uri, result.urlMap.get('1/0/0.b3dm'));
    // 外部 tileset 引用 + 其下的多级子孙
    assert.strictEqual(rewritten.root.children[1]!.content.uri, result.urlMap.get('sub/tileset.json'));
    const sub = rewritten.root.children[1]!.children![0] as {
      content: { uri: string };
      children: Array<{ content: { uri: string } }>;
    };
    assert.strictEqual(sub.content.uri, result.urlMap.get('sub/2/0/0.b3dm'));
    assert.strictEqual(sub.children[0]!.content.uri, result.urlMap.get('deep/3/0/0.b3dm'));
    // 结构字段未被破坏
    assert.deepStrictEqual(rewritten.asset, { version: '1.0', tilesetVersion: 'v1' });
    assert.strictEqual(rewritten.root.geometricError, 50);
  });

  it('options.tilesetPath 强制指定入口（探测失败时兜底）后仍完成 root 重写', async () => {
    const files = [dirFile('Cache/data/tileset.json', REAL_TILESET_JSON), dirFile('Cache/0/0/0.b3dm', 'c')];
    const items = flattenDirectoryFiles(files);
    // 探测命中 data/tileset.json（唯一的 tileset.json）
    const result = await prepareLocalTileset(items, {});
    assert.strictEqual(result.tilesetPath, 'data/tileset.json');
    const rewritten = JSON.parse(await created.get(result.tilesetBlobUrl)!.text()) as {
      root: { content: { uri: string } };
    };
    assert.strictEqual(rewritten.root.content.uri, result.urlMap.get('0/0/0.b3dm'));
    // 用 options.tilesetPath 显式指定同一入口 → 行为一致
    const forced = await prepareLocalTileset(items, { tilesetPath: 'data/tileset.json' });
    assert.strictEqual(forced.tilesetPath, 'data/tileset.json');
  });

  it('无 tileset.json 入口 / 入口文件缺失时给出明确错误', async () => {
    await assert.rejects(prepareLocalTileset(flattenDirectoryFiles([dirFile('Cache/0/0/0.b3dm', 'c')]), {}), /未找到 tileset.json 入口/);

    const items = flattenDirectoryFiles([dirFile('Cache/0/0/0.b3dm', 'c')]);
    await assert.rejects(prepareLocalTileset(items, { tilesetPath: 'tileset.json' }), /未找到 tileset.json 文件/);
  });

  it('两条路径行为一致：prepareLocalTileset 的产物与 rewriteTilesetJsonText 的逐层一致', async () => {
    const items = flattenDirectoryFiles(DATASET_FILES());
    const directMap = buildTilesetUrlMap(items, 'tileset.json').urlMap;
    const direct = rewriteTilesetJsonText(await loadTilesetJsonText(items[0]!.file), directMap);

    const result = await prepareLocalTileset(items, {});
    const viaPrepare = JSON.parse(await created.get(result.tilesetBlobUrl)!.text()) as unknown;

    // 两条路径各自生成一组 blob URL（均被各自 urlMap 持有），
    // 把 blob URL 归一化回原始相对路径后，结构应逐层一致。
    const normalize = (json: unknown, urlMap: Map<string, string>): unknown => {
      const byUrl = new Map([...urlMap.entries()].map(([key, url]) => [url, key] as const));
      return JSON.parse(
        JSON.stringify(json, (_key, value: unknown) =>
          typeof value === 'string' && byUrl.has(value) ? byUrl.get(value) : value,
        ),
      );
    };
    assert.deepStrictEqual(normalize(viaPrepare, result.urlMap), normalize(direct, directMap));

    // root 层确实被改写（而不是只改写了顶层）
    const rootUri = (viaPrepare as { root: { content: { uri: string } } }).root.content.uri;
    assert.strictEqual(result.urlMap.get('0/0/0.b3dm'), rootUri);
    // 两张 map 覆盖同一批相对路径
    assert.deepStrictEqual([...result.urlMap.keys()], [...directMap.keys()]);
  });

  it('extractTilesetMetadata / revokeTilesetUrlMap 与 3dtiles 导入结果配套', async () => {
    const items = flattenDirectoryFiles(DATASET_FILES());
    const md = extractTilesetMetadata(items, 'Cache', 'tileset.json');
    assert.strictEqual(md.cacheKind, '3dtiles');
    assert.strictEqual(md.rootDir, 'Cache');
    assert.strictEqual(md.files.length, (6));
    assert.strictEqual(md.files[0]!.path, 'tileset.json');
    assert.deepStrictEqual(md.detection, { tilesetPath: 'tileset.json' });
    assert.strictEqual(md.totalBytes, items.reduce((sum, it) => sum + it.size, 0));

    const result = await prepareLocalTileset(items, {});
    revokeTilesetUrlMap(result.urlMap);
    // 只 revoke 经 createObjectURL 生成的 URL（urlMap.size = 6），非 blob: 项被跳过
    assert.strictEqual(revokeSpy.mock.calls.length, result.urlMap.size);
    for (const url of result.urlMap.values()) assert.strictEqual(url.startsWith('blob:'), true);
  });

  it('revokeTilesetUrlMap 跳过非 blob: 项（容错）', () => {
    revokeTilesetUrlMap(
      new Map<string, string>([
        ['a', 'blob:x'],
        ['b', 'https://example.com/b.b3dm'],
        ['c', ''],
      ]),
    );
    assert.strictEqual(revokeSpy.mock.calls.length, 1);
    assert.ok(revokeSpy.mock.calls.some((c) => c.arguments.length === 1 && c.arguments[0] === 'blob:x'));
  });
});
