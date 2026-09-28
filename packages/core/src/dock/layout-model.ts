/*
  @geolibre/core dock/layout-model（自 gis-full editor/ui/dock/layoutModel 移植） —— 轻量级 Dock 布局模型

  设计动机：
  - Vue3 生态下 dockview-vue / vue-fluid-dock 等成熟库体积 200KB+，
    对编辑器场景（仅 5 个面板 + 三栏布局）属于过度引入；
  - 自写约 350 行即可覆盖需求：splitter 拖拽改尺寸 / 标签分组 / 浮动面板 / 布局序列化；
  - 序列化结构稳定，可直接存 localStorage；JSON.stringify/parse round-trip 可纯 node 单测；
  - 与 Vue 响应式解耦，store 只持有「当前布局」+「变更回调」，组件用 computed 渲染。

  模型核心：
  - DockNode = Container | Panel | Tabs
    - Container { kind:'container', direction:'row'|'column', children: DockNode[], sizes: number[] }
    - Panel    { kind:'panel', id:string, title:string, contentComponent:string, props?:Record<string,unknown> }
    - Tabs     { kind:'tabs', active:number, children: Panel[] }
  - 根节点是 Container；布局「序列化」= 直接 JSON 化根节点；
  - 「反序列化」= JSON.parse 后做基本合法性校验（结构 / id 唯一 / sizes 总和一致）。

  关键能力：
  1. movePanel(node, panelId, targetContainerId, position:'before'|'after'|'inside'):
     - 把一个 Panel 从当前位置移到另一容器（同 tabs 内 / 新 tabs / 跨容器）；
  2. resizeContainer(node, containerId, sizes:number[]):
     - 调整 splitter 比例（按比例归一，总和为 1）；
  3. floatPanel(node, panelId, position:{left,top,width,height}):
     - 从容器中拆出为顶层 FloatingPanel；浮动面板以 Map<id,FloatingPanel> 单独存；
  4. dockPanel(node, floatingId, targetContainerId, position):
     - 把浮动面板停靠回指定容器；
  5. setActiveTab / addPanel / removePanel / renamePanel

  面板 id 命名约定：
  - 固定面板：'layers' / 'property' / 'output' / 'tools' / 'query'
  - 自定义面板：用户加的（比如 'tasks' / 'log'）；由调用方保证唯一

  持久化：
  - saveLayout(node, floatingMap) → { version:1, root:SerializedNode, floating: SerializedFloating[] }
  - loadLayout(json) → { root, floating } 或失败时返回 undefined（调用方走默认布局）
*/

/** 一个「面板」节点（叶子）；面板 id 全局唯一。 */
export interface PanelNode {
  kind: 'panel';
  id: string;
  title: string;
  /** React 组件注册表 key（渲染时经组件表查找） */
  component: string;
  /** 传给组件的 props（运行时通过 props map 注入） */
  props?: Record<string, unknown>;
}

/** 标签组节点：同一容器内多个面板共享头部标签栏。 */
export interface TabsNode {
  kind: 'tabs';
  /** 唯一 id（用于 dock 操作 / 序列化识别） */
  id: string;
  active: number;
  children: PanelNode[];
}

/** 容器节点（行/列 splitter）。sizes[i] = children[i] 的占比（0~1，总和=1）。 */
export interface ContainerNode {
  kind: 'container';
  /** 唯一 id（根容器 = '__root__'，嵌套容器由 ensureNodeIds 生成） */
  id: string;
  direction: 'row' | 'column';
  children: DockNode[];
  sizes: number[];
}

/** 任意 dock 节点。 */
export type DockNode = PanelNode | TabsNode | ContainerNode;

/** 浮动面板（不在主树内，单独渲染为可拖拽窗口）。 */
export interface FloatingPanel {
  id: string;
  panel: PanelNode;
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex: number;
}

/** 序列化的面板节点（component 退化为字符串 key）。 */
export interface SerializedPanel {
  kind: 'panel';
  id: string;
  title: string;
  component: string;
  props?: Record<string, unknown>;
}

/** 序列化的标签组 */
export interface SerializedTabs {
  kind: 'tabs';
  id: string;
  active: number;
  children: SerializedPanel[];
}

/** 序列化的容器 */
export interface SerializedContainer {
  kind: 'container';
  id: string;
  direction: 'row' | 'column';
  children: SerializedDockNode[];
  sizes: number[];
}

export type SerializedDockNode = SerializedPanel | SerializedTabs | SerializedContainer;

