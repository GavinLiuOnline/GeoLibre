/**
 * editor/core · localCache/bounds —— XYZ 缓存图层的地理范围（t30，纯函数）
 *
 * 背景（用户实测反馈 2）：导入/生成 XYZ 缓存后「视野停在 0,0，看不到图层」。
 * 根因是瓦片切片方案本身不含地理范围：Cesium 无法从 {z}/{x}/{y} 键推导数据在哪里。
 * 本模块把「瓦片键集合 / 模板层级 / 用户输入」归一为 lon/lat 矩形
 * `[minLon, minLat, maxLon, maxLat]`，供两条链路消费：
 * - 注册时传给 `LocalXyzImageryProvider({ bounds })` → `provider.rectangle`，
 *   限定 Cesium 只在数据范围内发请求，并让 `LayerManager.zoomTo` 能飞到数据处；
 * - 写入 `LocalCacheMetadata.bounds`，随场景保存/打开往返，属性面板可改（应用并重载）。
 *
 * 范围确定优先级（导入路径各自取舍，最终都落到 metadata.bounds）：
 * 1. 用户手动指定的 bounds（最高）；
 * 2. 瓦片键集合（tiles/tileBlobs 模式）：取**最大层级**的 min/max x,y → tileXToLon/tileYToLat；
 * 3. 模板模式：用户填了 bounds 就用，没填则按全球（tilingScheme.rectangle），
 *    由属性面板/导入对话框补填。
 *
 * 注意复用：Web Mercator 的 tileXToLon/tileYToLat 直接 import 自 generate2d
 * （单一实现来源）；TMS（y 自南向北）与 Geographic（经纬度直方格）的换算在此补充。
 */
import { MERCATOR_MAX_LAT, tileXToLon, tileYToLat } from './generate-2d';
import { crsBoundsFromTileKeys } from './proj4-tiling-scheme';
import type { XyzLayerCrs, XyzTilingMode } from './types';

/** 经纬度范围 [minLon, minLat, maxLon, maxLat]（十进制度，WGS84；与 generate2d.GeoBounds 同构） */
export type XyzLayerBounds = [number, number, number, number];

/** 从瓦片键集合计算范围的选项 */
export interface BoundsFromKeysOptions {
  /** 切片模式（默认 web-mercator）：决定 y → 纬度的换算 */
  tilingMode?: XyzTilingMode;
  /** TMS（Y 轴翻转，y 自南向北；默认 false = XYZ 自北向南） */
  tms?: boolean;
  /**
   * proj4 任意投影 CRS（t37）：给定时瓦片键按该 CRS 网格（2^z 方格均分 validBounds）
   * 反算 lon/lat，tilingMode 不参与计算（TMS 行序仍生效）。
   */
  crs?: XyzLayerCrs;
}

