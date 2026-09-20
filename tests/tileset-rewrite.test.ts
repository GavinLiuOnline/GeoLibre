import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEmptyUrlMap,
  rewriteTilesetJson,
  rewriteTilesetNode,
} from '../packages/xyz-cache/src/tileset-rewrite';

describe('rewriteTilesetNode', () => {
  it('重写 content.uri 中的相对路径为 blob URL', () => {
    const urlMap = new Map<string, string>([
      ['0/0/0.b3dm', 'blob:abc'],
      ['1/2/3.b3dm', 'blob:def'],
    ]);
    const node = {
      asset: { version: '1.0' },
      geometricError: 100,
      content: { uri: '0/0/0.b3dm' },
    };
    rewriteTilesetNode(node, urlMap);
    assert.strictEqual(node.content?.uri, 'blob:abc');
  });

  it('http URL 原样保留', () => {
    const urlMap = buildEmptyUrlMap();
    const node = { content: { uri: 'https://example.com/tile.b3dm' } };
    rewriteTilesetNode(node, urlMap);
    assert.strictEqual(node.content?.uri, 'https://example.com/tile.b3dm');
  });

  it('blob: / data: 原样保留', () => {
    const urlMap = buildEmptyUrlMap();
    const node = { content: { uri: 'blob:existing' } };
    rewriteTilesetNode(node, urlMap);
    assert.strictEqual(node.content?.uri, 'blob:existing');
  });

  it('递归改写 children 内嵌 tileset 的 content.uri', () => {
    const urlMap = new Map<string, string>([
      ['inner.b3dm', 'blob:inner'],
    ]);
    const node = {
      children: [
        {
          boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
          content: { uri: 'inner.b3dm' },
        },
        {
          content: { uri: 'external.json' },
          children: [
            { content: { uri: 'inner.b3dm' } },
          ],
        },
      ],
    };
    rewriteTilesetNode(node, urlMap);
    assert.strictEqual((node.children as { content: { uri: string } }[])[0].content.uri, 'blob:inner');
    // 'external.json' 不在 urlMap 中，原样保留
    assert.strictEqual((node.children as { content: { uri: string } }[])[1].content.uri, 'external.json');
    // 深层递归
    assert.strictEqual(((node.children as { children?: { content: { uri: string } }[] }[])[1].children ?? [])[0].content.uri, 'blob:inner');
  });

  it('未命中 urlMap 的相对路径原样保留', () => {
    const urlMap = new Map<string, string>();
    const node = { content: { uri: 'unknown.b3dm' } };
    rewriteTilesetNode(node, urlMap);
    assert.strictEqual(node.content?.uri, 'unknown.b3dm');
  });
});

describe('rewriteTilesetJson', () => {
  it('整体改写 + 返回同引用', () => {
    const urlMap = new Map<string, string>([['a.b3dm', 'blob:a']]);
    const json = {
      asset: { version: '1.0' },
      content: { uri: 'a.b3dm' },
    };
    const result = rewriteTilesetJson(json, urlMap);
    assert.strictEqual(result, json);
    assert.strictEqual(result.content.uri, 'blob:a');
  });
});