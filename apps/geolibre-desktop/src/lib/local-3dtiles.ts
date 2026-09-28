/*
  lib/local-3dtiles —— 本机 3D Tiles 目录接入（Phase 4）

  把本机 tileset.json 所在目录直接挂成 3d-tiles 图层（Cesium 端渲染）：
  - URL 方案 `geolibre-local://tile/<encodeURIComponent(绝对目录)>/tileset.json`：
    字面量 `tile` 占 host（非特殊 scheme URL 解析会把首段当 host）；
    整个基目录编码为**一个**路径段——Cesium 对 tileset.json 内的相对引用
    （b3dm/glb/子 tileset）做 URL 相对解析时只追加路径段，不丢查询参数。
  - 全局钩子 Resource._Implementations.loadWithXhr：geolibre-local 请求改为
    readLocalFileBytes（fs 插件 → read_local_file 回退，任意路径可读），
    其余 scheme 原样委托 Cesium 默认实现。
  - 浏览器端不可用（无本机文件系统）。
*/
import { Resource } from "cesium";

import { isTauri, readLocalFileBytes } from "./tauri-io";

export const LOCAL_3DTILES_PROTOCOL = "geolibre-local";

let registered = false;

interface DeferredLike {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

type LoadWithXhr = (
  this: unknown,
  url: string,
  responseType: string,
  method: string,
  data: unknown,
  headers: unknown,
  deferred: DeferredLike,
  overrideMimeType?: string,
) => void;

/** 注册本机 3D Tiles 读取支持（幂等；仅桌面端）。 */
export function registerLocal3dTilesSupport(): void {
  if (registered || !isTauri()) return;
  registered = true;
  // Resource._Implementations 是 Cesium 未导出的内部命名空间，走双层 cast
  const implementations = (Resource as unknown as {
    _Implementations: { loadWithXhr: LoadWithXhr };
  })._Implementations;
  const original = implementations.loadWithXhr;
  implementations.loadWithXhr = function patchedLoadWithXhr(
    url,
    responseType,
    method,
    data,
    headers,
    deferred,
    overrideMimeType,
  ) {
    if (typeof url !== "string" || !url.startsWith(`${LOCAL_3DTILES_PROTOCOL}://`)) {
      original.call(this, url, responseType, method, data, headers, deferred, overrideMimeType);
      return;
    }
    void (async () => {
      try {
        const filePath = parseLocal3dTilesUrl(url);
        const bytes = await readLocalFileBytes(filePath);
        if (responseType === "arraybuffer" || responseType === "blob") {
          deferred.resolve(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          );
          return;
        }
        const text = new TextDecoder().decode(bytes);
        deferred.resolve(responseType === "json" ? JSON.parse(text) : text);
      } catch (error) {
        deferred.reject(error);
      }
    })();
  };
}

/** 本机 3D Tiles 目录 → geolibre-local URL（目录根须含 tileset.json）。 */
export function local3dTilesUrl(absDir: string): string {
  const base = absDir.replace(/[/\\]+$/, "");
  return `${LOCAL_3DTILES_PROTOCOL}://tile/${encodeURIComponent(base)}/tileset.json`;
}

/** geolibre-local URL → 本机绝对文件路径（基目录 + 相对段按本机分隔符拼接）。
 * `tile` 是 URL 的 host（非特殊 scheme 首段不进 pathname），pathname 段依次为
 * [<编码基目录>, ...相对路径]。 */
export function parseLocal3dTilesUrl(url: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (parsed.host !== "tile" || segments.length < 1) {
    throw new Error("geolibre-local URL 非法（应为 geolibre-local://tile/<基目录>/<相对路径>）");
  }
  const base = decodeURIComponent(segments[0]);
  const relative = segments.slice(1);
  const sep = base.includes("\\") ? "\\" : "/";
  return relative.length > 0 ? `${base}${sep}${relative.join(sep)}` : base;
}
