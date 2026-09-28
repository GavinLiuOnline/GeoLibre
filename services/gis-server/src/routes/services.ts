import { Router } from 'express';

import { buildHostDirectoryEntry } from '../services/hostDirectory.js';
import { publishAssetTiles } from '../services/publish.js';
import { deleteService, listServices, upsertService } from '../services/registry.js';
import { getRequestUser, loadAuthConfig, requireWriteAuth } from '../util/auth.js';
import { HttpError, asyncHandler } from '../util/http.js';

export const servicesRouter: Router = Router();

// 写接口鉴权：AUTH_TOKEN 配置时校验 Bearer
servicesRouter.use(requireWriteAuth(loadAuthConfig()));

/** GET /api/services —— 服务注册表（全量服务实例，与发布目录自动对账） */
servicesRouter.get('/', (_req, res) => {
  res.json(listServices());
});

/**
 * POST /api/services/publish-asset —— 把上传的 3D Tiles 数据集 zip 直接发布为服务。
 * body: { assetId: string, filename?: string } → { manifest, entry }（entry: ServiceEntry）
 */
servicesRouter.post(
  '/publish-asset',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { assetId?: unknown; filename?: unknown };
    if (typeof body.assetId !== 'string' || !body.assetId) {
      throw new HttpError(400, '缺少 assetId（body: {assetId, filename?}）');
    }
    const filename = typeof body.filename === 'string' ? body.filename : undefined;
    const user = getRequestUser(req);
    const result = await Promise.resolve(publishAssetTiles(body.assetId, filename));
    if (user && result?.entry) {
      (result.entry as { createdBy?: string }).createdBy = user;
    }
    res.status(201).json(result);
  }),
);

/**
 * POST /api/services/host-directory —— 按路径托管本地目录（t26，免上传发布 GB 级缓存）。
 * body: { dir: string, kind: 'xyz'|'3dtiles', slug?: string, title?: string }
 * → { entry: ServiceEntry, scan, access: { url, kind, note } }
 *
 * 安全默认：仅当环境变量 GIS_HOST_DIR_ROOTS（冒号分隔的允许根）配置且目录在其中时才允许，
 * 否则 403 并给出开启指引；不复制、不上传任何文件。
 */
servicesRouter.post(
  '/host-directory',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as {
      dir?: unknown;
      kind?: unknown;
      slug?: unknown;
      title?: unknown;
    };
    if (typeof body.dir !== 'string' || !body.dir) {
      throw new HttpError(400, '缺少 dir（本地目录绝对路径）');
    }
    const kindRaw = String(body.kind ?? '');
    if (kindRaw !== 'xyz' && kindRaw !== '3dtiles') {
      throw new HttpError(400, "kind 必须为 'xyz' 或 '3dtiles'");
    }
    const result = buildHostDirectoryEntry({
      dir: body.dir,
      kind: kindRaw,
      ...(typeof body.slug === 'string' ? { slug: body.slug } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
    });
    const user = getRequestUser(req);
    if (user) result.entry.createdBy = user;
    upsertService(result.entry);
    res.status(201).json(result);
  }),
);

/**
 * DELETE /api/services/:slug —— 注销服务。
 * - 发布型：删除发布包目录 + 注册表条目；
 * - 目录托管型（t26）：只移除注册表条目与托管映射，**源目录一个文件都不动**，
 *   响应体显式说明（200 + JSON）。
 */
servicesRouter.delete(
  '/:slug',
  (req, res) => {
    const outcome = deleteService(req.params.slug);
    if (outcome.mode === 'hosted') {
      res.status(200).json(outcome);
      return;
    }
    res.status(204).send();
  },
);

