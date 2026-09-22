/**
 * 服务端「流式导出任务」HTTP 路由（t34）。
 *
 * 端点：
 *   POST   /api/exports                       创建任务（公式估算 + 流式打包自动开始）
 *   GET    /api/exports                       列出所有任务（含已完成/失败/取消）
 *   GET    /api/exports/:id                   查询单个任务进度（snapshot）
 *   GET    /api/exports/:id/download          流式下载产物（支持 HEAD，200/206）
 *   DELETE /api/exports/:id                   取消并清理产物
 *
 * 安全：
 *   - 写接口（POST / DELETE）走 requireWriteAuth（AUTH_TOKEN 配置时强制 Bearer）
 *   - GET 默认放行（编辑器与管理页轮询进度 / 下载产物）
 *   - 下载端点只允许读取本任务注册的产物路径（id 为 UUID v4，猜测/穿越拿不到任何文件）
 *   - 产物只可能落在 DATA_DIR/exports/<id>.zip —— 任何 ID 路径推导都经 realpath 复核
 */

import fs from 'node:fs';
import path from 'node:path';

import { Router } from 'express';

import {
  type ExportJob,
  createExportJob,
  getExportJob,
  listExportJobs,
  removeExportJob,
} from '../services/exportJob.js';
import { DATA_DIR } from '../services/storage.js';
import { getRequestUser, loadAuthConfig, requireWriteAuth } from '../util/auth.js';
import { HttpError, asyncHandler } from '../util/http.js';

export const exportsRouter: Router = Router();

// 写接口鉴权（AUTH_TOKEN 配置时强制 Bearer，GET 放行）
exportsRouter.use(requireWriteAuth(loadAuthConfig()));

// ---------------------------------------------------------------------------
// POST /api/exports —— 创建导出任务
// ---------------------------------------------------------------------------

exportsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const job = createExportJob({
      src: body.src,
      bounds: body.bounds,
      minZoom: body.minZoom,
      maxZoom: body.maxZoom,
      format: body.format,
      compression: body.compression,
      ext: body.ext,
    });
    // 调用方记录为 audit（当前未在 ExportJob 上设置 createdBy，留作接口契约占位）
    void getRequestUser(req);
    res.status(201).json({
      exportId: job.id,
      status: job.status,
      phase: job.phase,
      estimate: job.estimate,
      bounds: job.bounds,
      minZoom: job.minZoom,
      maxZoom: job.maxZoom,
      compression: job.compression,
      ext: job.ext,
      src: job.src,
      progressUrl: `/api/exports/${job.id}`,
      downloadUrl: `/api/exports/${job.id}/download`,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/exports —— 列出所有任务（按 startedAt 倒序）
// ---------------------------------------------------------------------------

exportsRouter.get('/', (_req, res) => {
  res.json({ jobs: listExportJobs() });
});

// ---------------------------------------------------------------------------
// GET /api/exports/:id —— 单个任务进度
// ---------------------------------------------------------------------------

exportsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const job = getExportJob(req.params.id);
    if (!job) throw new HttpError(404, `导出任务不存在: ${req.params.id}`);
    res.json(job.toSnapshot());
  }),
);

// ---------------------------------------------------------------------------
// GET /api/exports/:id/download —— 流式下载（HEAD 同样支持）
// ---------------------------------------------------------------------------

/**
 * 校验下载 ID 与导出任务的产物路径匹配：产物只能落在 DATA_DIR/exports/<id>.zip，
 * 且当前任务在注册表中存在。任何猜测 / 路径穿越拿不到任何文件。
 */
function resolveDownloadTarget(
  id: string,
  job: ExportJob,
): { filePath: string; size: number } {
  // 1. 注册表里有这条任务
  if (job.id !== id) throw new HttpError(404, `导出任务不存在: ${id}`);
  // 2. 任务必须已完成
  if (job.status !== 'done' || !job.outputPath || typeof job.outputSize !== 'number') {
    throw new HttpError(409, `导出任务尚未完成（status=${job.status}，phase=${job.phase}）`);
  }
  // 3. 产物路径必须在 DATA_DIR/exports/ 下，且文件名必须是 <id>.zip
  const expected = path.join(DATA_DIR, 'exports', `${id}.zip`);
  const realExpected = path.resolve(expected);
  let realActual: string;
  try {
    realActual = fs.realpathSync(job.outputPath);
  } catch {
    throw new HttpError(404, `导出产物已不存在或被清理: ${id}`);
  }
  if (realActual !== realExpected) {
    throw new HttpError(403, `导出产物路径越界（拒绝服务）: ${id}`);
  }
  if (!fs.existsSync(realActual) || !fs.statSync(realActual).isFile()) {
    throw new HttpError(404, `导出产物不可读: ${id}`);
  }
  return { filePath: realActual, size: job.outputSize };
}

async function streamDownload(req: import('express').Request, res: import('express').Response): Promise<void> {
  const id = req.params.id;
  const job = getExportJob(id);
  if (!job) throw new HttpError(404, `导出任务不存在: ${id}`);
  const { filePath, size } = resolveDownloadTarget(id, job);

  // HEAD：只发头部，不读 body
  if (req.method === 'HEAD') {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${id}.zip"`);
    res.status(200).end();
    return;
  }

  // Range 支持（流式服务端必备）：瓦片导出可能数 GB
  const range = String(req.headers.range ?? '').trim();
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = 0;
  let end = size - 1;
  let status = 200;
  let chunkSize = size;
  if (match) {
    const s = match[1];
    const e = match[2];
    if (s === '' && e === '') {
      // 非法 Range
      res.setHeader('Content-Range', `bytes */${size}`);
      throw new HttpError(416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${size}` });
    }
    if (s !== '') start = Math.max(0, Number(s));
    if (e !== '') end = Math.min(size - 1, Number(e));
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`);
      throw new HttpError(416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${size}` });
    }
    status = 206;
    chunkSize = end - start + 1;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.zip"`);
  if (status === 206) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', String(chunkSize));
  res.status(status);

  // 流式 fs.createReadStream：客户端断连即自然释放
  const stream = fs.createReadStream(filePath, {
    start,
    end,
    highWaterMark: 1024 * 1024,
  });
  stream.on('error', (err) => {
    if (!res.headersSent) {
      // 还未发任何字节：抛出走统一错误中间件
      throw err;
    }
    // 已发头部：只能 abort socket
    if (!res.writableEnded) res.destroy(err);
  });
  stream.pipe(res);
}

exportsRouter.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    await streamDownload(req, res);
  }),
);

exportsRouter.head(
  '/:id/download',
  asyncHandler(async (req, res) => {
    await streamDownload(req, res);
  }),
);

// ---------------------------------------------------------------------------
// DELETE /api/exports/:id —— 取消 + 清理产物
// ---------------------------------------------------------------------------

exportsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const outcome = await removeExportJob(req.params.id);
    res.status(200).json(outcome);
  }),
);