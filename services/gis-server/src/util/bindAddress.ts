/**
 * 服务端绑定地址与暴露面提示（t28）——纯函数，便于单测。
 *
 * 背景：t26 引入「按路径托管本地目录」后，服务端暴露面从「自身 data 目录」扩大到
 * 「GIS_HOST_DIR_ROOTS 白名单内的任意本机目录」。因此默认绑定必须是回环地址
 * （`127.0.0.1`），只有显式设置 `GIS_HOST=0.0.0.0` 才对外暴露；当白名单非空且
 * 绑定到非回环地址时必须打印醒目安全警告。
 */

import { HOST_DIR_ROOTS_ENV, allowedHostRoots } from '../services/hostDirectory.js';

/** 绑定地址环境变量（未设置时使用 {@link DEFAULT_BIND_HOST}） */
export const HOST_ENV = 'GIS_HOST';

/** 默认绑定地址：仅本机可访问 */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/** 解析实际绑定地址：`GIS_HOST` 为空/空白时回落默认回环地址 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[HOST_ENV];
  if (typeof raw !== 'string') return DEFAULT_BIND_HOST;
  const trimmed = raw.trim();
  return trimmed || DEFAULT_BIND_HOST;
}

/** 是否回环地址（本机专用）：127.0.0.0/8、::1、localhost、IPv4-mapped ::ffff:127.x */
export function isLoopbackHost(host: string): boolean {
  if (typeof host !== 'string') return false;
  let h = host.trim().toLowerCase();
  if (!h) return false;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // [::1] → ::1
  if (h === 'localhost') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('::ffff:')) return isLoopbackHost(h.slice('::ffff:'.length));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * 目录托管暴露警告：仅当「白名单非空」且「绑定地址非回环」时返回警告文案，否则 null。
 * 传入 roots 可避免重复解析环境变量（也便于单测）。
 */
export function hostExposureWarning(
  env: NodeJS.ProcessEnv = process.env,
  roots: string[] = allowedHostRoots(env),
): string | null {
  const host = resolveBindHost(env);
  if (roots.length === 0) return null;
  if (isLoopbackHost(host)) return null;
  return (
    `⚠️  安全警告：目录托管白名单（${HOST_DIR_ROOTS_ENV}）已配置 ${roots.length} 个允许根，` +
    `但服务绑定在非回环地址 ${host} —— 白名单目录（${roots.join(':')}）将对同网络的其他主机可见，` +
    `可被任意枚举/下载。若非有意对外发布，请设置 ${HOST_ENV}=${DEFAULT_BIND_HOST}（默认）或取消 ${HOST_DIR_ROOTS_ENV}。`
  );
}

/** 启动日志用的绑定描述：始终包含实际绑定地址（便于断言默认回环 127.0.0.1） */
export function bindDescription(host: string, port: number, actual?: string): string {
  const bound = actual ?? `${host}:${port}`;
  return `http://${host}:${port}（实际绑定 ${bound}）`;
}
