# gis-full → GeoLibre 融合实施方案

> 决策已确认（2026-09）：**编辑器 UI 用 React 19 重写**、**桌面端统一 Tauri v2**、**旧仓归档、按模块移植（不带 git 历史）**。
> 本文档是迁移的唯一起草稿，落地后随各 Phase 更新进度勾选。

## 0. 源仓资产盘点（gis-full @ a6a19e3）

| 模块 | 规模 | 技术形态 | 与 GeoLibre 的关系 |
|---|---|---|---|
| `editor/src/core/` | ~30 文件 | **纯 TS，无 UI 依赖**（SceneManager / LayerManager / serverSync / basemap / drawGeometry / geojsonEdit / scale） | 高价值，直接移植 |
| `editor/src/core/importer/` | 6 文件 | 纯 TS（CSV / KML / TopoJSON / 统一入口，依赖 @tmcw/togeojson、topojson-client） | 直接移植 |
| `editor/src/core/optimizer/` | 8 文件 | 纯 TS（douglasPeucker / geojsonOptimizer / **glbOptimizer**（gltf-transform + meshoptimizer）） | 直接移植，GeoLibre 独有 |
| `editor/src/core/reprojection/` | 4 文件 | 纯 TS（proj4 crsRegistry / transform） | 直接移植，GeoLibre 独有 |
| `editor/src/core/localCache/` | ~10 文件 | 纯 TS（XYZ 缓存 bounds / crs / detect / exportCache） | 直接移植 |
| `editor/src/stores/` | ~12 文件 | **Pinia store（Vue 耦合）** | 逻辑抽取后用 GeoLibre 状态方案重写 |
| `editor/src/ui/` | ~20 组件 | **Vue 3 SFC**（Ribbon / Dock / LayerPanel / PropertyPanel / StyleEditor / dialogs…） | **React 重写**（核心工作量） |
| `editor/electron/` | 4 文件 | Electron 主进程 / preload / **xyzDisk.ts**（磁盘缓存扫描导入导出，36 单测） | fs 逻辑移植 + Tauri command 化 |
| `packages/shared/src/` | 4 文件 | 纯 TS（types / api-client / scene） | 直接移植 |
| `server/src/` | 17 文件 | Node GIS 服务端（routes / services / util，:8080，含 /admin） | Node sidecar 整体搬迁 |
| 测试 | 727 用例 | **vitest** | 迁到 GeoLibre 的 `node --import tsx --test` |

## 1. 目标架构映射

```
GeoLibre/
├─ apps/geolibre-desktop/          # React 19 主应用（编辑器能力重写进这里）
│  └─ src/features/gis-editor/     # ← 新增：编辑器功能区（React）
├─ packages/processing/            # ← reprojection / optimizer / importers 并入
├─ packages/xyz-cache/             # ← 新包：XYZ 磁盘缓存（fs 逻辑 + Storage 接口抽象）
├─ packages/gis-shared/            # ← shared（types / api-client / scene）
├─ services/gis-server/            # ← server/（Node sidecar，与 Python sidecar 并列）
├─ apps/geolibre-desktop/src-tauri/# ← Tauri commands：文件对话框 / 本地瓦片目录扫描
└─ backend/geolibre_server/        # 不动（Python 侧各司其职）
```

**原则**：纯算法进 `packages/*`（零框架依赖）；UI 一律 React；本地文件能力走 Tauri API；服务能力走 sidecar；Python 后端不动。

**仓内硬约定（CLAUDE.md）**：
- **store 驱动、单向数据流**：`@geolibre/core` 的 Zustand store 是唯一事实源；编辑器 UI 只改 store，由 `MapController.syncLayers` / `CesiumCanvas` 的 sync 机制生效，**禁止从 UI 直接操作地图实例**。
- 渲染主线是 MapLibre GL JS + deck.gl；Cesium 走 `packages/map` 的 globe 模式（`CesiumCanvas` / `cesium-layer-sync` / `feature-selection`），编辑器功能挂接 globe 模式，不另起 Viewer。
- 新 UI 字符串必须走 **react-i18next**（`en.json` 为源），样式用 Tailwind 逻辑属性（`ms-`/`me-`/`ps-`/`pe-`）以兼容 RTL。
- 新外部瓦片/样式主机需加入 Tauri CSP allowlist。
- **不直接提交 main**：本计划全程在 `feat/gis-full-integration` 分支以小 PR 推进。

