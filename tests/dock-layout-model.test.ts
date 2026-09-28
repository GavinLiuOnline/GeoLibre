/*
  dock/layout-model.test —— Dock 布局模型（t36 移植）

  验收点：
  - 默认布局形态（左图层 / 中透空 / 右属性·工具·查询 / 底输出窗）；
  - serialize → JSON → deserialize round-trip 等值；
  - 空容器（中央透空区）可安全 round-trip；
  - 损坏输入（坏 JSON / 版本不符 / 重复 id / 空 tabs / sizes 不一致）→ undefined；
  - resize 归一化 / tabs 激活钳制 / add / remove / dock 不变量。
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addPanel,
  buildDefaultLayout,
  collectPanelIds,
  deserializeLayout,
  dockPanel,
  removePanel,
  resizeContainer,
  serializeLayout,
  setActiveTab,
  type FloatingPanel,
  type PanelNode,
} from "../packages/core/src/dock/layout-model";

/** vitest toBeCloseTo 等价：|a-b| < 10^-d / 2 */
const closeTo = (actual: number, expected: number, digits = 9): void => {
  assert.ok(Math.abs(actual - expected) < Math.pow(10, -digits) / 2, `closeTo: ${actual} !~ ${expected}`);
};

const REG = {
  layers: 'LayerPanel',
  property: 'PropertyPanel',
  output: 'OutputWindow',
  tools: 'ToolsPanel',
  query: 'QueryPanel',
};

function panelOf(root: ReturnType<typeof buildDefaultLayout>, id: string): PanelNode | undefined {
  const found = (function walk(node: unknown): PanelNode | undefined {
    const n = node as { kind?: string; children?: unknown[]; id?: string; title?: string; component?: string };
    if (n.kind === 'panel' && n.id === id) return n as unknown as PanelNode;
    if (Array.isArray(n.children)) {
      for (const c of n.children) {
        const r = walk(c);
        if (r) return r;
      }
    }
    return undefined;
  })(root);
  return found;
}

