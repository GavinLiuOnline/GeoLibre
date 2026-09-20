/**
 * editor/core · localCache/scale —— 超大场景护栏（t33）：公式法容量预估 + 分级阻断
 *
 * 用户场景：编辑器内可能对 GB 级 / 百万-十亿级本地 XYZ 瓦片缓存做"打包下载"、
 * "打包发布"、"工程包导出"、"按区域再生成"等动作。直接启动会让渲染进程在
 * 打包 / 物化阶段崩溃。
 *
 * 设计原则：
 * - **零 IO**：瓦片总数与字节估算全部用 2^z 网格与 bbox 求交（与 t34 服务端
 *   `exportJob.computeTileEstimate` 一致的公式法），不枚举源目录；
 * - **分级阻断**：根据 totalTiles 三档给可执行建议；
 * - **跨 antimeridian 拆分**：[minLon, maxLon] 跨 180° 时拆两段分别求和；
 * - **Web Mercator 极地钳制**：±85.0511287798066°。
 *
 * 与 t34 exportJob 的关系：
 * - 服务端 exportJob 服务的是「服务端流式导出」；
 * - 本模块服务的是「编辑器侧预估 + 阻断」——把分级阈值与建议路径暴露给 UI；
 *   公式法在两端独立实现（避免跨包引入服务端代码到浏览器侧）。
 */
import { MERCATOR_MAX_LAT, lonToTileX, latToTileY, MAX_GENERATE_ZOOM } from './generate-2d';
import { crsTilesInRange } from './proj4-tiling-scheme';
import type { XyzLayerCrs } from './types';
import { formatBytes } from './format-bytes';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 经纬度矩形：[minLon, minLat, maxLon, maxLat]（十进制度，WGS84） */
export type ScaleBounds = [number, number, number, number];

/** 容量档位（按 totalTiles 三档分级） */
export type ScaleClass = 'small' | 'large' | 'huge';

/** 单个层级的估算明细 */
export interface ScaleLevelInfo {
  zoom: number;
  /** 该层级候选瓦片数（公式法 = bbox 求交覆盖的瓦片数） */
  tiles: number;
  /** 该层级累计字节数（= tiles × bytesPerTile × blockSize 块开销系数） */
  bytes: number;
}

/** 估算结果 */
export interface ScaleEstimate {
  /** 候选瓦片总数（零 IO、公式法） */
  totalTiles: number;
  /** 原始字节估算（bytesPerTile × 块开销系数 × totalTiles） */
  totalBytes: number;
  /** 含 4KB 磁盘块开销的字节估算（用于"含块开销"展示） */
  totalBytesOnDisk: number;
  /** 按层级明细（minZoom..maxZoom；空数组表示 bounds 与墨卡托世界无交） */
  perLevel: ScaleLevelInfo[];
  /** 容量档位 */
  scale: ScaleClass;
  /** 是否与墨卡托世界无交（perLevel 全空） */
  empty: boolean;
}

/** 推荐路径（UI 据此给可执行引导） */
export type ScaleAdviceKind =
  | 'ok'
  | 'crop-bbox'
  | 'lower-maxzoom'
  | 'split-batches'
  | 'host-directory'
  | 'electron-desktop'
  | 'electron-server'
  | 'blocked';

/** 单条推荐路径 */
export interface ScaleAdvice {
  kind: ScaleAdviceKind;
  /** 可读中文标题 */
  title: string;
  /** 可读中文说明（包含操作步骤或命令） */
  detail: string;
}

/** scaleAdvice 输出 */
export interface ScaleAdviceResult {
  scale: ScaleClass;
  advice: ScaleAdvice[];
}

// ---------------------------------------------------------------------------
// 常量 / 默认值
// ---------------------------------------------------------------------------

/** 单瓦片平均字节数（PNG 256x256 含轻量样式 ≈ 4 KB；XYZ 影像多在 10-30 KB） */
export const DEFAULT_BYTES_PER_TILE = 8_192;

/** 4 KB 块开销系数（POSIX 文件系统大多数瓦片按 4 KB 取整） */
export const DEFAULT_BLOCK_SIZE = 4_096;

/** small/large 阈值（瓦片数）—— 超过即按 large 处理（编辑器侧打包仍可行） */
export const SCALE_LARGE_TILES = 50_000;

/** large/huge 阈值（瓦片数）—— 超过即按 huge 阻断浏览器侧打包 */
export const SCALE_HUGE_TILES = 2_000_000;

/** 字节上限（编辑器侧打包：超过给 huge 阻断 + 推荐服务端/桌面端） */
export const SCALE_HUGE_BYTES = 2_000_000_000; // 2 GB

