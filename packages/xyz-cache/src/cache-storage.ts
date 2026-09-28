/**
 * @geolibre/xyz-cache · cache-storage —— 磁盘缓存能力的可注入抽象
 *
 * xyz-disk（Electron 主进程磁盘瓦片管线）原先直接依赖 node:fs / node:fs/promises。
 * 为了让磁盘 IO 可替换（测试注入内存实现 / 未来其它后端），这里从 xyz-disk
 * **实际用到的 fs 能力**推导出一个最小接口：
 *
 * - realpath / stat：路径规范化与文件元数据（parseDiskDir、StreamingZipWriter）；
 * - readdir（恒 withFileTypes 语义）：顶层层级目录枚举（scanXyzDirectory）；
 * - opendir：惰性逐条遍历（有界扫描预算，不物化全量 Dirent 数组）；
 * - readFile / writeFile / mkdir / rm / copyFile：目录直拷导出与半成品清理；
 * - open：ZIP 主文件与中央目录临时文件的顺序写入句柄；
 * - createReadStream：流式 ZIP 的逐瓦片读取（恒定内存，1MB highWaterMark）。
 *
 * 类型与 node:fs 的返回结构**结构兼容**（fs.Stats / fs.Dirent / fs.Dir /
 * fsp.FileHandle 可直接赋给本接口），因此 Node 实现只是薄薄一层转发。
 */

import type { Readable } from 'node:stream';

/** 目录条目（结构兼容 fs.Dirent） */
export interface CacheDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** 文件元数据（结构兼容 fs.Stats 的实际使用面） */
export interface CacheStats {
  isFile(): boolean;
  isDirectory(): boolean;
  /** 字节数 */
  size: number;
  /** 修改时间（ZIP 条目 mtime） */
  mtime: Date;
}

/** 惰性目录句柄（结构兼容 fs.Dir） */
export interface CacheDir {
  read(): Promise<CacheDirent | null>;
  close(): Promise<void>;
}

/** 顺序写文件句柄（结构兼容 fsp.FileHandle 的实际使用面） */
export interface CacheFileHandle {
  write(buffer: Buffer): Promise<unknown>;
  close(): Promise<void>;
}

/** createReadStream 选项 */
export interface CacheReadStreamOptions {
  /** 读取块大小（字节） */
  highWaterMark?: number;
}

/** readFile 等返回的缓冲区（node:fs 语义） */
export type CacheBuffer = Buffer;

/**
 * 磁盘缓存存储抽象（xyz-disk 的全部 IO 都经由它）。
 * 默认实现为 {@link NodeCacheStorage}（node:fs/promises + node:fs）。
 */
export interface CacheStorage {
  /** realpath 规范化（软链解析为真实路径；失败 reject） */
  realpath(path: string): Promise<string>;
  /** 文件/目录元数据（失败 reject） */
  stat(path: string): Promise<CacheStats>;
  /** 枚举目录条目（withFileTypes 语义；失败 reject） */
  readdir(path: string, options: { withFileTypes: true }): Promise<CacheDirent[]>;
  /** 读整个文件（失败 reject） */
  readFile(path: string): Promise<CacheBuffer>;
  /** 写整个文件（覆盖；失败 reject） */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** 打开惰性遍历句柄（失败 reject） */
  opendir(path: string): Promise<CacheDir>;
  /** 打开顺序写句柄（flags 同 fs.open；失败 reject） */
  open(path: string, flags: string | number): Promise<CacheFileHandle>;
  /** 递归建目录 */
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  /** 删除文件/目录（force 语义同 fs.rm） */
  rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>;
  /** 文件直拷（不经过进程内存的整文件拷贝） */
  copyFile(src: string, dest: string): Promise<void>;
  /** 可读流（流式 ZIP 逐瓦片读取） */
  createReadStream(path: string, options?: CacheReadStreamOptions): Readable;
}
