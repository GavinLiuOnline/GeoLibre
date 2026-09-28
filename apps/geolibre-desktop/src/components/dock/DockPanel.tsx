/*
  dock/DockPanel —— 轻量级 Dock 布局渲染器（自 gis-full DockPanel.vue 重写为 React）

  渲染职责（与原实现对齐）：
  - 递归渲染 Container（row/column + splitter 拖拽改尺寸）/ Tabs（标签组）/ Panel 叶子；
  - 尺寸用 flexBasis: size*100%（grow/shrink=0），splitter 拖拽后回写归一化 sizes；
  - 浮动面板：fixed 窗口，标题栏拖动 + 右下角 grip 缩放 + 关闭 + 焦点 z 序；
  - 中央透空区（center-container）不渲染任何内容，地图在 dock 层之下交互。

  与 gis-full 的差异：
  - Vue 组件注册表 → React 组件注册表（prop 传入 id → ComponentType 映射）；
  - 布局状态来自 @geolibre/core 的 useDockStore（Zustand），不再是模块级 Vue reactive。
*/
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { useDockStore } from "@geolibre/core";
import type { ContainerNode, DockNode, PanelNode, TabsNode } from "@geolibre/core";
import { cn } from "@geolibre/ui";

export interface DockPanelProps {
  /** panel.component（注册表 key）→ React 组件 */
  componentRegistry: Record<string, ComponentType<Record<string, unknown>>>;
  className?: string;
}

interface DragState {
  containerId: string;
  containerEl: HTMLElement;
  direction: "row" | "column";
  pixelSizes: number[];
  splitterIndex: number;
}

let dragState: DragState | undefined;

