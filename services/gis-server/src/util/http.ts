import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** 带 HTTP 状态码的业务错误 */
export class HttpError extends Error {
  readonly status: number;
  readonly headers?: Record<string, string>;

  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

/** 包装异步路由处理器，把 Promise 拒绝交给 Express 错误中间件（Express 4 不自动捕获 async） */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
