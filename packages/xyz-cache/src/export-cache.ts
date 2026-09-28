/**
 * editor/core · localCache/exportCache —— 把本地缓存图层导出到本地磁盘
 *
 * 用户实测反馈（t29）：框选区域生成的缓存只能在编辑器内预览 / 发布，无法落到本地文件系统。
 * 本模块补齐「导出」链路，且**完全复用既有打包能力**（不重复实现）：
 *
 *   stores/localCacheRegistry（layerId → relPath → Blob 会话登记）
 *     → localCache.metadataToZipInputs（metadata.files → 打包入参，路径逐字一致）
 *     → zipBundle.zipCacheBundle（含 createFolders:false 的 zip 组装）
 *     → saveBlobAs：Electron 走原生「另存为」直接写盘，Web 走 <a download> 下载
 *
 * ZIP 结构与 `metadata.files[].path` **逐字一致**（与服务端 publishScenePackage 的
 * bundle 同构：XYZ 为 `{z}/{x}/{y}.<ext>`，3D Tiles 为 `tileset.json` + 模型/瓦片文件），
 * 因此导出的 ZIP 可以直接当作发布包复用。
 *
 * 大缓存保护：ZIP 会在渲染进程内组装完整 Blob，文件数 / 总字节超过阈值时**在打包前**
 * 抛出可读错误（ExportCacheError.code='too-large'），提示改用服务端目录托管或分批导出，
 * 避免一次性把 GB 级缓存读进内存导致标签页崩溃。
 *
 * 复用面（**打包与落盘不写死在对话框里**）：
 * - `buildZipBlob(entries, opts)`：任意「路径 → Blob/字节」条目 → ZIP（含上限保护与进度），
 *   t31「工程包导出」等场景直接复用；
 * - `saveBlobAs(blob, filename)` / `downloadBlob`：Electron 原生另存为优先，否则浏览器下载；
 * - `exportCacheFilename` / `formatExportTimestamp` / `EXPORT_ZIP_FILTERS`：命名与对话框过滤。
 */
import { normalizeRelativePath } from './detect';
import { metadataToZipInputs } from './local-cache';
import {
  isTemplateXyzLayer,
  type CacheFileEntry,
  type LocalCacheMetadata,
  type ZipBundleOptions,
} from './types';
import { zipCacheBundle, type ZipInputEntry } from './zip-bundle';

// ---------------------------------------------------------------------------
// 常量 / 错误
// ---------------------------------------------------------------------------

/** 单次导出的文件数上限（默认）：超过后 ZIP 组装会把渲染进程拖向 OOM */
export const EXPORT_MAX_FILES = 50_000;

/** 单次导出的原始字节上限（默认，约 1.4 GiB） */
export const EXPORT_MAX_BYTES = 1_500_000_000;

/** 模板按需加载图层（t25）无法导出时的可读提示（UI 与引擎共用同一份文案） */
export const TEMPLATE_LAYER_EXPORT_HINT =
  '该图层是「模板 + 层级范围」按需加载图层（导入时未枚举、未下载任何瓦片），没有文件清单，无法导出 ZIP。' +
  '请改用：① 服务端「引用本机瓦片目录（服务端托管）」直接引用该目录；' +
  '② 在缓存目录内生成 index.json 清单后用「清单导入」登记文件再导出。';

/** 导出失败的分类（UI 据此给不同引导） */
export type ExportCacheErrorCode =
  /** t25 模板按需加载图层：无文件清单 */
  | 'template'
  /** 会话登记表里没有内容（目录导入的 File 句柄已失效 / 需要重新生成） */
  | 'unavailable'
  /** 清单为空 */
  | 'empty'
  /** 清单中有文件在会话登记表里缺失（残缺包不导出） */
  | 'missing-files'
  /** 超过单次导出上限 */
  | 'too-large'
  /** 运行环境不支持下载（无 DOM / URL.createObjectURL） */
  | 'unsupported';