function findContainer(root: ContainerNode, id: string): ContainerNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    if (child.kind === "container") {
      const found = findContainer(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

interface ItemWithSize {
  node: DockNode;
  size: number;
}

function containerItems(node: ContainerNode): ItemWithSize[] {
  return node.children.map((child, i) => ({ node: child, size: node.sizes[i] ?? 0 }));
}

export function DockPanel({ componentRegistry, className }: DockPanelProps) {
  const root = useDockStore((s) => s.root);
  const floating = useDockStore((s) => s.floating);
  const focusedPanelId = useDockStore((s) => s.focusedPanelId);
  const store = useDockStore;

  const containerRefs = useRef(new Map<string, HTMLElement>());
  const [contextMenu, setContextMenu] = useState<{ panelId: string; title: string; left: number; top: number } | null>(
    null,
  );

  useEffect(() => {
    store.getState().initDockLayout();
  }, [store]);

  // 点击任意处关闭上下文菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [contextMenu]);

  const setContainerRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) containerRefs.current.set(id, el);
    else containerRefs.current.delete(id);
  }, []);

  const startDrag = useCallback(
    (ev: ReactPointerEvent, containerId: string, splitterIndex: number, dir: "row" | "column") => {
      const containerEl = containerRefs.current.get(containerId);
      if (!containerEl) return;
      ev.preventDefault();
      ev.stopPropagation();
      const container = findContainer(store.getState().root, containerId);
      if (!container) return;
      const total = dir === "row" ? containerEl.offsetWidth : containerEl.offsetHeight;
      const pixelSizes = container.sizes.map((s) => Math.max(20, s * total));
      dragState = { containerId, containerEl, direction: dir, pixelSizes, splitterIndex };
      const onDrag = (move: PointerEvent) => {
        if (!dragState) return;
        const rect = dragState.containerEl.getBoundingClientRect();
        const posInContainer =
          dragState.direction === "row" ? move.clientX - rect.left : move.clientY - rect.top;
        const totalNow =
          dragState.direction === "row" ? dragState.containerEl.offsetWidth : dragState.containerEl.offsetHeight;
        const totalBefore = dragState.pixelSizes.reduce((s, v) => s + v, 0);
        const scale = totalNow / totalBefore;
        const currentPixels = dragState.pixelSizes.map((v) => v * scale);
        const i = dragState.splitterIndex;
        let splitterStart = 0;
        for (let k = 0; k < i; k++) splitterStart += currentPixels[k];
        const newBefore = Math.max(20, posInContainer - splitterStart);
        const newAfter = Math.max(20, currentPixels[i] + currentPixels[i + 1] - newBefore);
        currentPixels[i] = newBefore;
        currentPixels[i + 1] = newAfter;
        const sum = currentPixels.reduce((s, v) => s + v, 0);
        store.getState().resizeContainer(dragState.containerId, currentPixels.map((v) => v / sum));
        dragState.pixelSizes = currentPixels;
      };
      const endDrag = () => {
        window.removeEventListener("pointermove", onDrag);
        dragState = undefined;
      };
      window.addEventListener("pointermove", onDrag);
      window.addEventListener("pointerup", endDrag, { once: true });
    },
    [store],
  );

  const resolveComponent = useCallback(
    (key: string): ComponentType<Record<string, unknown>> =>
      componentRegistry[key] ?? DockPanelPlaceholder,
    [componentRegistry],
  );

  const renderPanelLeaf = useCallback(
    (panel: PanelNode): ReactNode => {
      const Component = resolveComponent(panel.component);
      return (
        <div
          className={cn(
            "pointer-events-auto flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
            focusedPanelId === panel.id && "ring-1 ring-inset ring-ring/40",
          )}
          onPointerDown={() => store.getState().setFocusedPanel(panel.id)}
        >
          <Component {...(panel.props as Record<string, unknown> | undefined)} />
        </div>
      );
    },
    [resolveComponent, focusedPanelId, store],
  );

  const renderTabs = useCallback(
    (tabs: TabsNode): ReactNode => (
      <div className="pointer-events-auto flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div
          className="flex shrink-0 items-stretch gap-px border-b border-border bg-muted/40"
          role="tablist"
        >
          {tabs.children.map((child, index) => {
            const active = index === tabs.active;
            return (
              <button
                key={child.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => store.getState().setActiveTab(tabs.id, index)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  setContextMenu({ panelId: child.id, title: child.title, left: ev.clientX, top: ev.clientY });
                }}
                className={cn(
                  "px-2.5 py-1 text-xs transition-colors",
                  active
                    ? "border-b-2 border-primary bg-background font-medium text-foreground"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                {child.title}
              </button>
            );
          })}
        </div>
        {tabs.children[tabs.active] ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {renderPanelLeaf(tabs.children[tabs.active])}
          </div>
        ) : null}
      </div>
    ),
    [renderPanelLeaf, store],
  );

  const renderNode = useCallback(
    (node: DockNode): ReactNode => {
      if (node.kind === "panel") return renderPanelLeaf(node);
      if (node.kind === "tabs") return renderTabs(node);
      const id = node.id ?? "nested";
      const dir = node.direction;
      return (
        <div
          ref={(el) => setContainerRef(id, el)}
          className={cn(
            "pointer-events-none flex min-h-0 min-w-0",
            dir === "row" ? "flex-row" : "flex-col",
          )}
        >
          {containerItems(node).map((item, i) => (
            <div key={item.node.kind === "panel" || item.node.kind === "tabs" ? item.node.id : `c-${i}`} className="contents">
              {i > 0 ? (
                <div
                  role="separator"
                  aria-orientation={dir === "row" ? "vertical" : "horizontal"}
                  onPointerDown={(ev) => startDrag(ev, id, i - 1, dir)}
                  className={cn(
                    "pointer-events-auto shrink-0 bg-transparent transition-colors hover:bg-primary/30",
                    dir === "row"
                      ? "w-1 cursor-col-resize"
                      : "h-1 cursor-row-resize",
                  )}
                />
              ) : null}
              <div
                className="flex min-h-0 min-w-0"
                style={{ flexBasis: `${item.size * 100}%`, flexGrow: 0, flexShrink: 0 }}
              >
                {renderNode(item.node)}
              </div>
            </div>
          ))}
        </div>
      );
    },
    [renderPanelLeaf, renderTabs, setContainerRef, startDrag],
  );

  const floatingWindows = useMemo(
    () =>
      floating.map((f) => (
        <div
          key={f.id}
          className="pointer-events-auto fixed flex flex-col overflow-hidden rounded-md border border-border bg-background shadow-xl"
          style={{ left: f.left, top: f.top, width: f.width, height: f.height, zIndex: f.zIndex }}
          onPointerDown={() => store.getState().focusFloating(f.panel.id)}
        >
          <div
            className="flex shrink-0 cursor-move items-center justify-between border-b border-border bg-muted/60 px-2 py-1"
            onPointerDown={(ev) => {
              ev.preventDefault();
              const startX = ev.clientX;
              const startY = ev.clientY;
              const onMove = (move: PointerEvent) => {
                store.getState().moveFloating(f.panel.id, move.clientX - startX, move.clientY - startY);
              };
              const onUp = () => window.removeEventListener("pointermove", onMove);
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp, { once: true });
            }}
          >
            <span className="text-xs font-medium text-foreground">{f.panel.title}</span>
            <button
              type="button"
              aria-label={`停靠 ${f.panel.title}`}
              title="停靠回布局"
              className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() =>
                store.getState().dockPanelTo(f.panel, { containerId: "__root__", position: "inside" })
              }
            >
              ⌷
            </button>
            <button
              type="button"
              aria-label={`关闭 ${f.panel.title}`}
              className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => store.getState().closeFloating(f.panel.id)}
            >
              ✕
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {renderPanelLeaf(f.panel)}
          </div>
          <div
            role="separator"
            className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize"
            onPointerDown={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const startX = ev.clientX;
              const startY = ev.clientY;
              const startW = f.width;
              const startH = f.height;
              const onMove = (move: PointerEvent) => {
                store
                  .getState()
                  .resizeFloating(f.panel.id, startW + (move.clientX - startX), startH + (move.clientY - startY));
              };
              const onUp = () => window.removeEventListener("pointermove", onMove);
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp, { once: true });
            }}
          />
        </div>
      )),
    [floating, renderPanelLeaf, store],
  );

  return (
    <div className={cn("pointer-events-none relative flex min-h-0 min-w-0 flex-1 flex-col", className)} data-testid="dock-panel">
      {renderNode(root)}
      {floatingWindows}
      {contextMenu ? (
        <div
          role="menu"
          className="pointer-events-auto fixed z-[90] min-w-32 rounded-md border border-border bg-popover p-1 shadow-md"
          style={{ left: contextMenu.left, top: contextMenu.top }}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-accent"
            onClick={() => {
              store.getState().floatPanel(contextMenu.panelId);
              setContextMenu(null);
            }}
          >
            浮动面板
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-accent"
            onClick={() => {
              store.getState().removePanel(contextMenu.panelId);
              setContextMenu(null);
            }}
          >
            关闭面板
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 未注册面板的占位渲染（PR3 起由真实面板组件替换） */
function DockPanelPlaceholder(_props: Record<string, unknown>) {
  return (
    <div className="flex flex-1 items-center justify-center p-3 text-xs text-muted-foreground">
      面板内容将在后续 PR 接入
    </div>
  );
}
