/**
 * editor/core · localCache/tilesetCache —— 3D Tiles 缓存导入与预览
 *
 * 工作流：
 * 1. 接受 webkitdirectory 选中的 File[]，探测 tileset.json 入口
 * 2. 把 tileset.json 内的 content.uri、外部 tileset 引用都打成 blob URL 映射表
 *    （递归处理子 tileset）
 * 3. 生成一份"内存版 tileset.json"（blob URL 重写完毕），整体打包为 Blob
 *    再生成 blob URL，喂给 Cesium3DTileset.fromUrl
 * 4. 注册为 3dtiles 图层并附加 LocalCacheMetadata
 *
 * 注意（口径与 README「已知限制」⑤ / docs/architecture.md 一致）：
 * 只在**单个** tileset.json 内部把 `root` 与 `root.children[]`（含多级 children 子孙）
 * 的 `content.uri` / `content.url` 递归改写为 blob URL（root 层缺口由 t16 修复）。
 * 当数据集采用**外部 tileset 拆分**（`children[].content.uri` 指向另一个 tileset.json）时，
 * 该引用本身会被改写成**子 tileset 的 blob URL**，但**子 tileset JSON 内部的相对 URI
 * 不会二次改写**（blob URL 无目录语义，相对路径无法再解析）——完整闭环需要
 * 「fetch(blobUrl) → JSON.parse → 再改写 → 新建 Blob / blob URL 替换」的多级递归，
 * 该流程尚未实现。单层结构数据集预览正常；外部拆分数据集请先内联为单一 tileset.json
 * （3d-tiles-tools combine），或直接走一键发布由服务端按真实文件路径托管。
 *
 * 结构兼容（t16）：真实 3D Tiles 1.1 / 1.0 数据集的内容挂在 **root 层**
 * （`{ asset, geometricError, root: { content, children } }`），而 rewriteTilesetJson
 * 处理的是「tile 节点形态」（content/children 直接挂在传入节点上）。
 * 因此这里统一经 applyTilesetRootRewrite 对 `root` 再递归补写一次，
 * 保证 root.content.uri / root.children[] 逐级也被改成 blob URL。
 */
import { Cesium3DTileset } from 'cesium';

import { detectTileset, flattenDirectoryFiles, normalizeRelativePath } from './detect';
import type { FlattenedFile } from './detect';
import { rewriteTilesetJson, rewriteTilesetNode } from './tileset-rewrite';
import type { TilesetNode } from './tileset-rewrite';
import type { LocalCacheMetadata, TilesetCacheImportOptions } from './types';

/**
 * 从 File[] 与 tileset.json 入口构造 blob URL 映射表（含 tileset.json 自身）。
 * 返回值既包含所有 b3dm / glb / i3dm / sub-json 等相对路径 → blob URL。
 */
export function buildTilesetUrlMap(
  items: FlattenedFile[],
  tilesetRelPath: string,
): { urlMap: Map<string, string>; tilesetBlobUrl: string | undefined } {
  const urlMap = new Map<string, string>();
  let tilesetBlobUrl: string | undefined;
  for (const item of items) {
    const normalized = normalizeRelativePath(item.relPath);
    const url = URL.createObjectURL(item.file);
    urlMap.set(normalized, url);
    if (normalized === normalizeRelativePath(tilesetRelPath)) {
      tilesetBlobUrl = url;
    }
  }
  return { urlMap, tilesetBlobUrl };
}

/** 加载 tileset.json 文本（File 读取） */
export async function loadTilesetJsonText(file: File): Promise<string> {
  return file.text();
}

/** 解析 + 重写 tileset JSON 字符串；返回新对象 */
export function rewriteTilesetJsonText(text: string, urlMap: Map<string, string>): TilesetNode {
  const json = JSON.parse(text) as TilesetNode;
  return applyTilesetRootRewrite(rewriteTilesetJson(json, urlMap), urlMap);
}