/** 顶层序列化结构（含版本号，便于未来迁移）。 */
export interface SerializedLayout {
  version: 1;
  root: SerializedDockNode;
  floating: FloatingPanel[];
}

// ---------------------------------------------------------------------------
// 默认布局（左：图层 | 中：Cesium 透空区 | 右：属性·工具·查询；底：输出窗）
// ---------------------------------------------------------------------------

/**
 * 默认布局：
 * root = 列容器 [ 行容器 [左(图层), 中(空——Cesium 由 App.vue 渲染在 dock 之下，中央保持交互),
 *                        右(属性·工具·查询 tabs)],
 *                 底(输出窗 tabs) ]
 * 中央不放任何面板：dock 容器/单元格不拦截指针事件，Cesium 在下层可正常拾取漫游。
 */
export function buildDefaultLayout(componentRegistry: Record<string, string>): ContainerNode {
  return {
    kind: 'container',
    id: '__root__',
    direction: 'column',
    sizes: [0.72, 0.28],
    children: [
      {
        kind: 'container',
        id: 'main-row',
        direction: 'row',
        sizes: [0.24, 0.48, 0.28],
        children: [
          {
            kind: 'tabs',
            id: 'tabs-left',
            active: 0,
            children: [
              {
                kind: 'panel',
                id: 'layers',
                title: '图层',
                component: componentRegistry.layers ?? 'LayerPanel',
              },
            ],
          },
          // 中央：Cesium 不属于 dock 内容，由 App.vue 单独渲染（保持透空，不放面板）
          {
            kind: 'container',
            id: 'center-container',
            direction: 'column',
            children: [],
            sizes: [],
          },
          {
            kind: 'tabs',
            id: 'tabs-right',
            active: 0,
            children: [
              {
                kind: 'panel',
                id: 'property',
                title: '属性',
                component: componentRegistry.property ?? 'PropertyPanel',
              },
              {
                kind: 'panel',
                id: 'tools',
                title: '工具',
                component: componentRegistry.tools ?? 'ToolsPanel',
              },
              {
                kind: 'panel',
                id: 'query',
                title: '查询',
                component: componentRegistry.query ?? 'QueryPanel',
              },
            ],
          },
        ],
      },
      {
        kind: 'tabs',
        id: 'tabs-bottom',
        active: 0,
        children: [
          {
            kind: 'panel',
            id: 'output',
            title: '输出窗',
            component: componentRegistry.output ?? 'OutputWindow',
            props: { variant: 'dock' },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 序列化 / 反序列化
// ---------------------------------------------------------------------------

function serializeNode(node: DockNode): SerializedDockNode {
  if (node.kind === 'panel') {
    return {
      kind: 'panel',
      id: node.id,
      title: node.title,
      component: typeof node.component === 'string' ? node.component : '__inline__',
      ...(node.props ? { props: node.props } : {}),
    };
  }
  if (node.kind === 'tabs') {
    return {
      kind: 'tabs',
      id: node.id,
      active: node.active,
      children: node.children.map(serializeNode) as SerializedPanel[],
    };
  }
  return {
    kind: 'container',
    id: node.id,
    direction: node.direction,
    children: node.children.map(serializeNode),
    sizes: [...node.sizes],
  };
}

export function serializeLayout(root: ContainerNode, floating: FloatingPanel[]): SerializedLayout {
  return {
    version: 1,
    root: serializeNode(root) as SerializedContainer,
    floating: floating.map((f) => ({ ...f, panel: { ...f.panel } })),
  };
}

interface DeserializeContext {
  components: Record<string, string>;
  /** 收集到的所有面板 id（用于去重/校验） */
  panelIds: Set<string>;
}

function deserializeNode(node: SerializedDockNode, ctx: DeserializeContext): DockNode {
  if (node.kind === 'panel') {
    if (ctx.panelIds.has(node.id)) {
      throw new Error(`重复的面板 id：${node.id}`);
    }
    ctx.panelIds.add(node.id);
    const component =
      node.component === '__inline__'
        ? '__inline__'
        : ctx.components[node.component] ?? node.component;
    const panel: PanelNode = {
      kind: 'panel',
      id: node.id,
      title: node.title,
      component,
      ...(node.props ? { props: node.props } : {}),
    };
    return panel;
  }
  if (node.kind === 'tabs') {
    const panels: PanelNode[] = [];
    for (const child of node.children) {
      const deserialized = deserializeNode(child, ctx);
      if (deserialized.kind !== 'panel') {
        throw new Error('tabs 内必须是 panel');
      }
      panels.push(deserialized);
    }
    if (panels.length === 0) {
      throw new Error('tabs 不能为空');
    }
    const active = Math.max(0, Math.min(node.active, panels.length - 1));
    return { kind: 'tabs', id: node.id, active, children: panels };
  }
  const sizes = Array.isArray(node.sizes) ? [...node.sizes] : [];
  if (sizes.length !== node.children.length) {
    throw new Error('容器 sizes 与 children 数量不一致');
  }
  const sum = sizes.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  const normalized = sum > 0 ? sizes.map((v) => v / sum) : sizes.map(() => 1 / sizes.length);
  const children: DockNode[] = node.children.map((c) => deserializeNode(c, ctx));
  return {
    kind: 'container',
    id: node.id ?? '__root__',
    direction: node.direction === 'column' ? 'column' : 'row',
    children,
    sizes: normalized,
  };
}

export function deserializeLayout(
  json: SerializedLayout | string | null | undefined,
  components: Record<string, string>,
): { root: ContainerNode; floating: FloatingPanel[] } | undefined {
  if (!json) return undefined;
  let parsed: SerializedLayout | undefined;
  try {
    parsed = typeof json === 'string' ? (JSON.parse(json) as SerializedLayout) : json;
  } catch {
    return undefined;
  }
  if (!parsed || parsed.version !== 1 || !parsed.root || parsed.root.kind !== 'container') {
    return undefined;
  }
  try {
    const ctx: DeserializeContext = { components, panelIds: new Set() };
    const root = deserializeNode(parsed.root, ctx);
    if (root.kind !== 'container') return undefined;
    const floating = (parsed.floating ?? []).map((f, i): FloatingPanel => ({
      id: f.id || `${f.panel.id}:float:${i}`,
      panel: {
        kind: 'panel',
        id: f.panel.id,
        title: f.panel.title,
        component: (components as Record<string, string>)[f.panel.component as string] ?? (f.panel.component as string),
        ...(f.panel.props ? { props: f.panel.props } : {}),
      },
      left: typeof f.left === 'number' ? f.left : 100 + i * 40,
      top: typeof f.top === 'number' ? f.top : 100 + i * 40,
      width: typeof f.width === 'number' && f.width > 0 ? f.width : 360,
      height: typeof f.height === 'number' && f.height > 0 ? f.height : 320,
      zIndex: typeof f.zIndex === 'number' ? f.zIndex : 100 + i,
    }));
    return { root, floating };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 节点查找 / 修改（不可变：返回新树，原树不变；简化 React/Vue 双向绑定）
// ---------------------------------------------------------------------------

/** 在树中查找面板节点（返回路径） */
function findPanelPath(
  node: DockNode,
  id: string,
  path: DockNode[] = [],
): { node: PanelNode; parent: TabsNode | ContainerNode; index: number; path: DockNode[] } | undefined {
  path.push(node);
  if (node.kind === 'panel') {
    if (node.id === id) {
      // panel 的父级一定是 tabs（panel 不会直接挂 container）
      return undefined; // 由调用方处理：顶层 panel 没有父级容器
    }
    path.pop();
    return undefined;
  }
  if (node.kind === 'tabs') {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.kind === 'panel' && child.id === id) {
        return { node: child, parent: node, index: i, path };
      }
      if (child.kind !== 'panel') {
        const found = findPanelPath(child, id, path);
        if (found) return found;
      }
    }
    path.pop();
    return undefined;
  }
  // container
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const found = findPanelPath(child, id, path);
    if (found) return found;
  }
  path.pop();
  return undefined;
}

/** 把某位置的 panel 移到目标位置：before/after 插入兄弟，inside 创建新 tabs。 */
export interface MoveTarget {
  /** 目标容器（root 或 root 内任意 container / tabs）的 id。'__root__' 表示根容器。 */
  containerId: string;
  /** 'inside' = 合并到目标 tabs（若目标是 tabs）或新建 tabs（若目标是 container）；
   *  'before' / 'after' = 插入到目标容器对应索引前后 */
  position: 'before' | 'after' | 'inside';
  /** 当 position='before'/'after' 且 containerId 是 tabs/panel 时使用的子索引（仅 tabs 实际有用） */
  index?: number;
}

/** 在根或子节点中按 id 找容器 */
function findContainerById(root: DockNode, id: string): ContainerNode | TabsNode | undefined {
  if (id === '__root__') {
    return root.kind === 'container' ? root : undefined;
  }
  function walk(node: DockNode): ContainerNode | TabsNode | undefined {
    if (node.kind === 'container' && node.id === id) return node;
    if (node.kind === 'tabs' && node.id === id) return node;
    if (node.kind === 'container' || node.kind === 'tabs') {
      for (const c of node.children) {
        const r = walk(c);
        if (r) return r;
      }
    }
    return undefined;
  }
  return walk(root);
}

/** 给容器节点添加内部 id（仅当尚未设置）；返回新节点（不可变）。 */
function ensureNodeIds(root: DockNode): DockNode {
  if (root.kind === 'panel') return root;
  if (root.kind === 'tabs') {
    return {
      ...root,
      children: root.children.map((c) => ensureNodeIds(c) as PanelNode),
    };
  }
  return {
    ...root,
    id: root.id ?? '__root__',
    children: root.children.map((c) => ensureNodeIds(c)),
  };
}

/** 移除某 panel 从树中，返回新根与是否真的移除了 */
export function removePanel(root: ContainerNode, panelId: string): ContainerNode | undefined {
  function walk(node: DockNode): { node: DockNode; removed: PanelNode | undefined } {
    if (node.kind === 'tabs') {
      const idx = node.children.findIndex((c) => c.id === panelId);
      if (idx >= 0) {
        const removed = node.children[idx];
        const next = node.children.filter((_, i) => i !== idx);
        if (next.length === 0) {
          return { node: undefined as unknown as DockNode, removed };
        }
        const active = Math.min(node.active, next.length - 1);
        return { node: { ...node, children: next, active }, removed };
      }
      let changed = false;
      const newChildren: PanelNode[] = [];
      let removed: PanelNode | undefined;
      for (const c of node.children) {
        if (c.kind === 'panel') {
          newChildren.push(c);
        } else {
          const r = walk(c);
          if (r.removed) {
            removed = r.removed;
            if (r.node) newChildren.push(r.node as PanelNode);
            changed = true;
          } else {
            newChildren.push(r.node as PanelNode);
          }
        }
      }
      return { node: changed ? { ...node, children: newChildren } : node, removed };
    }
    if (node.kind === 'container') {
      const newChildren: DockNode[] = [];
      const newSizes: number[] = [];
      let removed: PanelNode | undefined;
      let anyChanged = false;
      for (let i = 0; i < node.children.length; i++) {
        const c = node.children[i];
        if (c.kind === 'panel' && c.id === panelId) {
          removed = c;
          anyChanged = true;
          continue;
        }
        if (c.kind === 'panel') {
          newChildren.push(c);
          newSizes.push(node.sizes[i]);
          continue;
        }
        const r = walk(c);
        if (r.removed) {
          removed = r.removed;
          // 子节点容器被清空时跳过
          if (r.node && (r.node.kind === 'tabs' ? (r.node as TabsNode).children.length > 0 : true)) {
            newChildren.push(r.node);
            newSizes.push(node.sizes[i]);
          }
          anyChanged = true;
        } else {
          newChildren.push(r.node);
          newSizes.push(node.sizes[i]);
        }
      }
      // 重新归一化 sizes
      const sum = newSizes.reduce((s, v) => s + v, 0);
      const sizes = sum > 0 ? newSizes.map((v) => v / sum) : newSizes.map(() => 1 / Math.max(1, newSizes.length));
      if (!anyChanged) return { node, removed };
      if (newChildren.length === 0) return { node: undefined as unknown as DockNode, removed };
      return { node: { ...node, children: newChildren, sizes }, removed };
    }
    return { node, removed: undefined };
  }
  const r = walk(root);
  if (!r.removed) return undefined;
  if (!r.node) return undefined;
  return r.node as ContainerNode;
}

/** 修改 splitter 比例：sizes 总和必须等于目标总长（通常 = 1）。 */
export function resizeContainer(
  root: ContainerNode,
  containerId: string,
  sizes: number[],
): ContainerNode | undefined {
  function walk(node: DockNode): DockNode {
    if (node.kind === 'panel') return node;
    if (node.kind === 'tabs') {
      return { ...node, children: node.children.map((c) => (c.kind === 'panel' ? c : walk(c) as PanelNode)) };
    }
    if (node.id === containerId) {
      if (sizes.length !== node.children.length) return node;
      const sum = sizes.reduce((s, v) => s + v, 0);
      const normalized = sum > 0 ? sizes.map((v) => v / sum) : sizes.map(() => 1 / sizes.length);
      return { ...node, sizes: normalized };
    }
    return {
      ...node,
      children: node.children.map((c) => (c.kind === 'panel' ? c : walk(c))),
    };
  }
  return walk(root) as ContainerNode;
}

/** 把 panel 从树中拆出（返回新根 + 拆出的 panel） */
export function detachPanel(root: ContainerNode, panelId: string): { root: ContainerNode; panel: PanelNode } | undefined {
  const removed = removePanel(root, panelId);
  if (!removed) return undefined;
  // 找到被移除的面板（用 findPanelPath 走老根）
  const found = findPanelPath(root, panelId);
  if (!found) return undefined;
  return { root: removed, panel: found.node };
}

/** 停靠浮动面板到目标位置；返回新根 */
export function dockPanel(
  root: ContainerNode,
  panel: PanelNode,
  target: MoveTarget,
): ContainerNode {
  const targetNode = findContainerById(root, target.containerId);
  if (!targetNode) return root;

  if (targetNode.kind === 'tabs') {
    if (target.position === 'inside') {
      // 合并到目标 tabs
      const tabs: TabsNode = {
        ...targetNode,
        children: [...targetNode.children, panel],
        active: targetNode.children.length,
      };
      return replaceNode(root, targetNode as unknown as DockNode, tabs) as ContainerNode;
    }
    // before/after 视为在 tabs 父容器里前后插入新 tabs
    return insertIntoContainer(root, targetNode, panel, target.position === 'before' ? 'before' : 'after');
  }

  // container
  if (target.position === 'inside') {
    // 在容器内新建一个 tabs 装这个 panel（与现有 children 平级）
    const newTabs: TabsNode = {
      kind: 'tabs',
      id: `tabs-${panel.id}-${Date.now().toString(36)}`,
      active: 0,
      children: [panel],
    };
    return insertIntoContainer(root, targetNode, newTabs, 'inside');
  }
  return insertIntoContainer(root, targetNode, panel, target.position === 'before' ? 'before' : 'after');
}

/** 替换树中等价节点（按引用相等）；递归下钻（tabs 可嵌在任意层级的 container 里）；返回新根。 */
function replaceNode(root: DockNode, target: DockNode, next: DockNode): DockNode {
  if (root === target) return next;
  if (root.kind === 'panel') return root;
  if (root.kind === 'tabs') {
    return {
      ...root,
      children: root.children.map((c) => (c === target ? next : c)) as PanelNode[],
    };
  }
  return {
    ...root,
    children: root.children.map((c) => (c === target ? next : replaceNode(c, target, next))),
  };
}

/** 在容器内插入子节点：before/after 插入兄弟；inside 追加为新 tabs（如果是 panel）。 */
function insertIntoContainer(
  root: ContainerNode,
  target: ContainerNode | TabsNode,
  child: DockNode,
  mode: 'before' | 'after' | 'inside',
): ContainerNode {
  function walk(node: DockNode): DockNode {
    if (node.kind === 'panel') return node;
    if (node.kind === 'tabs') {
      // tabs 不直接是容器——它的父级容器来处理
      return {
        ...node,
        children: node.children.map((c) => (c.kind === 'panel' ? c : walk(c) as PanelNode)),
      };
    }
    // container
    if (node === target) {
      // 目标容器自身（含 '__root__'）：直接把 child 插入本容器
      const children = [...node.children];
      let sizes = [...node.sizes];
      if (mode === 'before' && children.length > 0) {
        children.unshift(child);
        sizes.unshift(sizes[0] / 2);
        sizes[1] = sizes[1] / 2;
      } else {
        // inside / after：追加到末尾
        children.push(child);
        const total = sizes.reduce((s, v) => s + v, 0);
        sizes = total > 0 ? sizes.map((v) => v / 2) : [...sizes];
        sizes.push(total > 0 ? total / 2 : 1);
      }
      const sum = sizes.reduce((s, v) => s + v, 0);
      return {
        ...node,
        children,
        sizes: sum > 0 ? sizes.map((v) => v / sum) : sizes.map(() => 1 / Math.max(1, sizes.length)),
      };
    }
    // 在 children 中找 target（target 可能是本容器的直接子节点）
    let idx = -1;
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i] === target) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      const before = node.children.slice(0, idx);
      const after = node.children.slice(idx + 1);
      const newChildren: DockNode[] = [...before];
      if (mode === 'inside') {
        // inside：新 child 与目标并排（目标保留，新 child 插在目标前）
        newChildren.push(child);
        newChildren.push(node.children[idx]);
      } else if (mode === 'before') {
        newChildren.push(child);
        newChildren.push(node.children[idx]);
      } else {
        newChildren.push(node.children[idx]);
        newChildren.push(child);
      }
      newChildren.push(...after);
      const sizes = redistributeSizes(node.sizes, idx, mode);
      return { ...node, children: newChildren, sizes };
    }
    return {
      ...node,
      children: node.children.map((c) => (c.kind === 'panel' ? c : walk(c))),
    };
  }
  return walk(root) as ContainerNode;
}

/** 在容器某 idx 前后插入新子节点时重分配 sizes：均分原 idx 的空间给两个位置。 */
function redistributeSizes(sizes: number[], idx: number, mode: 'before' | 'after' | 'inside'): number[] {
  const out = [...sizes];
  if (mode === 'inside') {
    // inside：均分原 idx 给原 child + 新 child
    const half = out[idx] / 2;
    out.splice(idx, 1, half, half);
  } else {
    // before / after：从原 idx 借一半给新位置
    const half = out[idx] / 2;
    const remainder = out[idx] - half;
    if (mode === 'before') {
      out.splice(idx, 1, half, remainder);
    } else {
      out.splice(idx, 1, remainder, half);
    }
  }
  // 重新归一化（避免浮点漂移）
  const sum = out.reduce((s, v) => s + v, 0);
  return sum > 0 ? out.map((v) => v / sum) : out.map(() => 1 / out.length);
}

/** 切换 tabs 的 active index */
export function setActiveTab(root: ContainerNode, tabsId: string, active: number): ContainerNode {
  function walk(node: DockNode): DockNode {
    if (node.kind === 'panel') return node;
    if (node.kind === 'tabs') {
      if (node.id === tabsId) {
        return { ...node, active: Math.max(0, Math.min(active, node.children.length - 1)) };
      }
      return {
        ...node,
        children: node.children.map((c) => (c.kind === 'panel' ? c : walk(c) as PanelNode)),
      };
    }
    return {
      ...node,
      children: node.children.map((c) => (c.kind === 'panel' ? c : walk(c))),
    };
  }
  return walk(root) as ContainerNode;
}

/** 添加 panel 到指定 tabs */
export function addPanel(
  root: ContainerNode,
  panel: PanelNode,
  tabsId: string,
  makeActive = true,
): ContainerNode {
  function walk(node: DockNode): DockNode {
    if (node.kind === 'panel') return node;
    if (node.kind === 'tabs') {
      if (node.id === tabsId) {
        const children = [...node.children, panel];
        return { ...node, children, active: makeActive ? children.length - 1 : node.active };
      }
      return {
        ...node,
        children: node.children.map((c) => (c.kind === 'panel' ? c : walk(c) as PanelNode)),
      };
    }
    return {
      ...node,
      children: node.children.map((c) => (c.kind === 'panel' ? c : walk(c))),
    };
  }
  return walk(root) as ContainerNode;
}

/** 重命名 panel */
export function renamePanel(root: ContainerNode, panelId: string, title: string): ContainerNode {
  function walk(node: DockNode): DockNode {
    if (node.kind === 'panel') {
      return node.id === panelId ? { ...node, title } : node;
    }
    if (node.kind === 'tabs') {
      return {
        ...node,
        children: node.children.map((c) => {
          if (c.kind === 'panel') return c.id === panelId ? { ...c, title } : c;
          return walk(c) as PanelNode;
        }),
      };
    }
    return {
      ...node,
      children: node.children.map((c) => (c.kind === 'panel' ? c : walk(c))),
    };
  }
  return walk(root) as ContainerNode;
}

/** 在树中遍历所有 panel id（顺序：DFS） */
export function collectPanelIds(node: DockNode): string[] {
  const out: string[] = [];
  function walk(n: DockNode): void {
    if (n.kind === 'panel') {
      out.push(n.id);
      return;
    }
    if (n.kind === 'tabs') {
      for (const c of n.children) walk(c);
      return;
    }
    for (const c of n.children) walk(c);
  }
  walk(node);
  return out;
}

/** 给节点注入 id（用于序列化前的稳定 id）。返回新根（不可变）。 */
export function assignNodeIds(root: ContainerNode): ContainerNode {
  return ensureNodeIds(root) as ContainerNode;
}
