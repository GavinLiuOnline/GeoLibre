/*
  ribbon/commands.test —— Ribbon 命令注册表完整性（t36 移植）

  验收点：
  - 选项卡固定序列（文件/数据/缓存/发布/视图/工具/帮助）；
  - 命令 id 唯一、label/icon/run 齐备、tab/group 与所在层级一致；
  - 既有 TopMenuBar 全部入口无损迁移（关键命令 id 逐一断言）；
  - 平台分支：electronOnly 命令仅在桌面端出现；
  - 快捷键声明与 Shell 全局快捷键一致；
  - run 分发到 RibbonContext。
*/
import assert from "node:assert/strict";
import { mock } from "node:test";
import { describe, it } from "node:test";

import {
  buildRibbonCommands,
  collectCommandIds,
  findCommand,
  RIBBON_TABS,
  RibbonIcon,
  ribbonIconSvg,
  type RibbonCommand,
  type RibbonContext,
} from "../apps/geolibre-desktop/src/components/command/ribbon/commands";

type CtxOverrides = Partial<RibbonContext> & { pickDesktopNativeDir?: (() => void) | undefined };

function makeCtx(overrides: CtxOverrides = {}): RibbonContext {
  const base = {
    openDialog: mock.fn(),
    openBasemapDialog: mock.fn(),
    openHostDirectoryDialog: mock.fn(),
    openServiceListDialog: mock.fn(),
    openUrlImportDialog: mock.fn(),
    openSceneListDialog: mock.fn(),
    openProjectPackage: mock.fn(),
    openGenerateCache: mock.fn(),
    openRegionCache: mock.fn(),
    openAboutDialog: mock.fn(),
    pickAndOpenScene: mock.fn(),
    saveToServer: mock.fn(() => Promise.resolve()),
    downloadScene: mock.fn(),
    newScene: mock.fn(),
    setTool: mock.fn(),
    setView: mock.fn(),
    cycleBasemap: mock.fn(),
    flipTheme: mock.fn(),
    pickLocalCacheDir: mock.fn(),
    pickDesktopNativeDir: mock.fn(),
    resetLayout: mock.fn(),
    toggleDockEditor: mock.fn(),
    toggleVertexEdit: mock.fn(),
    openReprojectionDialog: mock.fn(),
    openGenerateCache: mock.fn(),
    openRegionCache: mock.fn(),
    isElectronAvailable: false,
  };
  return { ...base, ...overrides } as RibbonContext;
}

/** TopMenuBar（9 组菜单）全部入口 → Ribbon commandId 的无损迁移清单 */
const MIGRATED_IDS = [
  // 文件
  'scene.new',
  'package.import',
  'scene.open-server',
  'scene.save',
  'package.export',
  // 添加数据
  'data.import',
  'data.import-xyz-dir',
  'data.import-3dtiles-dir',
  'data.import-url',
  'data.host-directory',
  'data.import-desktop-native', // 桌面原生（electronOnly）
  'data.gen-3d',
  'data.gen-2d',
  'data.gen-region',
  // 配准 / 轻量化
  'data.reprojection',
  'data.optimizer',
  // 绘制
  'tool.draw-point',
  'tool.draw-line',
  'tool.draw-polygon',
  'tool.rect-select',
  'tool.vertex-edit',
  'tool.pick',
  'tool.pan',
  // 视图
  'view.3d',
  'view.2d',
  'view.cv',
  'view.basemap-mgr',
  'view.basemap-cycle',
  // 工具
  'tool.settings',
  // 服务
  'publish.oneclick',
  'cache.services',
  // 帮助
  'help.about',
  // 重置默认布局入视图页
  'view.reset-layout',
] as const;

