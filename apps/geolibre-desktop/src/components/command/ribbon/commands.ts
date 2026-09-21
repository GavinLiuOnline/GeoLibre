/*
  ribbon/commands —— Ribbon 命令注册表（自 gis-full editor/ui/ribbon/commands.ts 移植）

  设计原则（保持原设计）：
  - **集中注册**：所有 Ribbon 命令由 buildRibbonCommands() 返回，UI 模板只渲染不写逻辑；
  - **完整性可测**：ribbon-commands.test.ts 断言「既有功能入口无损迁移」；
  - **平台分支**：isElectronAvailable 决定是否插入「桌面原生」入口
    （gis-full 的 Electron 桥 → GeoLibre 对应 Phase 4 的 Tauri 原生目录选择）；
  - **窄宽度折叠**：UI 层基于命令的 `primary: false` 自动收纳到「更多」下拉；
  - **键盘可达**：命令声明 shortcut（如「Ctrl+S」）由 Shell 绑定全局快捷键。

  GeoLibre 适配说明：
  - 原依赖的 `editorStore` 类型（ToolKind / ProjectPackageTab / GenerateCacheTab）
  改为本模块内联定义，注册表不依赖任何 store —— 运行上下文（RibbonContext）
  由 Shell（TopToolbar）注入，未接入的功能以 pending 提示兜底。
*/

/** Ribbon 选项卡 id */
export type RibbonTabId = 'file' | 'data' | 'cache' | 'publish' | 'view' | 'tools' | 'help';

/** gis-full editorStore 的工具种类（原样保留；Phase 4 绘制交互接入后生效） */
export type ToolKind = 'draw-point' | 'draw-line' | 'draw-polygon' | 'select-rect' | 'edit-vertex' | 'pick' | 'pan';

/** 工程包对话框页签 */
export type ProjectPackageTab = 'import' | 'export';

/** 生成缓存对话框页签 */
export type GenerateCacheTab = '2d' | '3d';

/** 命令运行上下文（store 函数 + 工具态 setter） */
export interface RibbonContext {
  openDialog(key: 'import' | 'reprojection' | 'optimizer' | 'publish' | 'settings'): void;
  openBasemapDialog(): void;
  openHostDirectoryDialog(): void;
  openServiceListDialog(): void;
  openUrlImportDialog(): void;
  openSceneListDialog(): void;
  openProjectPackage(tab: ProjectPackageTab): void;
  openGenerateCache(tab: GenerateCacheTab): void;
  openRegionCache(): void;
  openAboutDialog(): void;
  pickAndOpenScene(): void;
  saveToServer(): Promise<void>;
  downloadScene(): void;
  newScene(): void;
  setTool(tool: ToolKind): void;
  setView(mode: '3D' | '2D' | 'Columbus'): void;
  cycleBasemap(): void;
  flipTheme(): void;
  pickLocalCacheDir(kind: 'xyz' | '3dtiles'): void;
  pickDesktopNativeDir?(): void;
  /** 视图页：恢复 Dock 面板默认布局 */
  resetLayout(): void;
  isElectronAvailable: boolean;
}

/** 单条命令 */
export interface RibbonCommand {
  id: string;
  tab: RibbonTabId;
  group: string;
  /** 显示标签（命令面板/aria） */
  label: string;
  /** 图标（内联 SVG path 或 emoji 字符） */
  icon: string;
  /** 简短提示 */
  hint?: string;
  /** 全局快捷键展示（实际快捷键仍由 Shell 绑定） */
  shortcut?: string;
  /** 主命令 → 显示在 Ribbon 主区；非主 → 收进「更多」下拉 */
  primary?: boolean;
  /** 在窄宽度下一律收纳（避免窄屏挤压） */
  overflowOnly?: boolean;
  /** 桌面专属（仅在桌面端可见） */
  electronOnly?: boolean;
  /** 当前不可用（保留渲染位但置灰） */
  disabled?: boolean;
  /** 命令执行（参数为运行上下文） */
  run: (ctx: RibbonContext) => void;
}

/** 一组命令（同选项卡内的相邻命令；模板渲染分隔线） */
export interface RibbonGroup {
  id: string;
  label: string;
  commands: RibbonCommand[];
}

/** 一个选项卡 */
export interface RibbonTab {
  id: RibbonTabId;
  label: string;
  groups: RibbonGroup[];
}

// ---------------------------------------------------------------------------
// 内联 SVG 库（统一描边 1.5px；保持体积小，替代图标库）
// ---------------------------------------------------------------------------

/**
 * 图标：24×24 viewBox，stroke=currentColor，stroke-width=1.5，
 * 无填充（fill="none"），stroke-linecap/linejoin=round。
 */
