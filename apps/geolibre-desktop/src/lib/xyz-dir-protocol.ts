/*
  lib/xyz-dir-protocol —— 本机 XYZ 缓存目录接入（Phase 4）

  把「生成缓存」产物解压后的本机目录（z/x/y 瓦片树）直接作为 XYZ 图层加载，
  免上传、免服务端：
  - MapLibre 自定义协议 `xyzdir:`（与 MBTiles 协议同模式）：瓦片 URL 形如
      xyzdir://{z}/{x}/{y}.png?dir=<URL 编码的本机绝对路径>
    maplibre 展开 {z}/{x}/{y} 后由协议处理器经 readLocalFileBytes 读取
    （fs 插件拒绝时自动回退 read_local_file Tauri 命令，任意路径可读）。
  - scanXyzDir：加载前校验目录结构（数字缩放级 + 抽样探测扩展名）。
  限制：当前在 MapLibre 渲染器下生效；Cesium 全球视图的本地目录协议待后续。
*/
import { addProtocol, type RequestParameters } from "maplibre-gl";

import { isTauri, readLocalFileBytes } from "./tauri-io";

export const XYZ_DIR_PROTOCOL = "xyzdir";

const TILE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

let protocolRegistered = false;

/** 注册 xyzdir 协议（幂等）。仅桌面端有意义；浏览器端注册为不可用协议。 */
export function registerXyzDirProtocol(): void {
  if (protocolRegistered) return;
  addProtocol(XYZ_DIR_PROTOCOL, async (request: RequestParameters) => {
    const parsed = parseXyzDirTileRequest(request);
    // 目录内缺瓦片（层级空洞）是常态：返回空缓冲（透明），与 MBTiles 处理器一致，
    // 而不是抛错让渲染器把整层当失败。
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await readLocalFileBytes(parsed.filePath);
    } catch {
      return { data: new ArrayBuffer(0) };
    }
    return {
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      contentType: CONTENT_TYPES[parsed.ext] ?? "image/png",
    };
  });
  protocolRegistered = true;
}

export function parseXyzDirTileRequest(request: RequestParameters): {
  filePath: string;
  ext: string;
} {
  const url = new URL(request.url);
  const dir = url.searchParams.get("dir");
  if (!dir) throw new Error("xyzdir 协议缺少 dir 参数");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) throw new Error("xyzdir 瓦片 URL 非法（应为 {z}/{x}/{y}.<ext>）");
  const [z, x, yFile] = parts;
  if (![z, x, yFile.split(".")[0]].every((p) => /^\d+$/.test(p))) {
    throw new Error("xyzdir 瓦片坐标非法");
  }
  const ext = (yFile.split(".")[1] ?? "png").toLowerCase();
  const sep = dir.includes("\\") ? "\\" : "/";
  const base = /[/\\]$/.test(dir) ? dir : `${dir}${sep}`;
  return { filePath: `${base}${z}${sep}${x}${sep}${yFile}`, ext };
}

/** XYZ 目录扫描结果 */
export interface XyzDirScan {
  /** 目录绝对路径（归一化分隔符后） */
  dir: string;
  minZoom: number;
  maxZoom: number;
  /** 抽样探测到的瓦片扩展名 */
  ext: string;
  /** 命中的缩放级目录数（用于结构校验） */
  zoomDirCount: number;
}

/**
 * 校验并探测一个本机 XYZ 目录：数字命名的缩放级子目录（0–22），
 * 下一级 x 目录存在，抽样读一张瓦片确认扩展名。
 * 抛错时消息面向用户（目录选择对话框 → 直接展示）。
 */
export async function scanXyzDir(rawDir: string): Promise<XyzDirScan> {
  if (!isTauri()) {
    throw new Error("引用本机瓦片目录需要 GeoLibre 桌面端。");
  }
  const { listDirectory } = await import("./tauri-io");
  const dir = rawDir.replace(/[/\\]+$/, "");
  const zoomDirs = (await listDirectory(dir))
    .filter((entry) => entry.isDirectory && /^\d{1,2}$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((z) => z >= 0 && z <= 22)
    .sort((a, b) => a - b);
  if (zoomDirs.length === 0) {
    throw new Error("所选目录不含数字缩放级子目录（期望 z/x/y 瓦片树结构）");
  }
  // 从最浅的缩放级抽样找瓦片文件确认扩展名
  const sep = dir.includes("\\") ? "\\" : "/";
  for (const z of zoomDirs) {
    const xDirs = (await listDirectory(`${dir}${sep}${z}`)).filter((entry) => entry.isDirectory);
    for (const xDir of xDirs.slice(0, 4)) {
      // LocalDirectoryEntry 无 isFile：非目录且扩展名命中即视为瓦片文件
      const files = (await listDirectory(`${dir}${sep}${z}${sep}${xDir.name}`)).filter(
        (entry) => !entry.isDirectory,
      );
      const tile = files.find((entry) =>
        (TILE_EXTENSIONS as readonly string[]).includes(entry.name.split(".").pop()?.toLowerCase() ?? ""),
      );
      if (tile) {
        const ext = tile.name.split(".").pop()!.toLowerCase();
        return {
          dir,
          minZoom: zoomDirs[0],
          maxZoom: zoomDirs[zoomDirs.length - 1],
          ext,
          zoomDirCount: zoomDirs.length,
        };
      }
    }
  }
  throw new Error("缩放级目录下未找到瓦片文件（支持 png/jpg/webp）");
}

/** 生成该目录的 MapLibre XYZ URL 模板（xyzdir 协议）。
 * 与 MBTiles 协议同约定插入字面量 `tile` 作 host：非特殊 scheme 的 URL
 * 解析会把首段路径当作 host，占位一段 host 保证 pathname 恰为 z/x/y 三段。 */
export function xyzDirTileTemplate(scan: XyzDirScan): string {
  return `${XYZ_DIR_PROTOCOL}://tile/{z}/{x}/{y}.${scan.ext}?dir=${encodeURIComponent(scan.dir)}`;
}
