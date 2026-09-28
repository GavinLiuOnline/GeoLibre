/*
  dock/dock-store —— Dock 布局 Zustand store（自 gis-full editor/ui/dock/dockStore.ts 移植）

  职责（与原设计一致）：
  - 持有当前布局（root + floating）；
  - 应用 layout-model 的纯函数（move/resize/float/dock/add/remove/rename）；
  - localStorage 持久化（key='geolibre.dock-layout.v2'）+ 「重置默认」；
  - 暴露给 UI 组件的 action set。

  与 layout-model.ts 的分工：
  - layout-model = 纯函数（无副作用，可单测 round-trip）
  - dock-store   = Zustand 响应式封装 + 持久化副作用

  GeoLibre 适配：
  - Vue reactive/ref → Zustand store（状态并入 @geolibre/core，见计划 Phase 2 PR2）；
  - 组件注册表 key 由 Shell 侧 React 组件表解析（PR3 填充真实面板内容）。
*/
import { create } from "zustand";

import {
  addPanel as modelAddPanel,
  buildDefaultLayout,
  collectPanelIds,
  deserializeLayout,
  dockPanel as modelDockPanel,
  removePanel as modelRemovePanel,
  renamePanel as modelRenamePanel,
  resizeContainer as modelResizeContainer,
  serializeLayout,
  setActiveTab as modelSetActiveTab,
  type ContainerNode,
  type FloatingPanel,
  type PanelNode,
  type TabsNode,
} from "./layout-model";

const STORAGE_KEY = "geolibre.dock-layout.v2";

/** 组件注册表：panel id → React 组件 key（用于反序列化时查找 / Shell 渲染解析） */
export const DOCK_COMPONENT_REGISTRY: Record<string, string> = {
  layers: "LayerPanel",
  property: "PropertyPanel",
  output: "OutputWindow",
  tools: "ToolsPanel",
  query: "QueryPanel",
};

interface DockState {
  root: ContainerNode;
  floating: FloatingPanel[];
  focusedPanelId: string | undefined;
  /** 以下为 action（Zustand 同体放置，与 gis-full 的导出函数一一对应） */
  initDockLayout: () => void;
  resetDockLayout: () => void;
  resizeContainer: (containerId: string, sizes: number[]) => void;
  setActiveTab: (tabsId: string, active: number) => void;
  addPanel: (panel: PanelNode, tabsId: string, makeActive?: boolean) => void;
  removePanel: (panelId: string) => void;
  renamePanel: (panelId: string, title: string) => void;
  dockPanelTo: (
    panel: PanelNode,
    target: { containerId: string; position: "before" | "after" | "inside" },
  ) => void;
  floatPanel: (panelId: string, position?: { left?: number; top?: number; width?: number; height?: number }) => void;
  moveFloating: (panelId: string, dx: number, dy: number) => void;
  resizeFloating: (panelId: string, width: number, height: number) => void;
  closeFloating: (panelId: string) => void;
  focusFloating: (panelId: string) => void;
  setFocusedPanel: (panelId: string | undefined) => void;
  ensureOutputPanel: () => void;
  toggleOutputPanel: () => void;
}

/** 把当前布局写入 localStorage（失败时静默——隐私模式可能抛错） */
function persist(state: Pick<DockState, "root" | "floating">): void {
  try {
    if (typeof localStorage === "undefined") return;
    const json = serializeLayout(state.root, state.floating);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
  } catch {
    // ignore
  }
}

/** 模块级初始化守卫（与 gis-full 的 initialized 一致） */
let initialized = false;