/** 默认最低缩放级别 */
export const DEFAULT_MIN_ZOOM = 0;

/** 默认最高缩放级别（与 generate2d 一致） */
export const DEFAULT_MAX_ZOOM = MAX_GENERATE_ZOOM; // 22

// ---------------------------------------------------------------------------
// bounds 校验 / 归一化
// ---------------------------------------------------------------------------

/**
 * 把任意输入归一化为合法的 ScaleBounds：
 * - 数组 [a, b, c, d]
 * - 对象 { minLon, minLat, maxLon, maxLat }
 * - 经度钳制到 [-180, 180]、纬度钳制到 [-MERCATOR_MAX_LAT, MERCATOR_MAX_LAT]
 * - 退化/无效返回 undefined
 */
export function normalizeBoundsInput(value: unknown): ScaleBounds | undefined {
  let raw: number[] | undefined;
  if (Array.isArray(value)) {
    if (value.length !== 4) return undefined;
    raw = value as number[];
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    raw = [
      Number(obj.minLon ?? obj.west),
      Number(obj.minLat ?? obj.south),
      Number(obj.maxLon ?? obj.east),
      Number(obj.maxLat ?? obj.north),
    ];
  }
  if (!raw || !raw.every((n) => Number.isFinite(n))) return undefined;
  const [minLonRaw, minLatRaw, maxLonRaw, maxLatRaw] = raw;
  // 经度钳制 + 排序（保证 min < max；等号视为退化返回 undefined）
  const minLon = Math.max(-180, Math.min(180, minLonRaw));
  const maxLon = Math.max(-180, Math.min(180, maxLonRaw));
  // 纬度钳制到墨卡托有效域
  const minLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, minLatRaw));
  const maxLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, maxLatRaw));
  if (minLon >= maxLon || minLat >= maxLat) return undefined;
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * 拆 antimeridian：minLon > maxLon 时把 bounds 拆成两段求和。
 * 否则返回 [bounds] 单段。归一化后所有段均在合法域。
 */
function splitAntimeridian(bounds: ScaleBounds): ScaleBounds[] {
  const [minLon, minLat, maxLon, maxLat] = bounds;
  if (minLon <= maxLon) return [bounds];
  return [
    [minLon, minLat, 180, maxLat],
    [-180, minLat, maxLon, maxLat],
  ];
}

// ---------------------------------------------------------------------------
// 公式法：单段 / 单层瓦片数
// ---------------------------------------------------------------------------

/**
 * 单段 bounds × 单层的瓦片数（公式法，零 IO）。
 * 与 t20 tileRangeForExtent 同源：min/maxTileX 由经度反推、min/maxTileY 由纬度反推。
 *
 * t37：传 `crs` 时改走 proj4 网格公式（2^z 方格均分 validBounds，与 bounds 求交；
 * 投影包围盒近似**只多不少**，作为护栏是保守方向）；CRS 非法时按 0 计（不抛错，
 * 估算失败不应打断护栏分级）。
 */