## 2. 阶段计划

### Phase 0 — 基线与归档（0.5 天）
- [ ] gis-full 打 `archive/v0.1.1` tag；GitHub Settings → Archive 仓库；README 顶部加「已并入 GeoLibre」指针
- [x] GeoLibre 建长期分支 `feat/gis-full-integration`（所有 Phase 的 PR 都进它，最后一次性合 master）

### Phase 1 — 纯算法移植（2-3 天，可先独立 PR）
| 源 | 目标 | 要点 |
|---|---|---|
| `core/reprojection/` | `packages/processing/src/reprojection/` | proj4 加进 processing 依赖 |
| `core/optimizer/` | `packages/processing/src/optimizer/` | gltf-transform + meshoptimizer 依赖；GLB 轻量化是 GeoLibre 缺失能力 |
| `core/importer/` | `packages/processing/src/importers/` | @tmcw/togeojson、topojson-client |
| `core/localCache/` + `electron/xyzDisk.ts` | `packages/xyz-cache/` | **fs 调用抽象成 `CacheStorage` 接口**：Node 实现直用 `node:fs`；Tauri 实现走 command。36 个单测随迁 |
| `packages/shared/src/` | `packages/gis-shared/` | api-client 指向 sidecar :8080 |

**测试迁移**：vitest → `node --import tsx --test`（GeoLibre 根 `tests/` 约定）；`describe/it/expect` → `node:test` + `node:assert/strict`，机械替换可脚本化。

**验收**：`npm run ci` 全绿；移植算法单测数 ≥ 原用例数（727 中纯逻辑部分）。

**进度**：
- [x] Slice A（`71989f7f`）：processing 移植（reprojection / optimizer / importers）+ `@geolibre/gis-shared`
- [x] Slice B：`packages/xyz-cache`（`CacheStorage` 接口 + Node 实现，22 个源文件）+ `tests/` 19 个移植测试文件（vitest → node:test，332 用例全绿，eslint/tsc 零错误）

### Phase 2 — 编辑器 React 重写（2-4 周，核心工作量）
按依赖顺序拆 5 个 PR：
1. **Ribbon 命令系统** ✅：`apps/geolibre-desktop/src/components/command/ribbon/`（注册表 38 条命令 + React 渲染组件 + TopToolbar 接线 + `tests/ribbon-commands.test.ts` 8 用例；服务端/绘制等未接入入口以提示兜底，随后续 PR 消除）
2. **Dock 面板框架** ✅：`packages/core/src/dock/`（layout-model 纯函数 788 行原样移植 + Zustand `useDockStore` 并入 @geolibre/core，localStorage 持久化）+ `apps/geolibre-desktop/src/components/dock/DockPanel.tsx`（splitter 拖拽/标签组/浮动窗口 React 重写）+ 17 个单测；Ribbon「重置默认布局」已接真实动作。PR3 起填充真实面板内容并挂载
3. **图层面板 + 属性面板 + 样式编辑器** ✅（PR3 采纳「不重复造」路线）：Dock 框架以可选覆盖层挂载（Ribbon 视图页「Dock 编辑器布局」切换，默认关闭、地图交互不受影响），图层页签承载 geolibre 既有 `LayerPanel` 全功能；属性/工具/查询/输出为占位，PR4/PR5 填充。样式编辑复用既有 style panel（不重建）
4. **绘制与几何编辑** ✅（PR4）——按「不重复造」落地：绘制点/线/面复用既有 `FieldCollectionDialog`；顶点编辑复用既有图层几何编辑会话（选中图层 → 开始/保存/取消）；`drawGeometry`/`geojsonEdit` 纯逻辑移植至 `@geolibre/core`（`editing/`，29 用例）。全屏 Cesium 顶点手柄交互层（ScreenSpaceEventHandler）与拾取/框选随 Cesium 深度集成后续评估，避免与既有选择系统（按表达式/按位置）重复
5. **缓存/配准/发布面板** ✅（PR5）——按「不重复造」落地：① 坐标重投影对话框（CRS 注册表 + proj4 transformGeoJSON，纯客户端，结果入新图层）；② XYZ 缓存生成对话框双模式（矢量渲染 generateXyzFromGeoJSON / 底图区域抓取 generateXyzFromRegion，zip 打包下载，进度条）；③ 服务管理/托管目录已接真服务端（GIS 服务管理对话框：连接 services/gis-server、服务注册表、托管本机瓦片目录免上传发布、场景列表，XYZ 托管 URL 可直接粘进「添加数据→XYZ URL」加载）；3D Tiles 生成与一键发布待后续（发布需工程→SceneDocument 转换器）；处理历史/输出面板已在 PR3 接真数据

