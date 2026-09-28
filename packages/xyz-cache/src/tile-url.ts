/**
 * editor/core · localCache/tileUrl —— XYZ 瓦片 URL 模板（纯函数，零依赖）
 *
 * 单一实现来源（t20 建立、t25 抽出为独立模块，`generate2d` 原样 re-export 保持兼容）：
 * - `buildXyzTileUrl`：把 `{z}/{x}/{y}`（必需）与 `{s}`（子域）/ `{token}`（令牌）代入；
 * - 模板校验与后缀推断、由基准地址推导模板（t25「模板 + 层级范围」导入路径复用）。
 *
 * 为什么独立成模块：t25 的 `LocalXyzImageryProvider`（xyzCache.ts）需要同一套代入逻辑，
 * 而 `generate2d.ts` 已经 import 了 xyzCache —— 把实现放在这里可得到单向依赖
 * （tileUrl ← generate2d、tileUrl ← xyzCache），避免循环 import 与二次实现。
 */

/** 模板未提供 subdomains 时 {s} 的缺省取值 */
export const DEFAULT_XYZ_SUBDOMAINS: readonly string[] = ['a', 'b', 'c'];

/** 由基准地址推导模板时的默认瓦片后缀（用户实测的本地 XYZ 缓存是 .jpg） */
export const DEFAULT_XYZ_TILE_EXT = 'jpg';

/** 支持的瓦片影像后缀（校验 / 推断用） */
const TILE_IMAGE_EXT_PATTERN = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

/**
 * 代入 XYZ URL 模板的 {z}/{x}/{y}（必需）与 {s}（子域轮转）/ {token}（令牌）。
 *
 * {s} 缺省用 a/b/c；轮转按 (x + y) % 子域数，保证同一模板内子域负载均匀且结果可复现。
 * 不做 URL 编码之外的任何改写（模板作者负责路径合法性）。
 */
export function buildXyzTileUrl(
  urlTemplate: string,
  tile: { zoom: number; x: number; y: number },
  subdomains?: readonly string[],
  token?: string,
): string {
  let url = urlTemplate
    .replace(/\{z\}/g, String(tile.zoom))
    .replace(/\{x\}/g, String(tile.x))
    .replace(/\{y\}/g, String(tile.y));
  if (url.includes('{s}')) {
    const list = subdomains && subdomains.length > 0 ? subdomains : DEFAULT_XYZ_SUBDOMAINS;
    const index = Math.abs((tile.x + tile.y) % list.length);
    url = url.replace(/\{s\}/g, String(list[index] ?? list[0]));
  }
  if (url.includes('{token}')) {
    url = url.replace(/\{token\}/g, encodeURIComponent(token ?? ''));
  }
  return url;
}

/** 模板是否含全部必需占位符 {z}/{x}/{y} */
export function hasXyzPlaceholders(template: string): boolean {
  const value = String(template ?? '');
  return /\{z\}/.test(value) && /\{x\}/.test(value) && /\{y\}/.test(value);
}

/**
 * 校验瓦片模板：非空 + 含 {z}/{x}/{y}；返回可读错误。
 * （协议可用性由调用方按环境判断：file:// 在浏览器/Electron 下能力不同。）
 */
export function validateXyzTemplate(template: string): { ok: boolean; error?: string } {
  const value = String(template ?? '').trim();
  if (!value) return { ok: false, error: '瓦片模板不能为空（应形如 https://host/tiles/{z}/{x}/{y}.jpg）' };
  if (!hasXyzPlaceholders(value)) {
    return {
      ok: false,
      error: `瓦片模板必须包含 {z}/{x}/{y} 占位符（实际「${value}」）`,
    };
  }
  return { ok: true };
}

/** 从模板推断瓦片后缀（小写；无法辨认时按 jpg 处理） */
export function xyzTemplateExt(template: string): string {
  const value = String(template ?? '').trim().split(/[?#]/)[0] ?? '';
  const match = TILE_IMAGE_EXT_PATTERN.exec(value);
  return match?.[1] ? match[1].toLowerCase() : DEFAULT_XYZ_TILE_EXT;
}

/**
 * 由基准地址推导 `{z}/{x}/{y}` 模板（去掉尾部斜杠；query/hash 丢弃）。
 *
 * 例：`http://localhost:8090` + `jpg` → `http://localhost:8090/{z}/{x}/{y}.jpg`；
 *     `file:///home/nuanyang/tiles/` → `file:///home/nuanyang/tiles/{z}/{x}/{y}.jpg`。
 */
export function deriveXyzTemplate(baseUrl: string, ext: string = DEFAULT_XYZ_TILE_EXT): string {
  const trimmed = String(baseUrl ?? '').trim();
  if (!trimmed) return '';
  const [withoutHash] = trimmed.split('#');
  const [withoutQuery] = (withoutHash ?? '').split('?');
  const base = (withoutQuery ?? '').replace(/\/+$/, '');
  const suffix = String(ext ?? '').trim().replace(/^\./, '') || DEFAULT_XYZ_TILE_EXT;
  return `${base}/{z}/{x}/{y}.${suffix}`;
}