/** 导出相关错误（message 一律为可直接展示 / 记录的可读文案） */
export class ExportCacheError extends Error {
  readonly code: ExportCacheErrorCode;

  constructor(code: ExportCacheErrorCode, message: string) {
    super(message);
    this.name = 'ExportCacheError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 进度 / 结果类型
// ---------------------------------------------------------------------------

/** 导出阶段：collect 收集清单 → zip 组装压缩 → save 写盘/下载 */
export type ExportCachePhase = 'collect' | 'zip' | 'save';

export interface ExportCacheProgress {
  phase: ExportCachePhase;
  /** 已处理数量（文件数，单调不减） */
  processed: number;
  /** 总文件数 */
  total: number;
  /** 原始总字节 */
  totalBytes: number;
  /** 整体进度 0~1（zip 阶段来自 JSZip 的真实百分比） */
  ratio: number;
  /** 压缩结果字节数（zip 完成后可得） */
  zipBytes?: number;
}

export interface ExportCacheLimits {
  /** 文件数上限（默认 EXPORT_MAX_FILES；传 Number.POSITIVE_INFINITY 可关闭保护） */
  maxFiles?: number;
  /** 原始字节上限（默认 EXPORT_MAX_BYTES；传 Number.POSITIVE_INFINITY 可关闭保护） */
  maxBytes?: number;
}

/** 会话登记表：Map 或「按图层 id 取 Map」的函数（缺省用 stores/localCacheRegistry） */
export type ExportCacheRegistry =
  | Map<string, Blob>
  | ((layerId: string) => Map<string, Blob> | undefined)
  | undefined;

export interface ExportCacheOptions {
  /** 文件内容来源（通常传 stores 的 getLocalCacheFiles） */
  registry?: ExportCacheRegistry;
  /** 图层 metadata（cacheKind / files / rootDir / detection；通常来自 LayerSource.metadata） */
  metadata?: LocalCacheMetadata | Record<string, unknown> | undefined;
  /** 图层名（用于文件名与提示） */
  layerName?: string;
  /** 显式指定文件名（默认 `<图层名>-<yyyyMMdd-HHmmss>.zip`） */
  filename?: string;
  /** 大缓存上限覆盖 */
  limits?: ExportCacheLimits;
  /** 时间源（文件名时间戳；测试注入固定时间） */
  now?: Date | number;
  /** 进度回调（异常不影响导出） */
  onProgress?: (progress: ExportCacheProgress) => void;
  /** 传给 zipCacheBundle 的压缩选项（默认与服务端发布包一致：DEFLATE level 6） */
  zipOptions?: ZipBundleOptions;
}

export interface ExportCacheResult {
  /** 组装好的 zip Blob */
  blob: Blob;
  /** 建议文件名（已做安全化 + 时间戳） */
  filename: string;
  /** 包内文件数 */
  fileCount: number;
  /** 原始总字节（未压缩） */
  totalBytes: number;
  /** zip 字节数 */
  zipBytes: number;
  /** 缓存根目录名（metadata.rootDir，仅诊断/展示用） */
  rootDir: string;
  /** 缓存类型（metadata.cacheKind） */
  kind?: 'xyz' | '3dtiles';
}

// ---------------------------------------------------------------------------
// 通用打包（t31 等复用：条目 → ZIP）
// ---------------------------------------------------------------------------

/** 通用打包出参（与「图层 / 清单」无关，供 t31 工程包等场景复用） */
export interface BuiltZip {
  blob: Blob;
  fileCount: number;
  /** 原始总字节（未压缩） */
  totalBytes: number;
  /** zip 字节数 */
  zipBytes: number;
}

export interface BuildZipOptions {
  /** 缓存根目录名（仅诊断；zip 内路径以 entries[].path 为准，保证与 metadata.files 逐字一致） */
  rootDir?: string;
  /** 展示名（空包 / 超限提示用） */
  label?: string;
  /** 上限覆盖 */
  limits?: ExportCacheLimits;
  /** 传给 zipCacheBundle 的压缩选项 */
  zipOptions?: ZipBundleOptions;
  /** 进度（collect → zip，ratio 0.1~1） */
  onProgress?: (progress: ExportCacheProgress) => void;
}

/**
 * 通用「条目 → ZIP」打包（含大缓存上限保护与进度）。
 *
 * t29 的缓存导出与 t31 的工程包导出共用这一条打包函数：**打包逻辑不写死在对话框里**。
 * 条目路径原样写入 zip（经 normalizeRelativePath 归一），保证与服务端发布包同构。
 */
export async function buildZipBlob(
  entries: readonly ZipInputEntry[],
  options: BuildZipOptions = {},
): Promise<BuiltZip> {
  const list = [...entries];
  const label = options.label ?? '导出内容';
  if (list.length === 0) {
    throw new ExportCacheError('empty', `${label}为空，没有可打包的文件`);
  }
  const totalBytes = list.reduce((sum, entry) => sum + blobSize(entry.data), 0);
  assertExportWithinLimits(list.length, totalBytes, options.limits, label);

  const report = createProgressReporter(options.onProgress);
  report({
    phase: 'collect',
    processed: list.length,
    total: list.length,
    totalBytes,
    ratio: 0.1,
  });

  const { zip, fileCount, totalBytes: bundledBytes } = await zipCacheBundle(
    { rootDir: options.rootDir ?? '', entries: list },
    {
      ...(options.zipOptions ?? {}),
      onProgress: (progress) => {
        report({
          phase: 'zip',
          processed: Math.round((progress.percent / 100) * list.length),
          total: list.length,
          totalBytes,
          ratio: Math.max(0.1, Math.min(1, 0.1 + 0.9 * (progress.percent / 100))),
        });
      },
    },
  );

  report({
    phase: 'zip',
    processed: list.length,
    total: list.length,
    totalBytes,
    ratio: 1,
    zipBytes: zip.size,
  });

  return { blob: zip, fileCount, totalBytes: bundledBytes, zipBytes: zip.size };
}

// ---------------------------------------------------------------------------
// 导出主流程
// ---------------------------------------------------------------------------

/**
 * 把某个本地缓存图层导出为 ZIP。
 *
 * - 文件清单以 `metadata.files` 为准（逐字写入 zip 路径）；metadata 无清单时
 *   退化为「以会话登记表的 key 为路径」，保证生成缓存 / 目录导入两条链路都能导出；
 * - 任一条清单文件在会话登记表中缺失 → 抛错（不导出残缺包）；
 * - 文件数 / 字节超过上限 → 抛错并给出可读引导。
 */
export async function exportCacheLayer(
  layerId: string,
  options: ExportCacheOptions = {},
): Promise<ExportCacheResult> {
  const files = resolveRegistryFiles(options.registry, layerId);
  const meta = readCacheMetadata(options.metadata);
  const limits = resolveExportLimits(options.limits);
  const name = options.layerName?.trim() || layerId;

  if (meta.template || isTemplateXyzLayer(options.metadata as Record<string, unknown> | undefined)) {
    throw new ExportCacheError('template', TEMPLATE_LAYER_EXPORT_HINT);
  }
  if (!files || files.size === 0) {
    throw new ExportCacheError(
      'unavailable',
      `图层「${name}」的缓存文件不可用（本会话未登记内容）：` +
        '目录导入的缓存请重新选择目录导入，编辑器生成的缓存请重新生成后再导出。',
    );
  }

  const listed = meta.files;
  const registryBytes = sumBlobSizes(files.values());
  const listedBytes = listed.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0);
  const plannedBytes = meta.totalBytes ?? (listedBytes > 0 ? listedBytes : registryBytes);
  assertExportWithinLimits(listed.length > 0 ? listed.length : files.size, plannedBytes, limits, name);

  const resolver = (path: string): Blob | undefined =>
    files.get(path) ?? files.get(normalizeRelativePath(path));

  let inputs: { rootDir: string; entries: ZipInputEntry[] };
  if (listed.length > 0) {
    const missing = listed.filter((f) => !resolver(f.path));
    if (missing.length > 0) {
      throw new ExportCacheError(
        'missing-files',
        `图层「${name}」的缓存文件缺失：${missing.length}/${listed.length} 个（如 ${missing[0]!.path}）。` +
          '为避免导出残缺包已中止：目录导入的缓存请重新选择目录导入，生成的缓存请重新生成。',
      );
    }
    inputs = metadataToZipInputs(toMetadata(meta, plannedBytes), resolver);
  } else {
    // 无清单（非模板图层的历史 / 手工 metadata）：以登记表 key 为路径（与 metadata.files[].path 同源）
    inputs = {
      rootDir: meta.rootDir,
      entries: [...files.entries()].map(([path, data]) => ({ path: normalizeRelativePath(path), data })),
    };
  }

  if (inputs.entries.length === 0) {
    throw new ExportCacheError('empty', `图层「${name}」的缓存清单为空，没有可导出的文件`);
  }

  // 统一走通用打包（t31 复用同一条路径）：内部含实测字节上限校验 + 进度上报
  const built = await buildZipBlob(inputs.entries, {
    rootDir: inputs.rootDir,
    label: `图层「${name}」`,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.zipOptions ? { zipOptions: options.zipOptions } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const filename = options.filename
    ? sanitizeExportFilename(options.filename)
    : exportCacheFilename(name, options.now);

  return {
    blob: built.blob,
    filename,
    fileCount: built.fileCount,
    totalBytes: built.totalBytes,
    zipBytes: built.zipBytes,
    rootDir: inputs.rootDir,
    ...(meta.kind ? { kind: meta.kind } : {}),
  };
}

// ---------------------------------------------------------------------------
// 落盘：Electron 原生另存为 / Web 下载
// ---------------------------------------------------------------------------

/** Electron preload 的另存为请求（与 electron/preload.ts 的 SaveFileRequest 对齐） */
export interface DesktopSaveAsRequest {
  /** 建议文件名（另存为对话框默认名） */
  filename: string;
  /** 文件内容 */
  data: ArrayBuffer;
  /** 扩展名过滤 */
  filters?: Array<{ name: string; extensions: string[] }>;
  /** 对话框标题 */
  title?: string;
}

/** Electron preload 暴露的桌面桥（渲染侧最小结构；web 模式下不存在） */
export interface DesktopBridgeLike {
  /** 弹原生「另存为」并直接写盘，返回落盘绝对路径；用户取消返回 null */
  saveAs?: (request: DesktopSaveAsRequest) => Promise<string | null>;
  [key: string]: unknown;
}

/** 取 electron preload 暴露的 window.gisDesktop（web 模式返回 undefined） */
export function resolveDesktopBridge(
  scope?: { gisDesktop?: DesktopBridgeLike } | undefined,
): DesktopBridgeLike | undefined {
  const target =
    scope ??
    (typeof window !== 'undefined'
      ? (window as unknown as { gisDesktop?: DesktopBridgeLike })
      : undefined);
  const bridge = target?.gisDesktop;
  return bridge && typeof bridge === 'object' ? bridge : undefined;
}

/** 浏览器下载依赖（测试注入假 DOM / URL） */
export interface DownloadEnvironment {
  document?: Document;
  url?: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
  /** 对象 URL 释放延时（默认 1000ms；0 = 同步释放，测试用） */
  revokeDelayMs?: number;
}

/**
 * Web 端下载：`<a download>` + `URL.createObjectURL`，点击后立即移除锚点，
 * 对象 URL 延时释放（默认 1s，给浏览器留出读取时间）。
 * 返回创建的对象 URL（便于诊断 / 测试）。
 */
export function downloadBlob(blob: Blob, filename: string, env: DownloadEnvironment = {}): string {
  const doc = env.document ?? (typeof document !== 'undefined' ? document : undefined);
  const urlApi =
    env.url ?? (typeof URL !== 'undefined' ? (URL as unknown as DownloadEnvironment['url']) : undefined);
  if (!doc || !urlApi || typeof urlApi.createObjectURL !== 'function') {
    throw new ExportCacheError(
      'unsupported',
      '当前环境不支持浏览器下载（缺少 DOM / URL.createObjectURL）：桌面端请使用原生「另存为」，或在浏览器中打开编辑器。',
    );
  }

  const objectUrl = urlApi.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  doc.body.appendChild(anchor);
  anchor.click();
  doc.body.removeChild(anchor);

  const delay = env.revokeDelayMs ?? 1000;
  if (delay > 0 && typeof setTimeout === 'function') {
    setTimeout(() => urlApi.revokeObjectURL(objectUrl), delay);
  } else {
    urlApi.revokeObjectURL(objectUrl);
  }
  return objectUrl;
}

export type SaveBlobMethod = 'electron' | 'download' | 'canceled';

export interface SaveBlobResult {
  /** 实际使用的方式：electron 原生另存为 / download 浏览器下载 / canceled 用户取消 */
  method: SaveBlobMethod;
  /** electron 方式下的落盘绝对路径 */
  path?: string;
  /** 原生通道异常而回退下载时的原因 */
  fallbackReason?: string;
}

export interface SaveBlobOptions {
  /** 桌面桥（缺省自动读 window.gisDesktop；显式传 undefined 可强制 Web 下载） */
  desktop?: DesktopBridgeLike | undefined;
  /** 下载实现（测试注入） */
  download?: (blob: Blob, filename: string) => unknown;
  /** 下载环境（测试注入假 DOM） */
  downloadEnv?: DownloadEnvironment;
  /** 另存为对话框扩展名过滤 */
  filters?: Array<{ name: string; extensions: string[] }>;
  /** 另存为对话框标题 */
  title?: string;
}

/** zip 文件过滤（另存为对话框用） */
export const EXPORT_ZIP_FILTERS: Array<{ name: string; extensions: string[] }> = [
  { name: 'ZIP 压缩包', extensions: ['zip'] },
];

/**
 * 把 Blob 保存到本地：Electron 端优先走 preload 的原生「另存为」并直接写盘，
 * 其它情况回退浏览器下载。
 *
 * - 用户在原生对话框取消 → `{ method: 'canceled' }`，**不**再回退下载（避免二次弹窗）；
 * - 原生通道抛错（旧版 preload 未实现等）→ 回退下载并在 `fallbackReason` 说明原因。
 */
export async function saveBlobAs(
  blob: Blob,
  filename: string,
  options: SaveBlobOptions = {},
): Promise<SaveBlobResult> {
  const download = options.download ?? ((b: Blob, name: string) => downloadBlob(b, name, options.downloadEnv));
  const desktop = 'desktop' in options ? options.desktop : resolveDesktopBridge();

  if (desktop && typeof desktop.saveAs === 'function') {
    try {
      const data = await blob.arrayBuffer();
      const path = await desktop.saveAs({
        filename,
        data,
        filters: options.filters ?? EXPORT_ZIP_FILTERS,
        title: options.title ?? '导出缓存',
      });
      if (path) return { method: 'electron', path };
      return { method: 'canceled' };
    } catch (err) {
      const fallbackReason = err instanceof Error ? err.message : String(err);
      download(blob, filename);
      return { method: 'download', fallbackReason };
    }
  }

  download(blob, filename);
  return { method: 'download' };
}

export interface ExportCacheToDiskResult extends ExportCacheResult {
  /** 落盘方式（Electron 另存为 / 浏览器下载 / 用户取消） */
  save: SaveBlobResult;
}

/** 一步到位：打包 + 落盘（UI 三个入口共用；取消时同样返回结果，由调用方判定 save.method） */
export async function exportCacheToDisk(
  layerId: string,
  options: ExportCacheOptions & SaveBlobOptions = {},
): Promise<ExportCacheToDiskResult> {
  const result = await exportCacheLayer(layerId, options);
  const { desktop, download, downloadEnv, filters, title } = options;
  createProgressReporter(options.onProgress)({
    phase: 'save',
    processed: result.fileCount,
    total: result.fileCount,
    totalBytes: result.totalBytes,
    ratio: 1,
    zipBytes: result.zipBytes,
  });
  const save = await saveBlobAs(result.blob, result.filename, {
    ...('desktop' in options ? { desktop } : {}),
    ...(download ? { download } : {}),
    ...(downloadEnv ? { downloadEnv } : {}),
    ...(filters ? { filters } : {}),
    ...(title ? { title } : {}),
  });
  return { ...result, save };
}

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

/** 文件名非法字符（Windows / 跨平台通用） */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 图层名 → 文件名安全化（保留中文；去掉路径分隔符 / 非法字符 / 首尾点与空白） */
export function sanitizeFileBase(name: string, fallback = '缓存'): string {
  const cleaned = String(name ?? '')
    .replace(ILLEGAL_FILENAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 80)
    .replace(/[\s.-]+$/g, '');
  return cleaned || fallback;
}

/** `yyyyMMdd-HHmmss`（本地时间） */
export function formatExportTimestamp(now: Date | number = new Date()): string {
  const date = now instanceof Date ? now : new Date(now);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 建议文件名：`<图层名>-<yyyyMMdd-HHmmss>.zip` */
export function exportCacheFilename(layerName: string, now: Date | number = new Date()): string {
  return `${sanitizeFileBase(layerName)}-${formatExportTimestamp(now)}.zip`;
}

/** 安全化用户给定文件名（去掉目录段，补 .zip 后缀） */
export function sanitizeExportFilename(filename: string): string {
  const raw = String(filename ?? '').trim();
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const safe = sanitizeFileBase(base, 'cache-export');
  return /\.zip$/i.test(safe) ? safe : `${safe}.zip`;
}

// ---------------------------------------------------------------------------
// 进度文案（UI 共用）
// ---------------------------------------------------------------------------

/** 进度 → 可读文案（对话框 / 图层面板 / 输出窗共用同一份口径） */
export function describeExportProgress(progress: ExportCacheProgress): string {
  const bytes = formatBytesText(progress.totalBytes);
  switch (progress.phase) {
    case 'collect':
      return `正在整理缓存文件（${progress.total} 个 · ${bytes}）…`;
    case 'zip':
      return `正在打包 ZIP（${progress.total} 个文件 · ${bytes}）… ${Math.round(progress.ratio * 100)}%`;
    case 'save':
      return progress.zipBytes !== undefined
        ? `正在保存到本地（${formatBytesText(progress.zipBytes)}，原生「另存为」或浏览器下载）…`
        : '正在保存到本地文件…';
    default:
      return '正在导出…';
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

interface CacheMetadataView {
  kind?: 'xyz' | '3dtiles';
  files: CacheFileEntry[];
  totalBytes?: number;
  rootDir: string;
  cacheSource?: 'imported' | 'generated';
  detection?: LocalCacheMetadata['detection'];
  /** detection.sourceMode === 'template'（t25 免枚举图层） */
  template: boolean;
}

function readCacheMetadata(raw: LocalCacheMetadata | Record<string, unknown> | undefined): CacheMetadataView {
  const meta = (raw ?? {}) as Partial<LocalCacheMetadata> & { detection?: LocalCacheMetadata['detection'] };
  const kind = meta.cacheKind === 'xyz' || meta.cacheKind === '3dtiles' ? meta.cacheKind : undefined;
  const files = Array.isArray(meta.files)
    ? meta.files
        .filter((f): f is CacheFileEntry => !!f && typeof f.path === 'string' && f.path !== '')
        .map((f) => ({ path: f.path, size: Number.isFinite(f.size) ? f.size : 0 }))
    : [];
  return {
    ...(kind ? { kind } : {}),
    files,
    ...(Number.isFinite(meta.totalBytes) ? { totalBytes: meta.totalBytes as number } : {}),
    rootDir: typeof meta.rootDir === 'string' ? meta.rootDir : '',
    ...(meta.cacheSource ? { cacheSource: meta.cacheSource } : {}),
    ...(meta.detection ? { detection: meta.detection } : {}),
    template: meta.detection?.sourceMode === 'template',
  };
}

/** LocalCacheMetadata → metadataToZipInputs 需要的完整结构（rootDir / files 逐字保留） */
function toMetadata(meta: CacheMetadataView, totalBytes: number): LocalCacheMetadata {
  return {
    cacheKind: meta.kind ?? 'xyz',
    files: meta.files.map((f) => ({ path: f.path, size: f.size })),
    totalBytes,
    rootDir: meta.rootDir,
    ...(meta.cacheSource ? { cacheSource: meta.cacheSource } : {}),
    ...(meta.detection ? { detection: meta.detection } : {}),
  };
}

function resolveRegistryFiles(
  registry: ExportCacheRegistry,
  layerId: string,
): Map<string, Blob> | undefined {
  if (!registry) return undefined;
  return typeof registry === 'function' ? registry(layerId) : registry;
}

function resolveExportLimits(limits: ExportCacheLimits | undefined): Required<ExportCacheLimits> {
  const { maxFiles, maxBytes } = limits ?? {};
  return {
    // 显式传 Number.POSITIVE_INFINITY 可关闭保护（与 localCache.maxFiles 同一口径）
    maxFiles: typeof maxFiles === 'number' && !Number.isNaN(maxFiles) && maxFiles >= 0 ? maxFiles : EXPORT_MAX_FILES,
    maxBytes: typeof maxBytes === 'number' && !Number.isNaN(maxBytes) && maxBytes >= 0 ? maxBytes : EXPORT_MAX_BYTES,
  };
}

/** 大缓存保护：超过上限直接抛可读错误（打包前校验，避免 OOM） */
export function assertExportWithinLimits(
  fileCount: number,
  totalBytes: number,
  limits: ExportCacheLimits | undefined,
  layerName = '该图层',
): void {
  const { maxFiles, maxBytes } = resolveExportLimits(limits);
  if (fileCount <= maxFiles && totalBytes <= maxBytes) return;
  throw new ExportCacheError(
    'too-large',
    `${layerName}的缓存过大：${fileCount} 个文件 / ${formatBytesText(totalBytes)}，` +
      `超过单次导出的安全上限（${maxFiles} 个文件 / ${formatBytesText(maxBytes)}）。` +
      'ZIP 需要在渲染进程内组装完整内容，过大会导致浏览器内存溢出。建议：' +
      '① 用服务端「引用本机瓦片目录（服务端托管）」直接引用该目录，免上传免打包；' +
      '② 按层级 / 范围拆分缓存后分批导出；' +
      '③ 确需一次性导出可显式提高 limits（仍受浏览器可用内存限制）。',
  );
}

function createProgressReporter(
  onProgress: ((progress: ExportCacheProgress) => void) | undefined,
): (progress: ExportCacheProgress) => void {
  return (progress) => {
    if (!onProgress) return;
    try {
      onProgress(progress);
    } catch {
      // 进度回调异常不影响导出
    }
  };
}

function sumBlobSizes(values: Iterable<Blob>): number {
  let total = 0;
  for (const blob of values) total += blob.size;
  return total;
}

function blobSize(data: Blob | Uint8Array | ArrayBuffer | string): number {
  if (typeof data === 'string') return new Blob([data]).size;
  if (data instanceof Blob) return data.size;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.byteLength;
}

/** 字节数 → 可读文本（core 侧自带，避免 core 依赖 stores） */
function formatBytesText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
