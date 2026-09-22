import { Router } from 'express';

import { listPublished } from '../services/storage.js';
import { asyncHandler } from '../util/http.js';

export const metaRouter: Router = Router();

/** GET /api/health —— 健康检查（挂在 /api/scenes/:id 之前注册，避免路由抢占） */
metaRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), version: '0.1.0' });
});

/** GET /api/published —— 已发布清单列表 */
metaRouter.get(
  '/published',
  asyncHandler(async (_req, res) => {
    res.json(listPublished());
  }),
);
