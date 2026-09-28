/*
  dock/dock-store.test —— Dock 布局 Zustand store（自 gis-full dockStore 职责移植）

  验收点：
  - 初始默认布局 + focusedPanelId；
  - action 集：setActiveTab 钳制 / add / remove / float / dock / move / resize / close / focus；
  - 输出窗 ensure/toggle 幂等；
  - resetDockLayout 恢复默认；
  - node 环境（无 localStorage）下 initDockLayout 安全空转。
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectPanelIds } from "../packages/core/src/dock/layout-model";
import { DOCK_COMPONENT_REGISTRY, useDockStore } from "../packages/core/src/dock/dock-store";

const store = () => useDockStore.getState();

describe('dock · dockStore（Zustand）', () => {
  it('初始默认布局：面板齐全，焦点为 layers；注册表含 5 个固定面板', () => {
    const state = store();
    assert.deepEqual(collectPanelIds(state.root), ['layers', 'property', 'tools', 'query', 'output']);
    assert.strictEqual(state.focusedPanelId, 'layers');
    assert.strictEqual(state.floating.length, 0);
    assert.deepEqual(Object.keys(DOCK_COMPONENT_REGISTRY).sort(), ['layers', 'output', 'property', 'query', 'tools']);
  });

  it('node 环境（无 localStorage）initDockLayout 安全空转且幂等', () => {
    assert.doesNotThrow(() => store().initDockLayout());
    assert.doesNotThrow(() => store().initDockLayout());
  });

  it('setActiveTab：激活位被钳制到 [0, children-1]', () => {
    store().setActiveTab('tabs-right', 99);
    const state = store();
    const tabs = (state.root.children[0] as { children: Array<{ id: string; active: number }> }).children.find(
      (c) => c.id === 'tabs-right',
    ) as { active: number };
    assert.strictEqual(tabs.active, 2);
    store().resetDockLayout();
  });

  it('addPanel → removePanel 往返；renamePanel 生效', () => {
    const s0 = store();
    s0.addPanel({ kind: 'panel', id: 'custom', title: '自定义', component: 'CustomPanel' }, 'tabs-right', false);
    assert.ok(collectPanelIds(store().root).includes('custom'));

    s0.renamePanel('custom', '改名了');
    const found = (function walk(node: { kind?: string; id?: string; title?: string; children?: unknown[] }): string | undefined {
      if (node.kind === 'panel' && node.id === 'custom') return node.title;
      if (Array.isArray(node.children)) for (const c of node.children) { const r = walk(c as never); if (r) return r; }
      return undefined;
    })(store().root);
    assert.strictEqual(found, '改名了');

    s0.removePanel('custom');
    assert.ok(!collectPanelIds(store().root).includes('custom'));
  });

  it('floatPanel：从树拆出为浮动窗口；moveFloating/resizeFloating/focusFloating 维护 z 序', () => {
    const s0 = store();
    const before = collectPanelIds(s0.root);
    assert.ok(before.includes('property'));
    s0.floatPanel('property', { left: 10, top: 20 });
    const s1 = store();
    assert.ok(!collectPanelIds(s1.root).includes('property'));
    assert.strictEqual(s1.floating.length, 1);
    assert.strictEqual(s1.floating[0].panel.id, 'property');

    s1.moveFloating('property', 5, 7);
    s1.resizeFloating('property', 100, 50); // 低于最小尺寸被钳制
    const s2 = store();
    assert.strictEqual(s2.floating[0].left, 15);
    assert.strictEqual(s2.floating[0].top, 27);
    assert.strictEqual(s2.floating[0].width, 220);
    assert.strictEqual(s2.floating[0].height, 140);

    s2.floatPanel('layers', {});
    const s3 = store();
    assert.strictEqual(s3.floating.length, 2);
    const zBefore = s3.floating.find((f) => f.panel.id === 'property')!.zIndex;
    s3.focusFloating('property');
    const zAfter = store().floating.find((f) => f.panel.id === 'property')!.zIndex;
    assert.ok(zAfter > zBefore);

    // closeFloating：浮动 + 树同时移除
    store().closeFloating('layers');
    const s4 = store();
    assert.strictEqual(s4.floating.length, 1);
    assert.ok(!collectPanelIds(s4.root).includes('layers'));

    store().closeFloating('property');
    assert.strictEqual(store().floating.length, 0);
    store().resetDockLayout();
  });

  it('dockPanelTo：浮动面板停靠回 tabs（inside 合并），floating 清空该面板', () => {
    const s0 = store();
    const property = (function find(node: { kind?: string; id?: string; children?: unknown[] }): { kind: 'panel'; id: string; title: string; component: string } | undefined {
      if (node.kind === 'panel' && node.id === 'property') return node as never;
      if (Array.isArray(node.children)) for (const c of node.children) { const r = find(c as never); if (r) return r; }
      return undefined;
    })(s0.root)!;
    s0.removePanel('property');
    s0.dockPanelTo(property, { containerId: 'tabs-left', position: 'inside' });
    const ids = collectPanelIds(store().root);
    assert.ok(ids.includes('property'));
    assert.strictEqual(store().floating.length, 0);
    store().resetDockLayout();
  });

  it('输出窗 toggleOutputPanel：不存在 → 加回并激活；存在 → 移除；ensure 幂等', () => {
    // 默认布局已含 output → toggle 移除
    store().toggleOutputPanel();
    assert.ok(!collectPanelIds(store().root).includes('output'));
    assert.notStrictEqual(store().focusedPanelId, 'output');
    // 再 toggle 加回（底部 tabs 存在 → 追加到 tabs-bottom 并激活）
    store().toggleOutputPanel();
    assert.ok(collectPanelIds(store().root).includes('output'));
    assert.strictEqual(store().focusedPanelId, 'output');
    // ensure 幂等
    store().ensureOutputPanel();
    assert.strictEqual(store().focusedPanelId, 'output');
    store().resetDockLayout();
  });

  it('resetDockLayout：恢复默认布局与浮动清空', () => {
    store().removePanel('query');
    store().removePanel('tools');
    store().resetDockLayout();
    assert.deepEqual(collectPanelIds(store().root), ['layers', 'property', 'tools', 'query', 'output']);
    assert.strictEqual(store().floating.length, 0);
  });
});
