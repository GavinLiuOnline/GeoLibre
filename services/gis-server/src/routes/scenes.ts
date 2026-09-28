import fs from 'node:fs';
import path from 'node:path';

import { Router } from 'express';
import multer from 'multer';

import { TMP_DIR, PUBLISHED_DIR, ensureDataDirs, saveScene } from '../services/storage.js';
import { publishScene } from '../services/publish.js';
import { publishPackage } from '../services/publishPackage.js';
import { createScene, deleteScene, getScene, listScenes } from '../services/storage.js';
import { getRequestUser, loadAuthConfig, requireWriteAuth } from '../util/auth.js';
import { HttpError, asyncHandler } from '../util/http.js';

export const scenesRouter: Router = Router();

// 写接口鉴权：AUTH_TOKEN 配置时校验 Bearer；GET 请求默认放行
scenesRouter.use(requireWriteAuth(loadAuthConfig()));

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB（场景包可能含 3D Tiles zip）

ensureDataDirs();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

/**
 * POST /api/scenes/publish-package —— 一站式场景包发布（multipart）。
 *
 * 字段：
 * - scene              JSON 字段（必填）
 * - bundleMeta         JSON 字段（必填），描述每个 bundle 的 {layerId, kind, index, filename}
 * - bundles[<layerId>] zip 字段（至少 0 个）；按 bundleMeta 顺序匹配
 * - assets[]           零散资产文件（可选）
 *
 * 返回：PublishPackageResult { manifest, hostedSceneUrl, hostedScene }
 * 鉴权：当 AUTH_TOKEN 设置时校验 Bearer；createdBy = AUTH_USER（默认 anonymous）。
 *
 * 注意：注册在 /:id 系列路由之前，避免 publish-package 被当作场景 id。
 */
scenesRouter.post(
  '/publish-package',
  upload.any(),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const textFields = req.body as Record<string, unknown>;

    const sceneRaw = textFields.scene;
    if (typeof sceneRaw !== 'string' || !sceneRaw) {
      throw new HttpError(400, '缺少 scene 字段（multipart 字段名 scene，JSON 字符串）');
    }
    let scene: Record<string, unknown>;
    try {
      scene = JSON.parse(sceneRaw) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'scene 字段不是有效 JSON');
    }

    // bundleMeta 描述：[{layerId, kind, index, filename}]
    let bundleMetaRaw: unknown;
    try {
      const raw = textFields.bundleMeta;
      if (typeof raw !== 'string' || !raw) {
        throw new Error('missing bundleMeta');
      }
      bundleMetaRaw = JSON.parse(raw);
    } catch {
      throw new HttpError(400, '缺少 bundleMeta 字段（multipart 字段名 bundleMeta，JSON 字符串）');
    }
    if (!Array.isArray(bundleMetaRaw)) {
      throw new HttpError(400, 'bundleMeta 必须为数组');
    }
    const bundleMeta = bundleMetaRaw.map((item, idx) => {
      if (typeof item !== 'object' || item === null) {
        throw new HttpError(400, `bundleMeta[${idx}] 不是对象`);
      }
      const m = item as Record<string, unknown>;
      const layerId = typeof m.layerId === 'string' ? m.layerId : '';
      const kind = m.kind;
      if (!layerId) throw new HttpError(400, `bundleMeta[${idx}].layerId 缺失`);
      if (kind !== 'xyz' && kind !== '3dtiles') {
        throw new HttpError(400, `bundleMeta[${idx}].kind 必须为 'xyz' 或 '3dtiles'`);
      }
      return {
        layerId,
        kind: kind as 'xyz' | '3dtiles',
        filename: typeof m.filename === 'string' ? m.filename : `${layerId}.zip`,
      };
    });

    // 收集 bundles
    const bundles: Array<{
      field: string;
      filename: string;
      tmpPath: string;
      meta: { layerId: string; kind: 'xyz' | '3dtiles' };
    }> = [];
    for (let i = 0; i < bundleMeta.length; i++) {
      const m = bundleMeta[i];
      const file = files.find((f) => f.fieldname === `bundles[${m.layerId}]`);
      if (!file) {
        throw new HttpError(
          400,
          `bundleMeta[${i}] 对应的 bundles[${m.layerId}] 文件缺失`,
        );
      }
      bundles.push({
        field: file.fieldname,
        filename: file.originalname,
        tmpPath: file.path,
        meta: { layerId: m.layerId, kind: m.kind },
      });
    }

    // 收集 assets
    const assets = files
      .filter((f) => f.fieldname === 'assets[]')
      .map((f) => ({
        field: f.fieldname,
        filename: f.originalname,
        tmpPath: f.path,
      }));

    // 1) 先落盘 SceneDocument，获得稳定 sceneId
    const requestedId = typeof scene.id === 'string' && scene.id ? scene.id : undefined;
    const user = getRequestUser(req);
    const savedDoc = requestedId
      ? saveScene(requestedId, scene, user)
      : createScene(scene, user);

    // 2) 用落盘后的 doc（含稳定 id / createdAt / createdBy）跑发布
    const outcome = publishPackage(
      { scene: savedDoc, bundles, assets },
      user,
    );

    // 3) 回填 manifest.sceneId = savedDoc.id（manifest.json 已写一次，这里再覆盖一次）
    const finalManifest = { ...outcome.manifest, sceneId: savedDoc.id };
    fs.writeFileSync(
      path.join(PUBLISHED_DIR, outcome.manifest.slug, 'manifest.json'),
      JSON.stringify(finalManifest, null, 2),
      'utf8',
    );

    // 4) hostedScene 返回 publishPackage 重写后的版本（source.url 已指向服务端 URL），
    //    但保留 savedDoc 的 id / createdAt / createdBy / updatedAt 等元数据。
    const rewrittenHosted = {
      ...outcome.hostedScene,
      id: savedDoc.id,
      createdAt: savedDoc.createdAt,
      updatedAt: savedDoc.updatedAt,
      createdBy: savedDoc.createdBy,
      updatedBy: savedDoc.updatedBy,
    };
    res.status(201).json({
      manifest: finalManifest,
      hostedSceneUrl: outcome.hostedSceneUrl,
      hostedScene: rewrittenHosted,
    });
  }),
);