const ICONS = {
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 14h8"/>',
  upload: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 17v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3"/>',
  download: '<path d="M12 21V9"/><path d="m7 16 5 5 5-5"/><path d="M5 5v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5"/>',
  package: '<path d="M12 3 3 7v10l9 4 9-4V7z"/><path d="M3 7l9 4 9-4"/><path d="M12 11v10"/>',
  import: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 1 0-1.5-8.7A6 6 0 0 0 5 12a4 4 0 0 0 0 7z"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  map: '<path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14"/><path d="M15 6v14"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
  pin: '<path d="M12 22s7-7.5 7-13a7 7 0 1 0-14 0c0 5.5 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/>',
  edit: '<path d="M14 4 20 10 9 21H3v-6z"/><path d="m13 5 6 6"/>',
  cube: '<path d="m12 3 9 5v8l-9 5-9-5V8z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v10"/>',
  square: '<path d="m9 4 6 0 6 6 0 10a2 2 0 0 1 -2 2l-10 0a2 2 0 0 1 -2 -2l0 -14a2 2 0 0 1 2 -2z"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  brush: '<path d="M3 21c4-2 6-7 14-15l3 3C12 17 7 19 5 23z"/><path d="m14 6 3 3"/>',
  compress: '<path d="M3 8 8 3l5 5M3 16l5 5 5-5"/><path d="m21 8-5-5-5 5"/><path d="m21 16-5 5-5-5"/>',
  expand: '<path d="M3 8 8 3l5 5"/><path d="M21 8l-5-5-5 5"/><path d="M3 16l5 5 5-5"/><path d="m21 16-5 5-5-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M11 12h1v5h1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  close: '<path d="m6 6 12 12"/><path d="m18 6-12 12"/>',
  check: '<path d="m4 12 6 6L20 6"/>',
  send: '<path d="m4 12 16-8-6 18-3-7-7-3z"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  point: '<circle cx="12" cy="12" r="3"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3"/>',
  polyline: '<path d="M3 18 8 6l5 8 8-12"/>',
  polygon: '<path d="m4 8 8-4 8 4-3 10H7z"/>',
  cursor: '<path d="m4 4 6 16 3-7 7-3z"/>',
  hand: '<path d="M7 11V6a1.5 1.5 0 1 1 3 0v5"/><path d="M10 11V4a1.5 1.5 0 1 1 3 0v7"/><path d="M13 11V6a1.5 1.5 0 1 1 3 0v6"/><path d="M16 11V8a1.5 1.5 0 1 1 3 0v9a6 6 0 0 1-6 6h-3a6 6 0 0 1-5.3-3.2L3 16"/>',
} as const;

export type RibbonIconName = keyof typeof ICONS;

/** 命令定义使用的图标名（语义化） */
export const RibbonIcon = ICONS;

/** 内联 SVG 完整片段（供 UI 层渲染；static path 字符串，无用户输入） */
export function ribbonIconSvg(name: string): string {
  const body = RibbonIcon[name as RibbonIconName];
  return body
    ? `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>${body}</svg>`
    : '';
}

// ---------------------------------------------------------------------------
// 命令注册表（按 tab → group → command 组织）
// ---------------------------------------------------------------------------

/** 「文件」选项卡：场景/工程包/本地下载 */
const fileGroups: RibbonGroup[] = [
  {
    id: 'scene',
    label: '场景',
    commands: [
      { id: 'scene.new', tab: 'file', group: 'scene', label: '新建', icon: 'file', shortcut: 'Ctrl+N', primary: true, run: (c) => c.newScene() },
      { id: 'package.import', tab: 'file', group: 'scene', label: '打开…', icon: 'package', primary: true, hint: '打开工程包（场景 + 缓存 + 资产）', run: (c) => c.openProjectPackage('import') },
      { id: 'scene.open-server', tab: 'file', group: 'scene', label: '从服务端打开…', icon: 'cloud', run: (c) => c.openSceneListDialog() },
    ],
  },
  {
    id: 'save',
    label: '保存',
    commands: [
      { id: 'package.export', tab: 'file', group: 'save', label: '保存…', icon: 'upload', hint: '导出工程包（场景 + 缓存 + 资产）', run: (c) => c.openProjectPackage('export') },
      { id: 'scene.save', tab: 'file', group: 'save', label: '保存到服务端', icon: 'save', shortcut: 'Ctrl+S', primary: true, run: (c) => { void c.saveToServer(); } },
    ],
  },
];

