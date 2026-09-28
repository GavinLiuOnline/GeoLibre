/**
 * GIS 服务端入口：场景 CRUD、资产上传、发布、静态托管与管理页。
 * 无数据库，全部数据落盘 data/（可用 DATA_DIR 环境变量覆盖位置）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';

import { assetsRouter } from './routes/assets.js';
import { exportsRouter } from './routes/exports.js';
import { createHostedFilesHandler } from './routes/hostedFiles.js';
import { metaRouter } from './routes/meta.js';
import { scenesRouter } from './routes/scenes.js';
import { servicesRouter } from './routes/services.js';
import { ASSETS_DIR, DATA_DIR, PUBLISHED_DIR, assertSafeSlug, ensureDataDirs } from './services/storage.js';
import { HOST_DIR_ROOTS_ENV, allowedHostRoots } from './services/hostDirectory.js';
import { restorePersistedExportJobs } from './services/exportJob.js';
import { bindDescription, hostExposureWarning, resolveBindHost } from './util/bindAddress.js';
import { HttpError } from './util/http.js';

const thisFile = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(thisFile, '..');

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = path.join(serverRoot, 'public');

ensureDataDirs();
// 重启恢复已完成导出任务的产物（下载可用）；中断/未完成任务的临时文件清理
restorePersistedExportJobs();

const app = express();
app.disable('x-powered-by');

// 全局 CORS
app.use(cors());
app.use(express.json({ limit: '200mb' }));

// 静态托管：发布包与上传资产
app.use('/published', express.static(PUBLISHED_DIR));
app.use('/assets', express.static(ASSETS_DIR));
// 目录托管（t26）：按注册表里的源目录直接提供本地瓦片 / 3D Tiles 数据集（默认关闭，
// 需 GIS_HOST_DIR_ROOTS 白名单；逐文件做 realpath + 扩展名校验）
app.use('/tiles', createHostedFilesHandler('xyz'));
app.use('/tilesets', createHostedFilesHandler('3dtiles'));

// API（meta 先注册，避免 /api/:id 抢占 /api/health、/api/published）
app.use('/api', metaRouter);
app.use('/api/scenes', scenesRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/exports', exportsRouter);

// 管理页（单 HTML + 原生 JS）
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// 3D Tiles 内置预览页（Cesium UMD CDN 加载 /published/<slug>/tileset.json）
app.get('/preview/3dtiles/:slug', (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    assertSafeSlug(slug);
    if (!fs.existsSync(path.join(PUBLISHED_DIR, slug, 'tileset.json'))) {
      throw new HttpError(404, `3D Tiles 服务不存在或缺少 tileset.json: ${slug}`);
    }
    res.sendFile(path.join(PUBLIC_DIR, 'preview-3dtiles.html'));
  } catch (err) {
    next(err);
  }
});

app.get('/', (_req, res) => res.redirect('/admin'));

// 404
app.use((req, res) => {
  res.status(404).json({ error: `Not Found: ${req.method} ${req.path}` });
});

// 统一错误处理
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  let status = 500;
  let extraHeaders: Record<string, string> | undefined;
  if (err instanceof HttpError) {
    status = err.status;
    extraHeaders = err.headers;
  } else if (err instanceof Error && err.name === 'MulterError') {
    status = 400;
  } else if (typeof (err as { status?: number })?.status === 'number') {
    status = (err as { status: number }).status;
  }
  if (status >= 500) console.error('[server] 未处理错误:', err);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
});

// 绑定地址（t28）：默认 127.0.0.1（仅本机可访问）；显式设置 GIS_HOST=0.0.0.0 才对外暴露。
// 目录托管（t26）会把「白名单内的本机目录」变成可下载资源，因此非回环绑定必须醒目告警。
const BIND_HOST = resolveBindHost();
const server = app.listen(PORT, BIND_HOST, () => {
  const roots = allowedHostRoots();
  const address = server.address();
  const actual = typeof address === 'object' && address ? `${address.address}:${address.port}` : undefined;
  const hostInfo =
    roots.length > 0
      ? `目录托管已启用（${HOST_DIR_ROOTS_ENV}）= ${roots.join(':')}`
      : `目录托管未启用（设置 ${HOST_DIR_ROOTS_ENV} 后可用 /api/services/host-directory）`;
  console.log(
    `[gis-server] ${bindDescription(BIND_HOST, PORT, actual)} 已启动（管理页 /admin，健康检查 /api/health，数据目录 ${DATA_DIR}，${hostInfo}）`,
  );
  const warning = hostExposureWarning(process.env, roots);
  if (warning) console.warn(`[gis-server] ${warning}`);
});
