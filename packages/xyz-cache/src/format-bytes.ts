/**
 * @geolibre/xyz-cache · format-bytes —— 字节数 → 可读文本
 *
 * 从 gis-full editor `stores/publishCollect.ts` 抽出的纯函数（scale.ts 原先
 * 跨层 import stores；本包内聚为工具模块，行为逐字一致）。
 */

/** 字节数 → 可读文本（B / KB / MB / GB；非有限值或负数返回 '-'） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