/**
 * POST /api/scenes/publish-batch —— 批量发布（多选场景一键发布）。
 * body: { ids: string[] }；逐场景独立发布，单个失败不影响其余，返回逐项结果。
 * 注意注册在 /:id 系列路由之前，避免 publish-batch 被当作场景 id。
 */
scenesRouter.post(
  '/publish-batch',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      throw new HttpError(400, 'body.ids 必须为非空字符串数组');
    }
    const ids = body.ids.map(String);
    if (ids.length > 50) throw new HttpError(400, '单次批量发布上限 50 个场景');
    const results: Array<{ id: string; ok: boolean; slug?: string; manifest?: unknown; error?: string }> = [];
    for (const id of ids) {
      try {
        const doc = getScene(id);
        const manifest = await publishScene(doc, getRequestUser(req));
        results.push({ id, ok: true, slug: manifest.slug, manifest });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    res.json({
      published: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  }),
);

/** GET /api/scenes —— 场景列表 */
scenesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(listScenes());
  }),
);

/** POST /api/scenes —— 新建/导入场景（body 可携带 id 作为导入 id） */
scenesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    res.status(201).json(createScene(req.body, getRequestUser(req)));
  }),
);

/** GET /api/scenes/:id —— 场景文档 */
scenesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(getScene(req.params.id));
  }),
);

/** PUT /api/scenes/:id —— 覆盖保存（upsert） */
scenesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(saveScene(req.params.id, req.body, getRequestUser(req)));
  }),
);

/** DELETE /api/scenes/:id —— 删除场景 */
scenesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    deleteScene(req.params.id);
    res.status(204).send();
  }),
);

/** POST /api/scenes/:id/publish —— 发布场景，返回 PublishManifest */
scenesRouter.post(
  '/:id/publish',
  asyncHandler(async (req, res) => {
    const doc = getScene(req.params.id);
    res.json(await publishScene(doc, getRequestUser(req)));
  }),
);
