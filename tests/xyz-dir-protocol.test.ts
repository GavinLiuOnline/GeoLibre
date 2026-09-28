/*
  xyz-dir-protocol 单测：瓦片 URL 解析 / 模板生成 / 目录结构判定。
  协议处理器本身依赖 Tauri 运行时（readLocalFileBytes），此处只测纯函数部分。
*/
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseXyzDirTileRequest,
  xyzDirTileTemplate,
  XYZ_DIR_PROTOCOL,
} from "../apps/geolibre-desktop/src/lib/xyz-dir-protocol";

function makeRequest(url: string) {
  return { url } as unknown as Parameters<typeof parseXyzDirTileRequest>[0];
}

test("parseXyzDirTileRequest：POSIX 路径 + 查询参数 dir", () => {
  const dir = "/data/xyz-cache-beijing";
  const url = `${XYZ_DIR_PROTOCOL}://tile/6/52/23.png?dir=${encodeURIComponent(dir)}`;
  const parsed = parseXyzDirTileRequest(makeRequest(url));
  assert.equal(parsed.filePath, `${dir}/6/52/23.png`);
  assert.equal(parsed.ext, "png");
});

test("parseXyzDirTileRequest：Windows 反斜杠路径与 jpg 扩展名", () => {
  const dir = "C:\\data\\cache";
  const url = `${XYZ_DIR_PROTOCOL}://tile/3/2/1.JPG?dir=${encodeURIComponent(dir)}`;
  const parsed = parseXyzDirTileRequest(makeRequest(url));
  assert.equal(parsed.filePath, `C:\\data\\cache\\3\\2\\1.JPG`);
  assert.equal(parsed.ext, "jpg");
});

test("parseXyzDirTileRequest：缺 dir 或坐标非法时抛错", () => {
  assert.throws(
    () => parseXyzDirTileRequest(makeRequest(`${XYZ_DIR_PROTOCOL}://tile/1/2/3.png`)),
    /dir/,
  );
  assert.throws(
    () => parseXyzDirTileRequest(makeRequest(`${XYZ_DIR_PROTOCOL}://tile/a/b/c.png?dir=${encodeURIComponent("/d")}`)),
  );
});

test("xyzDirTileTemplate：模板保留 {z}/{x}/{y} 占位符并编码 dir", () => {
  const scan = {
    dir: "/data/cache 01",
    minZoom: 4,
    maxZoom: 12,
    ext: "webp",
    zoomDirCount: 9,
  };
  const template = xyzDirTileTemplate(scan);
  assert.ok(template.startsWith(`${XYZ_DIR_PROTOCOL}://tile/{z}/{x}/{y}.webp?dir=`));
  assert.ok(template.includes(encodeURIComponent("/data/cache 01")));
  // 占位符必须保持字面量（不能被 encodeURIComponent 吞掉）
  assert.ok(template.includes("{z}/{x}/{y}"));
});