/** 「数据」选项卡：导入 / 本地缓存 / 服务端托管 / 生成 / 配准 / 轻量化 */
const dataGroups: RibbonGroup[] = [
  {
    id: 'import',
    label: '导入',
    commands: [
      { id: 'data.import', tab: 'data', group: 'import', label: '导入数据…', icon: 'import', primary: true, run: (c) => c.openDialog('import') },
    ],
  },
  {
    id: 'cache-local',
    label: '本地缓存',
    commands: [
      { id: 'data.import-xyz-dir', tab: 'data', group: 'cache-local', label: 'XYZ 缓存目录…', icon: 'grid', primary: true, run: (c) => c.pickLocalCacheDir('xyz') },
      { id: 'data.import-3dtiles-dir', tab: 'data', group: 'cache-local', label: '3D Tiles 缓存目录…', icon: 'cube', primary: true, run: (c) => c.pickLocalCacheDir('3dtiles') },
      {
        id: 'data.import-desktop-native',
        tab: 'data',
        group: 'cache-local',
        label: '本机瓦片目录（桌面原生）',
        icon: 'server',
        primary: true,
        electronOnly: true,
        hint: '原生目录选择 + 有界扫描 + 模板懒加载：无文件数上限',
        run: (c) => c.pickDesktopNativeDir?.(),
      },
      { id: 'data.import-url', tab: 'data', group: 'cache-local', label: 'XYZ 缓存（URL / file://）…', icon: 'globe', run: (c) => c.openUrlImportDialog() },
      { id: 'data.host-directory', tab: 'data', group: 'cache-local', label: '引用本机瓦片目录（服务端托管）…', icon: 'cloud', hint: 'GB 级缓存推荐路径', run: (c) => c.openHostDirectoryDialog() },
    ],
  },
  {
    id: 'cache-generate',
    label: '生成缓存',
    commands: [
      { id: 'data.gen-3d', tab: 'data', group: 'cache-generate', label: '三维模型 → 3D Tiles…', icon: 'cube', primary: true, run: (c) => c.openGenerateCache('3d') },
      { id: 'data.gen-2d', tab: 'data', group: 'cache-generate', label: '矢量 → XYZ 缓存…', icon: 'grid', primary: true, run: (c) => c.openGenerateCache('2d') },
      { id: 'data.gen-region', tab: 'data', group: 'cache-generate', label: '框选区域 → XYZ…', icon: 'rect', run: (c) => c.openRegionCache() },
    ],
  },
  {
    id: 'transform',
    label: '配准 / 轻量化',
    commands: [
      { id: 'data.reprojection', tab: 'data', group: 'transform', label: '坐标配准…', icon: 'compress', run: (c) => c.openDialog('reprojection') },
      { id: 'data.optimizer', tab: 'data', group: 'transform', label: '数据轻量化…', icon: 'compress', run: (c) => c.openDialog('optimizer') },
    ],
  },
];

/** 「缓存」选项卡：服务管理 / 服务发布 */
const cacheGroups: RibbonGroup[] = [
  {
    id: 'services',
    label: '服务',
    commands: [
      { id: 'cache.services', tab: 'cache', group: 'services', label: '服务管理…', icon: 'server', primary: true, run: (c) => c.openServiceListDialog() },
      { id: 'cache.host-dir', tab: 'cache', group: 'services', label: '引用本机瓦片目录（服务端托管）…', icon: 'cloud', run: (c) => c.openHostDirectoryDialog() },
    ],
  },
];

/** 「发布」选项卡：发布到服务端 */
const publishGroups: RibbonGroup[] = [
  {
    id: 'publish',
    label: '发布',
    commands: [
      { id: 'publish.oneclick', tab: 'publish', group: 'publish', label: '一键发布…', icon: 'send', primary: true, hint: '场景 + 缓存 + 资产打包上传', run: (c) => c.openDialog('publish') },
    ],
  },
];

/** 「视图」选项卡：3D/2D/CV + 底图 */
const viewGroups: RibbonGroup[] = [
  {
    id: 'view-mode',
    label: '视图模式',
    commands: [
      { id: 'view.3d', tab: 'view', group: 'view-mode', label: '3D 视图', icon: 'cube', primary: true, run: (c) => c.setView('3D') },
      { id: 'view.2d', tab: 'view', group: 'view-mode', label: '2D 视图', icon: 'map', primary: true, run: (c) => c.setView('2D') },
      { id: 'view.cv', tab: 'view', group: 'view-mode', label: 'CV（哥伦布）', icon: 'grid', run: (c) => c.setView('Columbus') },
    ],
  },
  {
    id: 'basemap',
    label: '底图',
    commands: [
      { id: 'view.basemap-cycle', tab: 'view', group: 'basemap', label: '切换底图', icon: 'globe', primary: true, run: (c) => c.cycleBasemap() },
      { id: 'view.basemap-mgr', tab: 'view', group: 'basemap', label: '底图管理…', icon: 'layers', run: (c) => c.openBasemapDialog() },
    ],
  },
  {
    id: 'layout',
    label: '布局',
    commands: [
      {
        id: 'view.reset-layout',
        tab: 'view',
        group: 'layout',
        label: '重置默认布局',
        icon: 'refresh',
        hint: '恢复 Dock 面板默认布局（图层 / 属性 / 工具 / 查询 / 输出窗）',
        run: (c) => c.resetLayout(),
      },
    ],
  },
];

