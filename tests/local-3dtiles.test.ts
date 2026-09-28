/*
  local-3dtiles 单测：geolibre-local URL 生成/解析（纯函数部分）。
  模块顶层 import cesium——tsx 在 node 下加载其 ESM 入口；失败则跳过。
*/
import assert from "node:assert/strict";
import { test } from "node:test";

let local3dTilesUrl: typeof import("../apps/geolibre-desktop/src/lib/local-3dtiles").local3dTilesUrl;
let parseLocal3dTilesUrl: typeof import("../apps/geolibre-desktop/src/lib/local-3dtiles").parseLocal3dTilesUrl;
let loaded = true;
try {
  const mod = await import("../apps/geolibre-desktop/src/lib/local-3dtiles");
  local3dTilesUrl = mod.local3dTilesUrl;
  parseLocal3dTilesUrl = mod.parseLocal3dTilesUrl;
} catch {
  loaded = false;
}

test("local3dTilesUrl：基目录编码为单一路径段 + tile 占 host", { skip: !loaded }, () => {
  const url = local3dTilesUrl("/data/tileset 杭州塔");
  assert.ok(url.startsWith("geolibre-local://tile/"));
  assert.ok(url.endsWith("/tileset.json"));
  // 空格必须被编码进同一路径段
  assert.ok(url.includes(encodeURIComponent("/data/tileset 杭州塔")));
});

test("parseLocal3dTilesUrl：相对段按本机分隔符还原", { skip: !loaded }, () => {
  const base = "C:\\data\\tileset";
  const url = local3dTilesUrl(base).replace("/tileset.json", "/sub/dir/tile.b3dm");
  assert.equal(parseLocal3dTilesUrl(url), "C:\\data\\tileset\\sub\\dir\\tile.b3dm");
});

test("parseLocal3dTilesUrl：POSIX 基目录 + 根请求", { skip: !loaded }, () => {
  const url = local3dTilesUrl("/data/tileset");
  assert.equal(parseLocal3dTilesUrl(url), "/data/tileset/tileset.json");
});

test("parseLocal3dTilesUrl：非法结构抛错", { skip: !loaded }, () => {
  assert.throws(() => parseLocal3dTilesUrl("geolibre-local://tile"));
  assert.throws(() => parseLocal3dTilesUrl("http://example.com/tile/a/tileset.json"));
});
