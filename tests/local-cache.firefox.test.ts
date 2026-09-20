/**
 * editor/core · localCache —— Firefox 专属提示 单测（t23）
 *
 * 验收要求：「`importLocalCacheFromPath` 在 Firefox 下给明确提示（file:// 在 Firefox
 * 不可用，推荐 http(s) 或 webkitdirectory）」。
 *
 * 沙箱内没有真实 Firefox，因此**注入 navigator.userAgent** 后断言错误文案：
 * - `file://` 目录无法枚举（无清单）→ 追加 Firefox 专属出路（http(s) / Electron / 目录选择）；
 * - 清单存在但瓦片全部拉取失败 → 同样追加；
 * - 目录选择结果缺少 webkitRelativePath（Firefox 已知差异）→ 追加 Firefox 提示；
 * - 非 Firefox（默认 node 环境）**不**出现 Firefox 字样（不污染 Chromium 路径）。
 *
 * 只读 + 断言既有 API 行为，不改动 t18 的任何逻辑分支。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { LayerManager } from '../LayerManager';
import { importLocalCache, importLocalCacheFromPath } from '../packages/xyz-cache/src/local-cache';

const FIREFOX_UA =
  'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

/** 把全局 UA 伪装成 Firefox（测试结束由 afterEach 还原） */
function stubFirefoxUa(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: FIREFOX_UA },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete (globalThis as { navigator?: unknown }).navigator;
});

/** 全 404 的假 fetch（清单探测 + 瓦片拉取都失败） */
const notFoundFetch = (async () => ({
  ok: false,
  status: 404,
  text: async () => '',
  blob: async () => new Blob([]),
})) as unknown as typeof fetch;

describe('localCache · Firefox file:// 提示（t23）', () => {
  it('无法枚举 file:// 目录时（Firefox）追加可操作出路', async () => {
    stubFirefoxUa();
    await assert.rejects(importLocalCacheFromPath('file:///home/nuanyang/tiles', {} as LayerManager, {
        fetchImpl: notFoundFetch,
      }), /Firefox[\s\S]*http\(s\)[\s\S]*Electron/);
  });

  it('清单存在但瓦片全部拉取失败时（Firefox）同样追加', async () => {
    stubFirefoxUa();
    await assert.rejects(importLocalCacheFromPath('file:///home/nuanyang/tiles', {} as LayerManager, {
        tiles: ['0/0/0.jpg'],
        fetchImpl: notFoundFetch,
      }), /未能加载任何瓦片[\s\S]*Firefox/);
  });

  it('目录选择结果缺 webkitRelativePath 时（Firefox）提示路径差异', async () => {
    stubFirefoxUa();
    // 普通 File（无 webkitRelativePath）等价于 Firefox 未提供相对路径的场景
    await assert.rejects(importLocalCache([new File(['x'], '0.jpg')], {} as LayerManager, { cacheKind: 'xyz' }), /webkitRelativePath[\s\S]*Firefox/);
  });

  it('非 Firefox（Chromium/WebKit/node）保持原文案，不出现 Firefox 专属提示', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
      configurable: true,
      writable: true,
    });
    await assert.rejects(importLocalCacheFromPath('file:///home/nuanyang/tiles', {} as LayerManager, {
        fetchImpl: notFoundFetch,
      }), /无法枚举目录内容/);
    await assert.rejects(
      importLocalCacheFromPath('file:///home/nuanyang/tiles', {} as LayerManager, {
        fetchImpl: notFoundFetch,
      }),
      (err: Error) => {
        assert.ok(!/Firefox/.test(err.message), '非 Firefox 环境不应出现 Firefox 专属提示');
        return true;
      },
    );
  });
});