/**
 * 对真实 tileset.json 的 `root` 层递归补写（t16，与 generate3d.importGeneratedCacheToLayers 同源方案）。
 *
 * `rewriteTilesetJson` 只认识「tile 节点形态」（content/children 挂在传入对象上），
 * 而真实数据集的 content 挂在 `root` 上，因此必须对 `root` 再调用一次
 * `rewriteTilesetNode`（其内部会递归 `children`，多级子孙一并覆盖）。
 *
 * 容错：`root` 缺失 / 非对象（扁平 tile 节点形态的旧样例）时原样返回，
 * 此时顶层改写结果仍然有效。
 */
function applyTilesetRootRewrite<T extends TilesetNode>(node: T, urlMap: Map<string, string>): T {
  const root = node.root as TilesetNode | undefined;
  if (root && typeof root === 'object') {
    rewriteTilesetNode(root, urlMap);
  }
  return node;
}

/**
 * 完整 3D Tiles 预览入口：
 * - 读 tileset.json
 * - 构造 urlMap
 * - 改写 URI → 新 tileset JSON → Blob → blob URL
 * - Cesium3DTileset.fromUrl 加载
 *
 * 返回 { tileset, urlMap, rootTileset, tilesetBlobUrl }，由上层注册到 LayerManager。
 */
export interface PrepareTilesetResult {
  /** Cesium3DTileset 实例 */
  tileset: Cesium3DTileset;
  /** 全部 urlMap（供释放时 revoke） */
  urlMap: Map<string, string>;
  /** 重写后的 tileset JSON 文本（Blob URL 形态） */
  tilesetBlobUrl: string;
  /** 探测到的入口 tileset 路径 */
  tilesetPath: string;
}

export async function prepareLocalTileset(
  items: FlattenedFile[],
  options: TilesetCacheImportOptions,
): Promise<PrepareTilesetResult> {
  const tilesetHit = detectTileset(items) ?? (options.tilesetPath
    ? { path: options.tilesetPath, base: options.tilesetPath.split('/').pop()?.toLowerCase() ?? '' }
    : undefined);
  if (!tilesetHit) {
    throw new Error('3D Tiles 缓存目录未找到 tileset.json 入口');
  }

  const { urlMap, tilesetBlobUrl } = buildTilesetUrlMap(items, tilesetHit.path);
  const tilesetFile = items.find((it) => normalizeRelativePath(it.relPath) === normalizeRelativePath(tilesetHit.path));
  if (!tilesetFile || !tilesetBlobUrl) {
    throw new Error(`未找到 tileset.json 文件：${tilesetHit.path}`);
  }

  const raw = await loadTilesetJsonText(tilesetFile.file);
  const rewritten = rewriteTilesetJsonText(raw, urlMap);
  const blob = new Blob([JSON.stringify(rewritten)], { type: 'application/json' });
  const newTilesetBlobUrl = URL.createObjectURL(blob);

  const tileset = await Cesium3DTileset.fromUrl(newTilesetBlobUrl, {
    maximumScreenSpaceError: options.maximumScreenSpaceError ?? 16,
  });

  return {
    tileset,
    urlMap,
    tilesetBlobUrl: newTilesetBlobUrl,
    tilesetPath: tilesetHit.path,
  };
}

/** 释放 buildTilesetUrlMap 创建的全部 blob URL */
export function revokeTilesetUrlMap(urlMap: Map<string, string>): void {
  for (const url of urlMap.values()) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}

/** 为发布打包/UI 提供：把 3D Tiles 导入结果（不含 Cesium 引用）的轻量元数据抽出 */
export function extractTilesetMetadata(
  items: FlattenedFile[],
  rootDir: string,
  tilesetPath: string,
): LocalCacheMetadata {
  let totalBytes = 0;
  for (const it of items) totalBytes += it.size;
  return {
    cacheKind: '3dtiles',
    files: items.map((it) => ({ path: normalizeRelativePath(it.relPath), size: it.size })),
    totalBytes,
    rootDir,
    detection: { tilesetPath },
  };
}

export { detectTileset, flattenDirectoryFiles };