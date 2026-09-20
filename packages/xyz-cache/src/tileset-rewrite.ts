/**
 * editor/core · localCache/tilesetRewrite —— tileset.json 内部 URI 重写（纯函数）
 *
 * Cesium 3D Tiles 通过 tileset.json 内部的 `content.uri` 或外部 tileset 引用
 * （外部 tileset）来加载 b3dm/glb 等资源。本地缓存时这些 URI 指向的是相对
 * 路径或原始字符串，Cesium 会以 tileset.json 的 URL 为基准做拼接 → 加载失败。
 *
 * 解决方案：把 tileset.json 与其关联文件打成 blob URL 映射表，再把 tileset.json
 * 文本里的引用全部重写为对应 blob URL，得到一份"内存里可被 Cesium 直接 fetch
 * 的 tileset JSON"。
 *
 * 本模块只负责纯函数层面的改写：
 * - rewriteTilesetContentUris：递归改写 { content.uri }、{ content.url }、
 *   顶层 { asset } 等字段
 * - rewriteExternalTilesetRefs：把外部 tileset 数组里的 ref 也改写
 */

import { normalizeRelativePath } from './detect';

/** 任意 tileset JSON（部分字段关心，其它透传） */
export interface TilesetNode {
  /** 内容资源 URI（相对路径或 http URL） */
  content?: { uri?: string; url?: string } & Record<string, unknown>;
  /** 子 tileset（外部引用数组） */
  children?: TilesetNode[];
  /** 资产对象（含 version / tilesetVersion） */
  asset?: Record<string, unknown>;
  /** 其它字段透传 */
  [key: string]: unknown;
}

/**
 * 把字符串 URI 重写为 blob URL；若不在映射表中则原样返回（http URL 等不需重写）。
 */
function rewriteUri(uri: string, urlMap: Map<string, string>): string {
  if (!uri) return uri;
  if (/^https?:\/\//i.test(uri)) return uri;
  if (uri.startsWith('blob:') || uri.startsWith('data:')) return uri;
  const normalized = normalizeRelativePath(uri);
  return urlMap.get(normalized) ?? uri;
}

/**
 * 递归改写单个 tileset 节点（修改并返回原对象；非破坏性可通过 structuredClone 预处理）。
 */
export function rewriteTilesetNode<T extends TilesetNode>(node: T, urlMap: Map<string, string>): T {
  if (node.content?.uri !== undefined) {
    node.content.uri = rewriteUri(node.content.uri, urlMap);
  }
  if (node.content?.url !== undefined && typeof node.content.url === 'string') {
    node.content.url = rewriteUri(node.content.url, urlMap);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) rewriteTilesetNode(child as TilesetNode, urlMap);
  }
  // asset.version / asset.tilesetVersion / 任意字符串字段不重写（通常无路径）
  return node;
}

/**
 * 整体改写 tileset JSON（外部 tileset 也递归处理）。
 * 返回的对象是传入对象的可变引用；如需保持不可变请传入 deepClone。
 */
export function rewriteTilesetJson<T extends TilesetNode>(root: T, urlMap: Map<string, string>): T {
  return rewriteTilesetNode(root, urlMap);
}

/**
 * 构造 URLMap：调用方从 File[] → Blob URL 后回填。
 * 返回的 map 为新对象，调用方可以继续调用 .set() 补充动态构建的 blob URL。
 */
export function buildEmptyUrlMap(): Map<string, string> {
  return new Map<string, string>();
}