describe('ribbon · 命令注册表', () => {
  it('选项卡固定序列：文件/数据/缓存/发布/视图/工具/帮助', () => {
    assert.deepEqual(RIBBON_TABS.map((t) => t.id), ['file', 'data', 'cache', 'publish', 'view', 'tools', 'help']);
    assert.deepEqual(RIBBON_TABS.map((t) => t.label), ['文件', '数据', '缓存', '发布', '视图', '工具', '帮助']);
  });

  it('全部命令 id 唯一且 label/icon/run 齐备', () => {
    const ids = collectCommandIds();
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.ok(ids.length >= MIGRATED_IDS.length);
    for (const tab of RIBBON_TABS) {
      for (const group of tab.groups) {
        for (const cmd of group.commands) {
          assert.notStrictEqual(cmd.label.trim(), '', `${cmd.id} 需要非空 label`);
          assert.ok(
            RibbonIcon[cmd.icon as keyof typeof RibbonIcon],
            `${cmd.id} 图标 ${cmd.icon} 必须存在于内联 SVG 库`,
          );
          assert.strictEqual(typeof cmd.run, 'function');
          assert.strictEqual(cmd.tab, tab.id);
          assert.strictEqual(cmd.group, group.id);
        }
      }
    }
  });

  it('TopMenuBar 全部入口无损迁移（关键 commandId 逐一存在）', () => {
    for (const id of MIGRATED_IDS) {
      const cmd = findCommand(id);
      assert.ok(cmd, `缺少命令：${id}`);
      assert.notStrictEqual(cmd.label.trim(), '');
    }
  });

  it('buildRibbonCommands：Web 端过滤 electronOnly 命令，桌面端保留', () => {
    const web = buildRibbonCommands(makeCtx({ isElectronAvailable: false }));
    const webIds = web.flatMap((t) => t.groups.flatMap((g) => g.commands.map((c) => c.id)));
    assert.ok(!webIds.includes('data.import-desktop-native'));

    const desktop = buildRibbonCommands(makeCtx({ isElectronAvailable: true }));
    const desktopIds = desktop.flatMap((t) => t.groups.flatMap((g) => g.commands.map((c) => c.id)));
    assert.ok(desktopIds.includes('data.import-desktop-native'));
  });

  it('快捷键声明：保存 Ctrl+S / 新建 Ctrl+N（与 Shell 全局快捷键一致）', () => {
    assert.strictEqual(findCommand('scene.save')?.shortcut, 'Ctrl+S');
    assert.strictEqual(findCommand('scene.new')?.shortcut, 'Ctrl+N');
  });

  it('run 分发到 RibbonContext（新建 / 发布 / 桌面原生 / 重置布局）', () => {
    const ctx = makeCtx();
    findCommand('scene.new')?.run(ctx);
    assert.strictEqual((ctx.newScene as ReturnType<typeof mock.fn>).mock.callCount(), 1);

    findCommand('publish.oneclick')?.run(ctx);
    const openDialog = ctx.openDialog as ReturnType<typeof mock.fn>;
    assert.deepEqual(openDialog.mock.calls[0]?.arguments, ['publish']);

    findCommand('view.reset-layout')?.run(ctx);
    assert.strictEqual((ctx.resetLayout as ReturnType<typeof mock.fn>).mock.callCount(), 1);

    findCommand('view.toggle-dock')?.run(ctx);
    assert.strictEqual((ctx.toggleDockEditor as ReturnType<typeof mock.fn>).mock.callCount(), 1);

    findCommand('tool.vertex-edit')?.run(ctx);
    assert.strictEqual((ctx.toggleVertexEdit as ReturnType<typeof mock.fn>).mock.callCount(), 1);

    findCommand('data.reprojection')?.run(ctx);
    assert.strictEqual((ctx.openReprojectionDialog as ReturnType<typeof mock.fn>).mock.callCount(), 1);

    findCommand('data.gen-2d')?.run(ctx);
    assert.strictEqual(
      (ctx.openGenerateCache as ReturnType<typeof mock.fn>).mock.calls[0]?.arguments[0],
      '2d',
    );
    findCommand('data.gen-region')?.run(ctx);
    assert.strictEqual((ctx.openRegionCache as ReturnType<typeof mock.fn>).mock.callCount(), 1);

    // 桌面原生入口桥缺失（pickDesktopNativeDir 未提供）时不应抛错
    const webCtx = makeCtx({ pickDesktopNativeDir: undefined });
    const desktopCmd = findCommand('data.import-desktop-native') as RibbonCommand;
    assert.doesNotThrow(() => desktopCmd.run(webCtx));
  });

  it('findCommand 未命中返回 undefined；collectCommandIds 与树一致', () => {
    assert.strictEqual(findCommand('nope.nope'), undefined);
    const total = RIBBON_TABS.reduce(
      (s, t) => s + t.groups.reduce((s2, g) => s2 + g.commands.length, 0),
      0,
    );
    assert.strictEqual(collectCommandIds().length, total);
  });

  it('ribbonIconSvg：已知图标产出合法 <svg> 片段，未知图标返回空串', () => {
    assert.ok(ribbonIconSvg('file').startsWith("<svg viewBox='0 0 24 24'"));
    assert.ok(ribbonIconSvg('file').includes('</svg>'));
    assert.strictEqual(ribbonIconSvg('no-such-icon'), '');
  });
});