**验收**：原编辑器五大功能链路（导入 → 配准 → 编辑 → 轻量化 → 发布）在 geolibre-desktop 内全部可用；全部新 UI 字符串入 i18n catalog；Playwright e2e 各加一条冒烟。

### Phase 3 — Node GIS sidecar ✅
- [x] `server/` → `services/gis-server/`；npm workspaces 加 `services/*`（构建 esbuild 单文件打包，内联 @geolibre/gis-shared；73 服务端用例全绿，/admin 与场景/服务 API 冒烟通过）
- [ ] docker-compose 加 `gis-server` service（:8080，数据卷同 Python sidecar 风格）
- [ ] `/admin` 管理台保留 ✅（public/admin.html 随包）；docs 增补部署章节

### Phase 4 — Tauri 统一桌面（3-5 天）
- [ ] xyz-cache 的 Tauri `CacheStorage` 实现（Rust command：目录扫描 / 流式读写瓦片）
- [ ] 文件对话框 / 保存走 Tauri plugin-fs（替代 Electron IPC 的 show-save-dialog）
- [ ] release workflow 改 `tauri-build`：产物 AppImage / deb / NSIS/MSIX（Tauri 原生支持，产物面不缩水）
- [ ] 删除 Electron 相关（electron-builder.yml、xyzDisk Electron 侧、打包 CI）

### 收尾
- [ ] 旧 Electron 桌面从 CI/文档移除；gis-full 归档生效
- [ ] GeoLibre README / docs / mkdocs nav 增补「GIS 编辑器」章节

## 3. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 双渲染引擎冲突（gis-full 编辑器 Cesium 原生 vs GeoLibre「MapLibre 主线 + Cesium globe 模式」） | 高 | 编辑器功能只挂 `packages/map` globe 模式：复用 `CesiumCanvas` / `cesium-layer-sync` / `feature-selection` 抽象；core 层 Viewer 操作改注入式；数据流一律 store → sync |
| Cesium 1.145 → 1.144 小版本 API 差异 | 低 | 移植时以 1.144 跑测试，差异点记录 |
| vitest → node:test 迁移噪音大（727 用例） | 中 | 先迁纯逻辑（约一半），UI 测试随 React 重写重写为 Playwright/node:test |
| React 重写周期长、主干阻塞 | 中 | 全程走 `feat/gis-full-integration` 分支 + 小 PR；每个 PR 主干保持可用 |
| Tauri fs 能力与 Electron IPC 差异（流式大文件） | 中 | xyz-cache 接口先行（Phase 1 抽象），Tauri 实现单独验收大缓存场景 |
| npm workspaces 与 pnpm 习惯差异（无 storeDir 相对路径问题） | 低 | GeoLibre 已有成熟 CI 缓存方案，无需移植 |

## 4. 不迁移清单（明确丢弃）

- `editor/electron/main.ts` 的 Electron 窗口/IPC/preload（Tauri 取代）
- `editor/electron-builder.yml`、`electron/dev.mjs`、打包 CI（tauri-build 取代）
- Vue SFC 全部组件（React 重写）
- GIS_DESKTOP_GL GPU 兼容层（Electron 专属问题，Tauri 用系统 WKWebView/WebView2）
