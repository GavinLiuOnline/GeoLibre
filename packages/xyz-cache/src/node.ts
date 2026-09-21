/*
  @geolibre/xyz-cache/node —— Node 专属入口（磁盘瓦片管线）

  xyz-disk / node-cache-storage 依赖 node:fs 与 node:crypto，仅可在
  Node 环境（桌面主进程 / Phase 3 sidecar / 测试）引用。浏览器 bundle
  一律走包主入口 "."，否则 Vite 会把 node:crypto 外置导致启动失败
  （Phase 2 PR5 回归已修复：主入口不再传递性引入这两个模块）。
*/
export * from './xyz-disk';
export { NodeCacheStorage, nodeCacheStorage } from './node-cache-storage';
export type { CacheStorage } from './cache-storage';
