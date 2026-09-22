/**
 * 服务端 Bearer Token 鉴权：
 * - 当环境变量 AUTH_TOKEN 设置时，所有「写接口」（POST/PUT/DELETE/PATCH）必须携带
 *   `Authorization: Bearer <token>`，否则返回 401；
 * - AUTH_USER 用于在 createdBy / updatedBy 字段上记录调用方（默认 anonymous）；
 * - GET 请求默认放行，方便编辑器与服务控制台只读访问。
 *
 * 注意：401 响应必须带 `WWW-Authenticate: Bearer` 让前端识别为鉴权失败；
 * `code` 在 @geolibre/gis-shared 的 GisApiError 中映射为 'auth'，UI 据此弹窗引导 Token 设置。
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { HttpError } from './http.js';

/**
 * 拒绝请求前先把请求体读掉（drain）。
 *
 * 场景包发布 / 资产上传是 multipart 大文件（可达 GB 级）：如果直接 401 关闭响应，
 * 客户端（Node fetch / undici）会在写完请求体时收到 ECONNRESET，
 * `@geolibre/gis-shared` 的 GisApiClient 只会看到网络错误（code='network'）而不是
 * 鉴权失败（code='auth'），UI 就无法弹窗引导 Token 设置。
 * 因此这里先 resume + 消费请求流，待请求体读完后再回调 next(err) 返回 401。
 */
function drainBodyThen(
  req: Request,
  next: NextFunction,
  err: Error,
  timeoutMs = 30_000,
): void {
  if (req.readableEnded || req.complete) {
    next(err);
    return;
  }
  let settled = false;
  const done = (): void => {
    if (settled) return;
    settled = true;
    req.off('end', done);
    req.off('close', done);
    req.off('error', done);
    next(err);
  };
  req.on('end', done);
  req.on('close', done);
  req.on('error', done);
  // 兜底：超大请求体或客户端提前断开时避免请求悬挂
  setTimeout(done, timeoutMs).unref?.();
  req.resume();
}

export interface AuthConfig {
  /** 期望的 Bearer Token；缺省/空字符串 = 不强制鉴权 */
  token: string;
  /** Token 对应的用户名（用于 createdBy 等审计字段） */
  user: string;
}

export function loadAuthConfig(): AuthConfig {
  const token = (process.env.AUTH_TOKEN ?? '').trim();
  const user = (process.env.AUTH_USER ?? 'anonymous').trim() || 'anonymous';
  return { token, user };
}

function extractBearer(req: Request): string | null {
  const raw = req.header('authorization') ?? req.header('Authorization');
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

/**
 * 写接口强制鉴权中间件：仅当 AUTH_TOKEN 配置时启用。
 * 通过 req.auth.user 暴露当前调用方（默认 anonymous）。
 */
export function requireWriteAuth(config: AuthConfig): RequestHandler {
  if (!config.token) {
    // 未配置：放行，并把 user 标为 anonymous
    return (req, _res, next) => {
      (req as Request & { auth?: { user: string } }).auth = { user: 'anonymous' };
      next();
    };
  }
  return (req: Request, _res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      // 读请求放行
      (req as Request & { auth?: { user: string } }).auth = { user: config.user };
      next();
      return;
    }
    const provided = extractBearer(req);
    if (!provided || provided !== config.token) {
      // 401 + WWW-Authenticate，便于浏览器原生弹窗 & @geolibre/gis-shared 识别为 auth。
      // 先 drain 请求体再返回，保证大体积 multipart（场景包 / 资产上传）鉴权失败时
      // 客户端能稳定拿到 401（code='auth'），而不是 ECONNRESET（code='network'）。
      const err = new HttpError(401, '缺少或错误的 Authorization Bearer Token', {
        'WWW-Authenticate': 'Bearer realm="gis-server"',
      });
      drainBodyThen(req, next, err);
      return;
    }
    (req as Request & { auth?: { user: string } }).auth = { user: config.user };
    next();
  };
}

/** 从 request 中读取当前调用方（可能为 anonymous） */
export function getRequestUser(req: Request): string {
  const auth = (req as Request & { auth?: { user: string } }).auth;
  return auth?.user ?? 'anonymous';
}
