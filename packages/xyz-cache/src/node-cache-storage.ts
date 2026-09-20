/**
 * @geolibre/xyz-cache · node-cache-storage —— CacheStorage 的 Node 实现
 *
 * node:fs/promises 承担全部异步能力；node:fs 仅用于 createReadStream
 * （fsp 没有流式读 API）。行为与 xyz-disk 原直接调用 fs 的路径逐字一致。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';

import type {
  CacheBuffer,
  CacheDir,
  CacheDirent,
  CacheFileHandle,
  CacheReadStreamOptions,
  CacheStats,
  CacheStorage,
} from './cache-storage';

/** node:fs/promises + node:fs 的默认实现（xyz-disk 的缺省 storage） */
export class NodeCacheStorage implements CacheStorage {
  async realpath(path: string): Promise<string> {
    return fsp.realpath(path);
  }

  async stat(path: string): Promise<CacheStats> {
    return fsp.stat(path);
  }

  async readdir(path: string, options: { withFileTypes: true }): Promise<CacheDirent[]> {
    return fsp.readdir(path, options);
  }

  async readFile(path: string): Promise<CacheBuffer> {
    return fsp.readFile(path);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await fsp.writeFile(path, data);
  }

  async opendir(path: string): Promise<CacheDir> {
    return fsp.opendir(path);
  }

  async open(path: string, flags: string | number): Promise<CacheFileHandle> {
    return fsp.open(path, flags);
  }

  async mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined> {
    return fsp.mkdir(path, options);
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void> {
    await fsp.rm(path, options);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    await fsp.copyFile(src, dest);
  }

  createReadStream(path: string, options?: CacheReadStreamOptions): ReturnType<typeof fs.createReadStream> {
    return fs.createReadStream(path, options);
  }
}

/** 进程级共享默认实例（xyz-disk 各导出函数的缺省 storage） */
export const nodeCacheStorage: CacheStorage = new NodeCacheStorage();
