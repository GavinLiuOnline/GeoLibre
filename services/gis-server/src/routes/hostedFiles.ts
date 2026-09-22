/**
 * 目录托管静态路由（t26）：`/tiles/<slug>/...` 与 `/tilesets/<slug>/...`。
 *
 * 与 `/published`、`/assets` 的区别：这里**不复制、不上传**任何文件，直接按注册表里
 * 记录的源目录（entry.hostDir）流式提供本地文件，因此 15GB / 242 万文件的缓存目录
 * 也能零成本对外发布。
 *
 * 安全：白名单在注册时校验；这里再做一次逐文件校验（realpath + 越界 + 扩展名白名单），
 * 防止托管目录内的符号链接把请求带到允许根之外。
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import {
  allowedExtensionsFor,
  hostedCacheControl,
  resolveHostedFile,
} from '../services/hostDirectory.js';
import { getRegisteredService } from '../services/registry.js';
import { HttpError } from '../util/http.js';

export type HostedKind = 'xyz' | '3dtiles';

function decodePathPart(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, '路径编码非法');
  }
}

/**
 * 生成托管处理器。
 * - 命中：200（HEAD 亦支持，由 res.sendFile 处理）、Content-Type 由扩展名推断、
 *   Cache-Control 合理（目录内容可能被工具重写，用 1 小时 TTL）
 * - 未注册/类型不符：404；越界/扩展名不允许：403
 */
export function createHostedFilesHandler(kind: HostedKind): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const raw = req.path.replace(/^\/+/, '');
      const slash = raw.indexOf('/');
      if (slash <= 0) {
        throw new HttpError(404, `缺少服务标识（slug）: ${req.method} ${req.originalUrl}`);
      }
      const slug = decodePathPart(raw.slice(0, slash));
      const rel = decodePathPart(raw.slice(slash + 1));

      const entry = getRegisteredService(slug);
      if (!entry || entry.hostKind !== kind || !entry.hostDir) {
        throw new HttpError(
          404,
          `托管${kind === 'xyz' ? '瓦片' : '3D Tiles'}服务不存在: ${slug}`,
        );
      }

      const { filePath } = resolveHostedFile(entry.hostDir, rel, allowedExtensionsFor(kind));
      const cacheControl = hostedCacheControl();
      res.setHeader('Cache-Control', cacheControl);
      // 注意：这里传的是**绝对文件路径**，express/send 会按路径的每一段判断 dotfiles。
      // 托管根或数据目录名合法地包含 `.`（如 .tiles / .cache）时，'deny' 会误判 403，
      // 因此这里用 'allow' —— 隐藏文件/目录已在上游 resolveHostedFile 逐段拒绝。
      res.sendFile(
        filePath,
        { dotfiles: 'allow', acceptRanges: true, headers: { 'Cache-Control': cacheControl } },
        (err) => {
          if (err && !res.headersSent) next(err);
        },
      );
    } catch (err) {
      next(err);
    }
  };
}
