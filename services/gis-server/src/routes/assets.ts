import path from 'node:path';

import { Router } from 'express';
import multer from 'multer';

import { TMP_DIR, deleteAsset, isAllowedAssetFilename, listAssets, storeAsset } from '../services/storage.js';
import { loadAuthConfig, requireWriteAuth } from '../util/auth.js';
import { HttpError, asyncHandler } from '../util/http.js';

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1GB

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedAssetFilename(file.originalname)) {
      cb(new HttpError(400, '不支持的资产类型，允许的扩展名: .glb/.gltf/.geojson/.json/.kml/.zip'));
      return;
    }
    cb(null, true);
  },
});

export const assetsRouter: Router = Router();

// 写接口鉴权：AUTH_TOKEN 配置时校验 Bearer
assetsRouter.use(requireWriteAuth(loadAuthConfig()));

/** GET /api/assets —— 资产列表（管理页资产管理使用） */
assetsRouter.get('/', (_req, res) => {
  res.json(listAssets());
});

/** POST /api/assets —— 上传资产（multipart 字段名 file），返回 {assetId,url,size} */
assetsRouter.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, '缺少上传文件（multipart 字段名 file）');
    res.status(201).json(storeAsset(req.file.path, req.file.originalname, req.file.mimetype));
  }),
);

/** DELETE /api/assets/:assetId —— 删除资产（整目录，含全部文件） */
assetsRouter.delete('/:assetId', (req, res) => {
  deleteAsset(req.params.assetId);
  res.status(204).send();
});

