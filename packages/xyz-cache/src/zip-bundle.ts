/**
 * editor/core · localCache/zipBundle —— 把缓存文件清单打包为 zip
 *
 * 仅依赖 JSZip；输入为 File[]（典型来自 webkitdirectory 选中目录），
 * 输出 { zip, fileCount, totalBytes }，可由 GisApiClient.uploadAsset 或
 * GisApiClient.publishScenePackage 直接消费。
 *
 * 路径约定（保持与导入时相对路径一致，便于服务端解包）：
 * - 入口路径即为 webkitRelativePath 的根目录段后部分
 * - 3D Tiles 数据集：保持根或一层目录内含 tileset.json
 * - XYZ 瓦片：按 {z}/{x}/{y}.<ext> 写入
 */
import JSZip from 'jszip';

import { normalizeRelativePath } from './detect';
import type { ZipBundleOptions, ZipBundleResult } from './types';

/** 单条 zip 写入项（不依赖 File，便于测试） */
export interface ZipInputEntry {
  /** zip 内的相对路径（POSIX 分隔符） */
  path: string;
  /** 文件内容（Blob / Uint8Array / ArrayBuffer / string） */
  data: Blob | Uint8Array | ArrayBuffer | string;
}

/**
 * 把若干缓存文件按相对路径打包为 zip。
 *
 * 支持两种调用形式：
 * 1. `zipCacheBundle(files: File[], opts?)`：从 webkitdirectory 选中的文件构建
 *    （取每项的 webkitRelativePath，去掉根目录段）
 * 2. `zipCacheBundle({ rootDir, entries }, opts?)`：显式给定根目录与 zip 路径
 *
 * 返回的 zip Blob 可直接经 GisApiClient.uploadAsset 上传为资产，或作为
 * PublishPackageBundle.zip 提交到 publishScenePackage。
 */
export async function zipCacheBundle(
  source: File[] | { rootDir: string; entries: ZipInputEntry[] },
  options: ZipBundleOptions = {},
): Promise<ZipBundleResult> {
  const zip = new JSZip();
  const level = options.compressionLevel ?? 6;
  const method: 'STORE' | 'DEFLATE' = options.compressionMethod === 'STORE' ? 'STORE' : 'DEFLATE';
  const useDeflate = method === 'DEFLATE' && level > 0;

  let fileCount = 0;
  let totalBytes = 0;
  const rootDir = Array.isArray(source) ? deriveRootDir(source) : source.rootDir;

  if (Array.isArray(source)) {
    for (const file of source) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
      if (!rel) continue;
      const normalized = normalizeRelativePath(rel);
      const parts = normalized.split('/');
      if (parts.length < 2) continue; // 跳过根目录自身
      const innerPath = parts.slice(1).join('/');
      const blob = await fileToBlob(file);
      zip.file(innerPath, blob, {
        compression: useDeflate ? 'DEFLATE' : 'STORE',
        compressionOptions: { level },
        // 嵌套路径默认会生成「目录条目」（尾斜杠条目），部分服务端 zip 安全校验会拒绝；
        // 文件条目在解包时自会隐式建目录，无需显式目录条目（t15 回归）。
        createFolders: false,
      });
      fileCount++;
      totalBytes += blob.size;
    }
  } else {
    for (const entry of source.entries) {
      const innerPath = normalizeRelativePath(entry.path);
      zip.file(innerPath, entry.data, {
        compression: useDeflate ? 'DEFLATE' : 'STORE',
        compressionOptions: { level },
        // 同上：不产生目录条目（t15 回归）
        createFolders: false,
      });
      fileCount++;
      totalBytes += blobLikeSize(entry.data);
    }
  }

  const finalBlob = await zip.generateAsync({
    type: 'blob',
    compression: method,
    compressionOptions: { level },
    // 可选进度观察（t29 导出缓存进度条）：不传 onProgress 时与旧行为逐字一致
    ...(options.onProgress
      ? {
          onUpdate: (metadata: { percent: number; currentFile: string | null }) => {
            try {
              options.onProgress?.({ percent: metadata.percent, currentFile: metadata.currentFile });
            } catch {
              // 进度回调异常不影响打包
            }
          },
        }
      : {}),
  });

  return { zip: finalBlob, fileCount, totalBytes };
}

/** 便捷：在已有 zip 内的所有路径前加一层 rootDir（保证 zip 解包后保留目录名） */
export async function wrapZipWithRootDir(
  zipBlob: Blob,
  rootDir: string,
  options: ZipBundleOptions = {},
): Promise<ZipBundleResult> {
  const level = options.compressionLevel ?? 6;
  const method: 'STORE' | 'DEFLATE' = options.compressionMethod === 'STORE' ? 'STORE' : 'DEFLATE';
  const outer = new JSZip();
  // JSZip.loadAsync 默认期望 Uint8Array；传 Blob 也兼容
  const inner = await outer.loadAsync(zipBlob as unknown as Uint8Array);
  // 把 inner 的条目全部复制到 outer.<rootDir>/
  const folder = outer.folder(rootDir);
  if (!folder) {
    throw new Error(`无法创建子目录：${rootDir}`);
  }
  let totalBytes = 0;
  let fileCount = 0;
  inner.forEach((relPath, fileObj) => {
    if (fileObj.dir) {
      folder.folder(relPath);
      return;
    }
    // 复制内容到子目录
    folder.file(relPath, fileObj.async('uint8array'));
    fileCount++;
  });
  // 计算 totalBytes（用原 zipBlob 的 size 近似；JSZip 没有总字节暴露）
  totalBytes = zipBlob.size;

  const wrapped = await outer.generateAsync({
    type: 'blob',
    compression: method,
    compressionOptions: { level },
  });
  return { zip: wrapped, fileCount, totalBytes };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function deriveRootDir(files: File[]): string {
  for (const file of files) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (!rel) continue;
    const first = normalizeRelativePath(rel).split('/')[0];
    if (first) return first;
  }
  return '';
}

async function fileToBlob(file: File): Promise<Blob> {
  return file instanceof Blob ? file : new Blob([file as BlobPart]);
}

function blobLikeSize(data: Blob | Uint8Array | ArrayBuffer | string): number {
  if (typeof data === 'string') return new Blob([data]).size;
  if (data instanceof Blob) return data.size;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.byteLength;
}

void JSZip;