interface LevelExtents {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * 从瓦片键集合（`"z/x/y"`，即 LocalXyzImageryProvider 的 tiles/tileBlobs 键）
 * 计算 lon/lat 矩形：取**最大层级**的 min/max x,y，按切片方案换算为地理范围。
 *
 * - 返回 undefined：键集合为空 / 无合法键（模板模式没有键，走 globalBounds 或用户输入）；
 * - 范围是「数据瓦片覆盖」的并集：比生成 bbox 略大（整瓦片边缘），用于定位足够精确。
 */
export function boundsFromTileKeys(
  keys: Iterable<string>,
  options: BoundsFromKeysOptions = {},
): XyzLayerBounds | undefined {
  const tilingMode = options.tilingMode ?? 'web-mercator';
  const tms = options.tms ?? false;

  // t37：proj4 任意投影 → 委托 Proj4TilingScheme 的纯网格数学（同一网格约定实现）；
  // 网格/CRS 非法（可读错误）或无合法键时回退 undefined（调用方走用户输入/全球语义）。
  if (options.crs) {
    try {
      return crsBoundsFromTileKeys(keys, options.crs, tms);
    } catch {
      return undefined;
    }
  }

  let level = -1;
  let extents: LevelExtents | undefined;
  for (const key of keys) {
    const parts = String(key ?? '').split('/');
    if (parts.length !== 3) continue;
    const z = Number(parts[0]);
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0)) continue;
    if (!extents || z > level) {
      // 更高层级出现：以新层级重新开始统计（范围取最大层级）
      extents = { minX: x, maxX: x, minY: y, maxY: y };
      level = z;
      continue;
    }
    if (z !== level) continue; // 低于当前最大层级的键：跳过
    extents.minX = Math.min(extents.minX, x);
    extents.maxX = Math.max(extents.maxX, x);
    extents.minY = Math.min(extents.minY, y);
    extents.maxY = Math.max(extents.maxY, y);
  }
  if (!extents || level < 0) return undefined;

  const size = 2 ** level;
  let minLon: number;
  let maxLon: number;
  if (tilingMode === 'geographic') {
    // Cesium GeographicTilingScheme：level 0 有 **2×1** 个根瓦片（4326 经纬度直方格），
    // 即 level z 有 2^(z+1) 列、2^z 行 → lon = (x/2^(z+1))*360 - 180
    const columns = size * 2;
    minLon = (extents.minX / columns) * 360 - 180;
    maxLon = (Math.min(extents.maxX + 1, columns) / columns) * 360 - 180;
  } else {
    // Web Mercator XYZ：level 0 单根瓦片（2^z 列），x 自西向东，XYZ/TMS 一致
    minLon = tileXToLon(extents.minX, level);
    maxLon = tileXToLon(Math.min(extents.maxX + 1, size), level);
  }

  let minLat: number;
  let maxLat: number;
  if (tilingMode === 'geographic') {
    // Cesium GeographicTilingScheme：y 自北向南，lat = 90 - (y/2^z)*180
    if (tms) {
      minLat = (extents.minY / size) * 180 - 90;
      maxLat = ((extents.maxY + 1) / size) * 180 - 90;
    } else {
      maxLat = 90 - (extents.minY / size) * 180;
      minLat = 90 - ((extents.maxY + 1) / size) * 180;
    }
  } else if (tms) {
    // TMS：y 自南向北。TMS 瓦片 y_t 对应 XYZ 瓦片 y_n = 2^z - 1 - y_t。
    // 北边缘 = XYZ 北起瓦片 (2^z-1-maxY) 的上边缘；南边缘 = XYZ 瓦片 (2^z-minY) 的上边缘。
    maxLat = tileYToLat(size - 1 - extents.maxY, level);
    minLat = tileYToLat(size - extents.minY, level);
  } else {
    // 标准 XYZ：y 自北向南（tileYToLat(y) = 上边缘，tileYToLat(y+1) = 下边缘）
    maxLat = tileYToLat(extents.minY, level);
    minLat = tileYToLat(extents.maxY + 1, level);
  }

  return [minLon, Math.min(minLat, maxLat), maxLon, Math.max(minLat, maxLat)];
}

/**
 * 切片方案的全球范围（模板模式无键/未填 bounds 时的缺省 rectangle）：
 * - web-mercator：±Web Mercator 有效纬度（约 ±85.0511°）；
 * - geographic：±90°。
 */
export function globalBounds(tilingMode: XyzTilingMode = 'web-mercator'): XyzLayerBounds {
  const lat = tilingMode === 'geographic' ? 90 : MERCATOR_MAX_LAT;
  return [-180, -lat, 180, lat];
}

/**
 * 校验并归一化用户/元数据里的 bounds（不抛错）：
 * 合法返回同构元组，否则返回 undefined（含 NaN / 顺序颠倒 / 超出经纬度有效域）。
 */
export function normalizeBounds(value: unknown): XyzLayerBounds | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const nums = value.map((v) => Number(v));
  if (!nums.every((n) => Number.isFinite(n))) return undefined;
  const [minLon, minLat, maxLon, maxLat] = nums as XyzLayerBounds;
  if (minLon < -180 || minLon > 180 || maxLon < -180 || maxLon > 180) return undefined;
  if (minLat < -90 || minLat > 90 || maxLat < -90 || maxLat > 90) return undefined;
  if (minLon >= maxLon || minLat >= maxLat) return undefined;
  return [minLon, minLat, maxLon, maxLat];
}