export const useDockStore = create<DockState>()((set, get) => ({
  root: buildDefaultLayout(DOCK_COMPONENT_REGISTRY),
  floating: [],
  focusedPanelId: "layers",

  initDockLayout: () => {
    if (initialized) return;
    initialized = true;
    try {
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const restored = deserializeLayout(raw, DOCK_COMPONENT_REGISTRY);
      if (!restored) return;
      // 校验：恢复后的布局必须包含图层面板（输出窗可被用户关闭，不强制）；
      // 否则视为损坏 → 走默认布局
      const ids = new Set(collectPanelIds(restored.root));
      if (!["layers"].every((r) => ids.has(r))) return;
      set({ root: restored.root, floating: restored.floating });
    } catch {
      // ignore
    }
    // 订阅后续变更持久化（确保 sizes 归一化 / 缺字段补齐后写回）
    useDockStore.subscribe((state) => {
      persist(state);
    });
  },

  resetDockLayout: () => {
    set({ root: buildDefaultLayout(DOCK_COMPONENT_REGISTRY), floating: [] });
    persist(get());
  },

  resizeContainer: (containerId, sizes) => {
    const next = modelResizeContainer(get().root, containerId, sizes);
    if (next) set({ root: next });
  },

  setActiveTab: (tabsId, active) => {
    set({ root: modelSetActiveTab(get().root, tabsId, active) });
  },

  addPanel: (panel, tabsId, makeActive = true) => {
    set({ root: modelAddPanel(get().root, panel, tabsId, makeActive) });
  },

  removePanel: (panelId) => {
    set({ root: modelRemovePanel(get().root, panelId) ?? get().root });
  },

  renamePanel: (panelId, title) => {
    set({ root: modelRenamePanel(get().root, panelId, title) });
  },

  dockPanelTo: (panel, target) => {
    set({
      root: modelDockPanel(get().root, panel, target),
      floating: get().floating.filter((f) => f.panel.id !== panel.id),
    });
  },

  floatPanel: (panelId, position) => {
    const { root, floating } = get();
    const ids = collectPanelIds(root);
    if (!ids.includes(panelId)) return;
    const found = (function find(node: ContainerNode | PanelNode | FloatingPanel["panel"]): PanelNode | undefined {
      if (node.kind === "panel" && node.id === panelId) return node;
      if ("children" in node && Array.isArray(node.children)) {
        for (const c of node.children as Array<ContainerNode | PanelNode>) {
          const r = find(c);
          if (r) return r;
        }
      }
      return undefined;
    })(root);
    if (!found) return;
    const nextRoot = modelRemovePanel(root, panelId) ?? root;
    const maxZ = floating.reduce((m, f) => Math.max(m, f.zIndex), 100);
    const next: FloatingPanel = {
      id: `${panelId}:float`,
      panel: found,
      left: position?.left ?? 120,
      top: position?.top ?? 80,
      width: position?.width ?? 380,
      height: position?.height ?? 320,
      zIndex: maxZ + 1,
    };
    set({ root: nextRoot, floating: [...floating, next] });
  },

  moveFloating: (panelId, dx, dy) => {
    set({
      floating: get().floating.map((f) =>
        f.panel.id === panelId ? { ...f, left: f.left + dx, top: f.top + dy } : f,
      ),
    });
  },

  resizeFloating: (panelId, width, height) => {
    set({
      floating: get().floating.map((f) =>
        f.panel.id === panelId
          ? { ...f, width: Math.max(220, width), height: Math.max(140, height) }
          : f,
      ),
    });
  },

  closeFloating: (panelId) => {
    // 浮动关闭 = 真正从树中移除
    set({
      floating: get().floating.filter((f) => f.panel.id !== panelId),
      root: modelRemovePanel(get().root, panelId) ?? get().root,
    });
  },

  focusFloating: (panelId) => {
    const maxZ = get().floating.reduce((m, f) => Math.max(m, f.zIndex), 100);
    set({
      floating: get().floating.map((f) =>
        f.panel.id === panelId ? { ...f, zIndex: maxZ + 1 } : f,
      ),
    });
  },

  setFocusedPanel: (panelId) => {
    set({ focusedPanelId: panelId });
  },

  ensureOutputPanel: () => {
    const state = get();
    if (isPanelInLayout(state)) {
      // 已存在：把所在 tabs 的激活位切到输出窗
      const tabs = findTabsContaining(state.root, "output");
      if (tabs) {
        set({ root: modelSetActiveTab(state.root, tabs.id, tabs.index) });
      }
      set({ focusedPanelId: "output" });
      return;
    }
    const panel: PanelNode = {
      kind: "panel",
      id: "output",
      title: "输出窗",
      component: DOCK_COMPONENT_REGISTRY.output ?? "OutputWindow",
      props: { variant: "dock" },
    };
    const bottom = findTabsById(state.root, "tabs-bottom");
    if (bottom) {
      set({ root: modelAddPanel(state.root, panel, bottom.id, true) });
    } else {
      set({ root: modelDockPanel(state.root, panel, { containerId: "__root__", position: "inside" }) });
    }
    set({ focusedPanelId: "output" });
  },

  toggleOutputPanel: () => {
    const state = get();
    if (isPanelInLayout(state)) {
      set({
        root: modelRemovePanel(state.root, "output") ?? state.root,
        focusedPanelId: state.focusedPanelId === "output" ? undefined : state.focusedPanelId,
      });
    } else {
      get().ensureOutputPanel();
    }
  },
}));

/** 面板是否在当前布局中（含浮动） */
function isPanelInLayout(state: Pick<DockState, "root" | "floating">): boolean {
  if (collectPanelIds(state.root).includes("output")) return true;
  return state.floating.some((f) => f.panel.id === "output");
}

/** 包含指定面板的 tabs 节点（只读查找） */
function findTabsContaining(root: ContainerNode, panelId: string): { id: string; index: number } | undefined {
  function walk(node: ContainerNode | PanelNode | { kind: string }): { id: string; index: number } | undefined {
    if (node.kind === "panel") return undefined;
    if (node.kind === "tabs") {
      const tabs = node as unknown as { id: string; children: PanelNode[] };
      const index = tabs.children.findIndex((c) => c.id === panelId);
      if (index >= 0) return { id: tabs.id, index };
      return undefined;
    }
    const container = node as unknown as { children: unknown[] };
    for (const c of container.children) {
      const r = walk(c as ContainerNode | PanelNode);
      if (r) return r;
    }
    return undefined;
  }
  return walk(root);
}

/** 按 id 查找 tabs（含默认底部 tabs） */
function findTabsById(root: ContainerNode, tabsId: string): { id: string } | undefined {
  function walk(node: ContainerNode | TabsNode | PanelNode): { id: string } | undefined {
    if (node.kind === "panel") return undefined;
    if (node.kind === "tabs") {
      if (node.id === tabsId) return { id: node.id };
      return undefined;
    }
    for (const c of node.children) {
      const r = walk(c as ContainerNode | TabsNode | PanelNode);
      if (r) return r;
    }
    return undefined;
  }
  return walk(root);
}