export function tilesInRange(
  bounds: ScaleBounds,
  zoom: number,
  crs?: XyzLayerCrs,
): number {
  if (!Number.isInteger(zoom) || zoom < 0) return 0;
  if (crs) {
    try {
      return crsTilesInRange(bounds, zoom, crs);
    } catch {
      return 0;
    }
  }
  const segments = splitAntimeridian(bounds);
  let total = 0;
  for (const seg of segments) {
    const [minLon, minLat, maxLon, maxLat] = seg;
    if (minLon > maxLon || minLat > maxLat) continue;
    const n = 2 ** zoom;
    const minTileX = Math.max(0, Math.min(n - 1, lonToTileX(minLon, zoom)));
    const maxTileX = Math.max(0, Math.min(n - 1, lonToTileX(maxLon, zoom)));
    // Y 反转：north 取最小 y（最北），south 取最大 y（最南）
    const minTileY = Math.max(0, Math.min(n - 1, latToTileY(maxLat, zoom)));
    const maxTileY = Math.max(0, Math.min(n - 1, latToTileY(minLat, zoom)));
    const xCount = Math.max(0, maxTileX - minTileX + 1);
    const yCount = Math.max(0, maxTileY - minTileY + 1);
    total += xCount * yCount;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 公式法：bounds × 层级范围 → 估算
// ---------------------------------------------------------------------------

export interface ScaleEstimateOptions {
  bounds: ScaleBounds;
  minZoom?: number;
  maxZoom?: number;
  /** 单瓦片平均字节数（默认 DEFAULT_BYTES_PER_TILE） */
  bytesPerTile?: number;
  /** 块字节大小（默认 4096；0 表示不计算块开销） */
  blockSize?: number;
  /**
   * proj4 任意投影 CRS（t37，可选）：给定时瓦片数公式改为「该 CRS 的 2^z 方格网格
   * 与 bounds 求交」（非全球 CRS 满格 = 网格全量，用户 bounds 只做子范围裁剪）。
   */
  crs?: XyzLayerCrs;
}

/**
 * 公式法估算（零 IO）：
 * - totalTiles = Σ_{z=minZoom..maxZoom} tilesInRange(bounds, z)
 * - totalBytes = totalTiles × bytesPerTile
 * - totalBytesOnDisk = totalTiles × max(bytesPerTile, blockSize)
 *
 * 与 t34 exportJob.computeTileEstimate 公式一致（不枚举源目录、不读瓦片内容），
 * 适合"启动前预估"：44.8 亿瓦片规模也能在百毫秒内返回。
 */
export function estimateXyzScale(options: ScaleEstimateOptions): ScaleEstimate {
  const minZoom = Math.max(0, Math.floor(options.minZoom ?? DEFAULT_MIN_ZOOM));
  const maxZoom = Math.min(
    MAX_GENERATE_ZOOM,
    Math.max(minZoom, Math.floor(options.maxZoom ?? DEFAULT_MAX_ZOOM)),
  );
  const bytesPerTile =
    Number.isFinite(options.bytesPerTile) && (options.bytesPerTile ?? 0) > 0
      ? (options.bytesPerTile as number)
      : DEFAULT_BYTES_PER_TILE;
  const blockSizeRaw = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const blockSize = Number.isFinite(blockSizeRaw) && blockSizeRaw >= 0 ? blockSizeRaw : DEFAULT_BLOCK_SIZE;

  const perLevel: ScaleLevelInfo[] = [];
  let totalTiles = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    // t37：crs 给定时必须传入（proj4 网格公式与 bounds 求交），否则估算按内置方案算、
    // 对非全球 CRS 会把「网格满格」误算成「全球 4^z」而虚高数倍。
    const tiles = tilesInRange(options.bounds, z, options.crs);
    if (tiles > 0) {
      perLevel.push({
        zoom: z,
        tiles,
        bytes: tiles * bytesPerTile,
      });
      totalTiles += tiles;
    }
  }
  const totalBytes = totalTiles * bytesPerTile;
  const tileBytesOnDisk = blockSize > 0 ? Math.max(bytesPerTile, blockSize) : bytesPerTile;
  const totalBytesOnDisk = totalTiles * tileBytesOnDisk;
  const scale = classifyScale(totalTiles);
  return {
    totalTiles,
    totalBytes,
    totalBytesOnDisk,
    perLevel,
    scale,
    empty: totalTiles === 0,
  };
}

// ---------------------------------------------------------------------------
// 分级 / 推荐路径
// ---------------------------------------------------------------------------

/**
 * 容量档位（三档）：
 * - small  : ≤ SCALE_LARGE_TILES          —— 编辑器侧打包安全
 * - large  : ≤ SCALE_HUGE_TILES           —— 编辑器侧打包仍有风险，建议先估算
 * - huge   : > SCALE_HUGE_TILES 或字节超限 —— 编辑器侧打包必须阻断
 */
export function classifyScale(totalTiles: number, totalBytes?: number): ScaleClass {
  if (Number.isFinite(totalBytes) && totalBytes !== undefined && totalBytes > SCALE_HUGE_BYTES) {
    return 'huge';
  }
  if (totalTiles > SCALE_HUGE_TILES) return 'huge';
  if (totalTiles > SCALE_LARGE_TILES) return 'large';
  return 'small';
}

/**
 * 推荐路径（按档位 + 选项生成可执行建议）：
 * - small → 仅返回 ok
 * - large → 裁剪 bbox / 降 maxZoom / 分批
 * - huge  → 服务端目录托管 / 服务端流式导出 / Electron 桌面端
 */
export function scaleAdvice(estimate: ScaleEstimate, options: ScaleEstimateOptions = { bounds: [0, 0, 0, 0] }): ScaleAdviceResult {
  const out: ScaleAdvice[] = [];
  const scale = estimate.scale;
  if (estimate.empty) {
    return { scale: 'small', advice: [{ kind: 'ok', title: '范围与瓦片世界无交', detail: '当前 bounds 与墨卡托世界无交，无需打包' }] };
  }

  if (scale === 'small') {
    out.push({
      kind: 'ok',
      title: '容量安全',
      detail: `共 ${estimate.totalTiles.toLocaleString()} 个瓦片 · ${formatBytes(estimate.totalBytes)}，可继续编辑器侧打包`,
    });
    return { scale, advice: out };
  }

  if (scale === 'large') {
    out.push({
      kind: 'ok',
      title: '容量在可处理范围',
      detail: `共 ${estimate.totalTiles.toLocaleString()} 个瓦片 · ${formatBytes(estimate.totalBytes)}，编辑器侧可继续，但建议先裁剪 / 分批`,
    });
    const minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;
    const maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM;
    if (maxZoom - minZoom >= 2) {
      out.push({
        kind: 'lower-maxzoom',
        title: '降低 maxZoom',
        detail: `把 maxZoom 从 ${maxZoom} 降至 ${maxZoom - 1} 可减少约 75% 瓦片数`,
      });
    }
    out.push({
      kind: 'crop-bbox',
      title: '裁剪 bbox 到子区域',
      detail: '把范围收缩到当前子区域再导出，避免一次性拉取全球瓦片',
    });
    out.push({
      kind: 'split-batches',
      title: '分批导出',
      detail: '按层级 / 范围拆成多个子集目录分别打包，单次控制瓦片数 ≤ ' + SCALE_LARGE_TILES.toLocaleString(),
    });
    return { scale, advice: out };
  }

  // huge
  out.push({
    kind: 'blocked',
    title: '超出编辑器侧打包上限',
    detail: `共 ${estimate.totalTiles.toLocaleString()} 个瓦片 · ${formatBytes(estimate.totalBytesOnDisk)}` +
      '（含 4KB 块开销）。编辑器侧 ZIP 打包在渲染进程内组装完整内容，必然崩溃',
  });
  out.push({
    kind: 'electron-server',
    title: '服务端流式导出（推荐）',
    detail: '添加数据 → 引用本机瓦片目录（服务端托管）→ 服务端按 bounds / minZoom / maxZoom 裁剪 + 恒定内存流式打包；服务端导出端点 POST /api/exports',
  });
  out.push({
    kind: 'host-directory',
    title: '服务端目录托管',
    detail: '服务端 GIS_HOST_DIR_ROOTS 配置后，「添加数据 → 引用本机瓦片目录（服务端托管）」按 URL 引用，零拷贝、可即时加载',
  });
  out.push({
    kind: 'electron-desktop',
    title: 'Electron 桌面端（主进程流式）',
    detail: 'Electron 主进程用 fs 流式读瓦片 + 流式 ZIP，可处理 GB 级；Web 端不支持',
  });
  const minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;
  const maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM;
  if (maxZoom - minZoom >= 3) {
    out.push({
      kind: 'lower-maxzoom',
      title: '降低 maxZoom',
      detail: `把 maxZoom 从 ${maxZoom} 降至 ${maxZoom - 2} 可减少约 94% 瓦片数`,
    });
  }
  out.push({
    kind: 'crop-bbox',
    title: '大幅裁剪 bbox',
    detail: '把范围收缩到 1°×1° 量级的子区域再导出',
  });
  return { scale, advice: out };
}

// ---------------------------------------------------------------------------
// 高层：便捷接口（对话框 / 工具栏直接调用）
// ---------------------------------------------------------------------------

/**
 * 把 estimate + advice 合并成 UI 用的可读摘要：
 * - 一行总量
 * - 三档分级标签
 * - 推荐路径条目
 */
export interface ScaleSummary {
  estimate: ScaleEstimate;
  advice: ScaleAdviceResult;
  /** 一行摘要文本（中文） */
  headline: string;
  /** 总量（含块开销）文本 */
  bytesOnDiskLabel: string;
  /** 总量（纯字节）文本 */
  bytesLabel: string;
}

export function summarizeScale(
  options: ScaleEstimateOptions,
): ScaleSummary {
  const estimate = estimateXyzScale(options);
  const advice = scaleAdvice(estimate, options);
  return {
    estimate,
    advice,
    headline: `${estimate.totalTiles.toLocaleString()} 个瓦片 · ${formatBytes(estimate.totalBytes)}` +
      `（含块开销 ${formatBytes(estimate.totalBytesOnDisk)}）— ${adviceLabel(estimate.scale)}`,
    bytesLabel: formatBytes(estimate.totalBytes),
    bytesOnDiskLabel: formatBytes(estimate.totalBytesOnDisk),
  };
}

function adviceLabel(scale: ScaleClass): string {
  if (scale === 'small') return '容量安全';
  if (scale === 'large') return '容量在可处理范围';
  return '超出编辑器侧打包上限';
}
