# GIS 服务端（gis-server）部署与运维

`services/gis-server` 是 Node GIS sidecar（Phase 3，自 gis-full 按模块移植）：
场景 CRUD、资产上传、发布打包（`publish-package`）、本地缓存目录托管（免上传发布
GB 级瓦片）、服务注册表与 `/admin` 管理台。无数据库，全部数据落盘 `DATA_DIR`。

## 本地运行（monorepo）

```bash
npm run dev:gis     # 开发（tsx watch，端口 8080）
npm run start:gis   # 生产（esbuild 单文件产物 node dist/index.js）
npm run test:gis    # 73 个服务端用例
```

桌面端「项目 → 服务端 · 发布 → 服务管理…」默认连 `http://127.0.0.1:8080`，
地址可在对话框内修改（localStorage 持久化，键 `geolibre.gis-server.url`）。

## Docker

```bash
docker compose up -d geolibre-gis   # 宿主 8090 → 容器 8080（8080 已被 geolibre-web 占用）
curl http://127.0.0.1:8090/admin
```

镜像为两阶段构建：build 阶段跑 esbuild 打包（产物自包含，内联
`@geolibre/gis-shared` 源码与全部依赖），runtime 阶段只带
`dist/index.js + public/`，零 node_modules。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `DATA_DIR` | `./data` | 场景/资产/发布产物/注册表落盘根 |
| `AUTH_TOKEN` | 空 | 配置后写接口要求 `Authorization: Bearer <token>` |
| `AUTH_USER` | `anonymous` | Bearer 校验通过时记录的创建者 |
| `GIS_HOST_DIR_ROOTS` | 空 | 目录托管白名单（冒号分隔的绝对根）；未配置时托管接口 403 |
| `HOST_EXPOSURE_WARNING` | 自动 | 绑定非回环地址时管理台提示公网暴露风险 |

## 目录托管（免上传发布）

「服务管理 → 托管本机瓦片目录」要求目录位于 `GIS_HOST_DIR_ROOTS` 白名单内。
服务端**不复制不上传**任何文件，按注册表记录的源目录流式提供
`/tiles/<slug>/…`、`/tilesets/<slug>/…`，逐文件校验 realpath/越界/扩展名。
托管返回的 XYZ URL 模板可直接粘进桌面端「添加数据 → XYZ URL」加载。

## 与桌面端的发布链路

「一键发布」把当前 GeoLibre 工程转换为 SceneDocument（geojson 图层内嵌、
xyz/wms/wmts/vector-tiles 走 URL 引用）并 multipart POST
`/api/scenes/publish-package`，返回 `/published/<slug>/scene.json` 托管地址。