/** 「工具」选项卡：绘制 / 编辑 / 框选 / 拾取 / 设置 / 主题 */
const toolsGroups: RibbonGroup[] = [
  {
    id: 'draw',
    label: '绘制',
    commands: [
      { id: 'tool.draw-point', tab: 'tools', group: 'draw', label: '绘制点', icon: 'point', primary: true, run: (c) => c.setTool('draw-point') },
      { id: 'tool.draw-line', tab: 'tools', group: 'draw', label: '绘制折线', icon: 'polyline', primary: true, run: (c) => c.setTool('draw-line') },
      { id: 'tool.draw-polygon', tab: 'tools', group: 'draw', label: '绘制多边形', icon: 'polygon', primary: true, run: (c) => c.setTool('draw-polygon') },
      { id: 'tool.rect-select', tab: 'tools', group: 'draw', label: '矩形框选', icon: 'rect', hint: '用于生成 XYZ 缓存', run: (c) => c.setTool('select-rect') },
    ],
  },
  {
    id: 'edit',
    label: '编辑',
    commands: [
      { id: 'tool.vertex-edit', tab: 'tools', group: 'edit', label: '顶点编辑', icon: 'pin', primary: true, run: (c) => c.setTool('edit-vertex') },
      { id: 'tool.pick', tab: 'tools', group: 'edit', label: '拾取要素', icon: 'cursor', primary: true, run: (c) => c.setTool('pick') },
      { id: 'tool.pan', tab: 'tools', group: 'edit', label: '漫游', icon: 'hand', shortcut: 'Esc', primary: true, run: (c) => c.setTool('pan') },
    ],
  },
  {
    id: 'settings',
    label: '设置',
    commands: [
      { id: 'tool.settings', tab: 'tools', group: 'settings', label: '设置…', icon: 'gear', primary: true, run: (c) => c.openDialog('settings') },
      { id: 'tool.theme', tab: 'tools', group: 'settings', label: '切换主题', icon: 'refresh', hint: '深色/亮色', run: (c) => c.flipTheme() },
    ],
  },
];

/** 「帮助」选项卡：关于 */
const helpGroups: RibbonGroup[] = [
  {
    id: 'help',
    label: '关于',
    commands: [
      { id: 'help.about', tab: 'help', group: 'help', label: '关于…', icon: 'info', primary: true, run: (c) => c.openAboutDialog() },
    ],
  },
];

/** 完整的 Ribbon 选项卡序列（顺序即 UI 渲染顺序） */
export const RIBBON_TABS: RibbonTab[] = [
  { id: 'file', label: '文件', groups: fileGroups },
  { id: 'data', label: '数据', groups: dataGroups },
  { id: 'cache', label: '缓存', groups: cacheGroups },
  { id: 'publish', label: '发布', groups: publishGroups },
  { id: 'view', label: '视图', groups: viewGroups },
  { id: 'tools', label: '工具', groups: toolsGroups },
  { id: 'help', label: '帮助', groups: helpGroups },
];

/**
 * 构造完整的 Ribbon 选项卡（过滤桌面专属 / 禁用命令）。
 * 设计：把命令注册与平台分支隔离，UI 层只关心渲染。
 */
export function buildRibbonCommands(ctx: Pick<RibbonContext, 'isElectronAvailable'>): RibbonTab[] {
  return RIBBON_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    groups: tab.groups.map((group) => ({
      id: group.id,
      label: group.label,
      commands: group.commands.filter((cmd) => {
        if (cmd.electronOnly && !ctx.isElectronAvailable) return false;
        if (cmd.disabled) return false;
        return true;
      }),
    })).filter((g) => g.commands.length > 0),
  })).filter((t) => t.groups.length > 0);
}

/** 收集所有命令 id（用于完整性单测） */
export function collectCommandIds(): string[] {
  const ids: string[] = [];
  for (const tab of RIBBON_TABS) {
    for (const group of tab.groups) {
      for (const cmd of group.commands) {
        ids.push(cmd.id);
      }
    }
  }
  return ids;
}

/** 由 commandId 反查命令（用于快捷键绑定 / 编程触发） */
export function findCommand(id: string): RibbonCommand | undefined {
  for (const tab of RIBBON_TABS) {
    for (const group of tab.groups) {
      const cmd = group.commands.find((c) => c.id === id);
      if (cmd) return cmd;
    }
  }
  return undefined;
}