describe('dock · layoutModel', () => {
  it('默认布局：左图层 / 中央透空 / 右属性·工具·查询 / 底输出窗', () => {
    const root = buildDefaultLayout(REG);
    assert.strictEqual(root.direction, 'column');
    const [mainRow, bottom] = root.children as never[];
    assert.strictEqual(root.children.length, 2);
    const row = mainRow as { kind: string; direction: string; children: unknown[] };
    assert.strictEqual(row.kind, 'container');
    assert.strictEqual(row.direction, 'row');
    assert.deepEqual(collectPanelIds(root), ['layers', 'property', 'tools', 'query', 'output']);
    const center = (row.children as { kind: string; id: string; children: unknown[] }[])[1];
    assert.strictEqual(center.id, 'center-container');
    assert.strictEqual(center.children.length, 0); // 中央不放面板：地图透空交互
    const bottomTabs = bottom as { kind: string; id: string; children: { id: string }[] };
    assert.strictEqual(bottomTabs.id, 'tabs-bottom');
    assert.deepEqual(bottomTabs.children.map((p) => p.id), ['output']);
  });

  it('serialize → JSON → deserialize round-trip 等值（含空容器）', () => {
    const root = buildDefaultLayout(REG);
    const json = JSON.stringify(serializeLayout(root, []));
    const restored = deserializeLayout(json, REG);
    assert.ok(restored);
    assert.strictEqual(JSON.stringify(serializeLayout(restored!.root, restored!.floating)), json);
    assert.deepEqual(collectPanelIds(restored!.root), collectPanelIds(root));
  });

  it('浮动面板 round-trip：位置/尺寸/组件 key 保持', () => {
    const root = buildDefaultLayout(REG);
    const p = panelOf(root, 'property');
    const floating: FloatingPanel[] = [
      {
        id: 'property:float',
        panel: p!,
        left: 42,
        top: 24,
        width: 360,
        height: 280,
        zIndex: 105,
      },
    ];
    const json = JSON.stringify(serializeLayout(root, floating));
    const restored = deserializeLayout(json, REG)!;
    assert.strictEqual(restored.floating.length, 1);
    const f = restored.floating[0];
    assert.strictEqual(f.panel.id, 'property');
    assert.strictEqual(f.left, 42);
    assert.strictEqual(f.top, 24);
    assert.strictEqual(f.width, 360);
    assert.strictEqual(f.height, 280);
    assert.strictEqual(f.zIndex, 105);
    assert.strictEqual(f.panel.component, 'PropertyPanel');
  });

  it('损坏输入一律拒绝：坏 JSON / 版本 / 重复 id / 空 tabs / sizes 数量不符', () => {
    assert.strictEqual(deserializeLayout('not-json{{', REG), undefined);
    assert.strictEqual(deserializeLayout(null, REG), undefined);

    const root = buildDefaultLayout(REG);
    const good = serializeLayout(root, []) as { version: number; root: unknown };
    assert.strictEqual(deserializeLayout(JSON.stringify({ ...good, version: 2 }), REG), undefined);
    assert.strictEqual(deserializeLayout(JSON.stringify({ ...good, root: { kind: 'panel', id: 'x' } }), REG), undefined);

    // 重复面板 id
    const dup = JSON.parse(JSON.stringify(good));
    (dup.root.children[0] as { children: unknown[] }).children = [
      ((dup.root.children[0] as { children: unknown[] }).children as unknown[])[0],
    ];
    ((dup.root.children[0] as { children: Array<{ children: Array<{ id: string }> }> }).children[0]).children[0].id =
      'property';
    assert.strictEqual(deserializeLayout(JSON.stringify(dup), REG), undefined);

    // 空 tabs
    const emptyTabs = JSON.parse(JSON.stringify(good));
    (emptyTabs.root.children[1] as { children: unknown[] }).children = [];
    assert.strictEqual(deserializeLayout(JSON.stringify(emptyTabs), REG), undefined);

    // sizes 与 children 数量不一致
    const badSizes = JSON.parse(JSON.stringify(good));
    (badSizes.root.children[0] as { sizes: number[] }).sizes = [1, 2, 3, 4];
    assert.strictEqual(deserializeLayout(JSON.stringify(badSizes), REG), undefined);
  });

  it('resizeContainer 按 id 调整并归一化（总和 1）', () => {
    const root = buildDefaultLayout(REG);
    const next = resizeContainer(root, 'main-row', [100, 100, 100])!;
    const row = next.children[0] as { sizes: number[] };
    closeTo(row.sizes.reduce((s, v) => s + v, 0), 1, 10);
    assert.deepEqual(row.sizes, [1 / 3, 1 / 3, 1 / 3]);
    // 未命中的容器：结构不变（模型按不可变方式重建节点，但布局语义等价）
    const untouched = resizeContainer(next, 'no-such-id', [1, 9])!;
    assert.strictEqual(JSON.stringify(serializeLayout(untouched, [])), JSON.stringify(serializeLayout(next, [])));
  });

  it('setActiveTab 钳制到 [0, children-1]', () => {
    const root = buildDefaultLayout(REG);
    const next = setActiveTab(root, 'tabs-right', 99);
    const tabs = (next.children[0] as { children: { id: string; active: number }[] }).children.find(
      (c) => (c as { id: string }).id === 'tabs-right',
    ) as unknown as { active: number };
    assert.strictEqual(tabs.active, 2);
  });

  it('addPanel 追加到指定 tabs 并默认激活；removePanel 未命中返回 undefined', () => {
    const root = buildDefaultLayout(REG);
    const p: PanelNode = { kind: 'panel', id: 'query2', title: '查询 2', component: 'QueryPanel' };
    const withPanel = addPanel(root, p, 'tabs-right');
    const tabs = (withPanel.children[0] as { children: { id: string; active: number; children: { id: string }[] }[] })
      .children.find((c) => (c as { id: string }).id === 'tabs-right') as unknown as {
      active: number;
      children: { id: string }[];
    };
    assert.ok(tabs.children.map((c) => c.id).includes('query2'));
    assert.strictEqual(tabs.active, tabs.children.length - 1);
    assert.strictEqual(removePanel(root, 'no-such'), undefined);
  });

  it('removePanel：tabs 取空时移除该 tabs，sizes 重新归一', () => {
    const root = buildDefaultLayout(REG);
    const next = removePanel(root, 'layers')!;
    const row = next.children[0] as { children: { kind: string; id?: string }[]; sizes: number[] };
    // tabs-left 只剩 layers 一个面板 → 移除后 tabs-left 消失，main-row 只剩中央容器 + tabs-right
    assert.strictEqual(row.children.length, 2);
    assert.ok(!collectPanelIds(next).includes('layers'));
    closeTo(row.sizes.reduce((s, v) => s + v, 0), 1, 10);
  });

  it('dockPanel：浮动面板可合并进 tabs（inside）或停靠到根（追加新 tabs）', () => {
    const root = buildDefaultLayout(REG);
    const property = panelOf(root, 'property')!;

    // 模拟浮动：先从树中移除，再停靠回 tabs-left
    const withoutProperty = removePanel(root, 'property')!;
    const merged = dockPanel(withoutProperty, property, { containerId: 'tabs-left', position: 'inside' });
    const tabsLeft = ((merged.children[0] as { children: { id: string; children: { id: string }[] }[] })
      .children.find((c) => (c as { id: string }).id === 'tabs-left') ?? merged) as unknown as {
      children: { id: string }[];
    };
    assert.ok(tabsLeft.children.map((c) => c.id).includes('property'));

    // 停靠到根（'__root__' inside）：根为列容器 → 追加新 tabs 作为兄弟
    const appended = dockPanel(withoutProperty, property, { containerId: '__root__', position: 'inside' });
    assert.strictEqual(appended.children.length, 3);
    const added = appended.children[2] as { kind: string; children: { id: string }[] };
    assert.strictEqual(added.kind, 'tabs');
    assert.deepEqual(added.children.map((c) => c.id), ['property']);
  });
});
