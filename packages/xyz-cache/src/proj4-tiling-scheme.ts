/**
 * editor/core · localCache/proj4TilingScheme —— proj4 任意投影的自定义 Cesium TilingScheme（t37）
 *
 * 背景：XYZ 缓存图层的坐标系此前只有 web-mercator / geographic 两种内置切片（t30）；
 * 用户要求支持「配准的所有都可以，包括 proj4」。本模块把「proj4 定义 + 有效范围」
 * 变成一个结构兼容 Cesium.TilingScheme 的切片方案：
 *
 * - 网格：2^z 方格**均分 validBounds 的投影包围盒**（tileMatrix='square-2^z'，默认）；
 *   经纬度类缓存可选 'geodetic-2x1'（level 0 有 2×1 个根瓦片，2^(z+1)×2^z，与
 *   Cesium GeographicTilingScheme / GeoServer EPSG4326 GridSet 一致）；
 * - 原点：'top-left'（XYZ 标准，y 自北向南，默认）或 'bottom-left'（TMS 行序）；
 * - tileXYToRectangle：投影坐标方格四角（+ 四边中点，收敛非凸投影的包围矩形）
 *   经 proj4 **反算**为 lon/lat → Cesium.Rectangle（弧度）；
 * - positionToTileXY：lon/lat **正算**回投影坐标 → 网格行列号（方案矩形之外返回
 *   undefined，与 Cesium 内置切片方案约定一致——ImageryLayer 据此跳过无关瓦片）；
 * - projection：MapProjection 结构对象（project/unproject 走 proj4），native rectangle
 *   为投影坐标（米），与 WebMercatorTilingScheme 的 native=米 同构。
 *
 * 模块同时导出**纯 proj4 网格数学**（无 Cesium 依赖的包围盒 / 行列换算），供
 * bounds.ts（瓦片键 → lon/lat）与 scale.ts（容量估算）复用——保证「网格约定」
 * 只有一份实现。
 *
 * 精度说明：Cesium Rectangle 是 lon/lat 轴对齐矩形；对强非线性投影（如圆锥投影）
 * 瓦片真实脚印是曲边四边形，这里用「四角 + 四边中点」采样的外包矩形近似——这是
 * 客户端渲染投影瓦片的标准做法，属性面板的「投影范围预览」可人工确认落位。
 */
import { Cartesian2, Cartesian3, Ellipsoid, Rectangle } from 'cesium';
import type { Cartographic, TilingScheme } from 'cesium';
import proj4 from 'proj4';

/** proj4 Converter 的结构化最小类型（@types/proj4 为 export= 风格，
 * 命名空间类型访问在 composite/whitelisted-types 工程下不可移植，此处只依赖实际成员） */
interface Proj4Converter {
  forward: (coords: number[]) => number[];
  inverse: (coords: number[]) => number[];
}


import {
  crsToLonLatConverter,
  lonLatToCrsConverter,
  isGeographicProj4Def,
  normalizeCrsValidBounds,
  validateProj4Def,
} from './crs-registry';
import type { XyzCrsTileMatrix, XyzLayerCrs } from './types';

// ---------------------------------------------------------------------------
// 纯 proj4 网格数学（无 Cesium；bounds.ts / scale.ts 复用）
// ---------------------------------------------------------------------------

/** proj4 网格的完整规格（由 XyzLayerCrs 补齐缺省值） */
export interface Proj4GridSpec {
  proj4: string;
  validBounds: [number, number, number, number];
  origin: 'top-left' | 'bottom-left';
  tileMatrix: XyzCrsTileMatrix;
  /** level 0 的列数（square-2^z: 1；geodetic-2x1: 2） */
  rootX: number;
  /** level 0 的行数（square-2^z: 1；geodetic-2x1: 1） */
  rootY: number;
  /** 投影包围盒（validBounds 8 点采样的外包盒，米） */
  projBounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** 采样 validBounds（4 角 + 4 边中点）并正算为投影包围盒；任何一点非有限 → undefined */
export function projectedBoundsOfCrs(
  proj4Def: string,
  validBounds: readonly [number, number, number, number],
): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  const [minLon, minLat, maxLon, maxLat] = validBounds;
  const midLon = (minLon + maxLon) / 2;
  const midLat = (minLat + maxLat) / 2;
  const samples: Array<[number, number]> = [
    [minLon, minLat],
    [minLon, maxLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [midLon, minLat],
    [midLon, maxLat],
    [minLon, midLat],
    [maxLon, midLat],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let converter: Proj4Converter;
  try {
    converter = lonLatToCrsConverter(proj4Def);
  } catch {
    return undefined;
  }
  for (const [lon, lat] of samples) {
    let p: [number, number] | undefined;
    try {
      const out = converter.forward([lon, lat]);
      if (Array.isArray(out) && Number.isFinite(out[0]) && Number.isFinite(out[1])) {
        p = [out[0], out[1]];
      }
    } catch {
      p = undefined;
    }
    if (!p) return undefined;
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  return { minX, minY, maxX, maxY };
}

/** tileMatrix → level 0 网格（列, 行） */
export function rootTilesOf(tileMatrix: XyzCrsTileMatrix): { x: number; y: number } {
  return tileMatrix === 'geodetic-2x1' ? { x: 2, y: 1 } : { x: 1, y: 1 };
}

/**
 * 把 XyzLayerCrs 归一为网格规格（不校验 proj4 可用性——调用方决定错误策略；
 * projBounds 无法计算时抛可读错误）。
 */
export function proj4GridSpecOf(crs: XyzLayerCrs): Proj4GridSpec {
  const origin = crs.origin ?? 'top-left';
  const tileMatrix = crs.tileMatrix ?? 'square-2^z';
  const geographic = isGeographicProj4Def(crs.proj4);
  const bounds = normalizeCrsValidBounds(crs.validBounds, { geographic });
  if (!bounds) {
    throw new Error(
      `CRS 有效范围非法：[minLon, minLat, maxLon, maxLat]（min < max，经度 -180~180，` +
        `纬度${geographic ? ' -90~90' : ' 严格 -90~90 之间'}），实际 ${JSON.stringify(crs.validBounds)}`,
    );
  }
  const projBounds = projectedBoundsOfCrs(crs.proj4, bounds);
  if (!projBounds) {
    throw new Error(
      `CRS 定义不可用：无法在有效范围内完成投影正算（proj4 定义「${crs.proj4}」）`,
    );
  }
  const root = rootTilesOf(tileMatrix);
  return { proj4: crs.proj4, validBounds: bounds, origin, tileMatrix, rootX: root.x, rootY: root.y, projBounds };
}

/** 某层级的网格参数（列数 / 行数 / 单格投影尺寸） */
export function gridAtLevel(spec: Proj4GridSpec, level: number): { cols: number; rows: number; cellW: number; cellH: number } {
  const cols = spec.rootX * 2 ** level;
  const rows = spec.rootY * 2 ** level;
  return {
    cols,
    rows,
    cellW: (spec.projBounds.maxX - spec.projBounds.minX) / cols,
    cellH: (spec.projBounds.maxY - spec.projBounds.minY) / rows,
  };
}

/**
 * 投影坐标 → 网格行列号（越界返回 undefined）。
 * 返回的 x/y 对应 Cesium 请求的 XYZ 行列（origin='bottom-left' 时 y 自南向北，即 TMS 行序）。
 */
export function crsPositionToTile(
  spec: Proj4GridSpec,
  level: number,
  projX: number,
  projY: number,
): { x: number; y: number } | undefined {
  const { cols, rows, cellW, cellH } = gridAtLevel(spec, level);
  const { minX, minY, maxX, maxY } = spec.projBounds;
  if (projX < minX || projX > maxX || projY < minY || projY > maxY) return undefined;
  const col = Math.min(cols - 1, Math.max(0, Math.floor((projX - minX) / cellW)));
  const row = spec.origin === 'top-left'
    ? Math.min(rows - 1, Math.max(0, Math.floor((maxY - projY) / cellH)))
    : Math.min(rows - 1, Math.max(0, Math.floor((projY - minY) / cellH)));
  return { x: col, y: row };
}

/** 瓦片 (x, y, level) 的投影坐标格（origin 已计入：top-left 的 y 自北向南） */
export function crsTileProjectedRect(
  spec: Proj4GridSpec,
  x: number,
  y: number,
  level: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const { cols, rows, cellW, cellH } = gridAtLevel(spec, level);
  const col = Math.min(cols - 1, Math.max(0, x));
  const row = Math.min(rows - 1, Math.max(0, y));
  const west = spec.projBounds.minX + col * cellW;
  const east = west + cellW;
  if (spec.origin === 'top-left') {
    const north = spec.projBounds.maxY - row * cellH;
    return { minX: west, minY: north - cellH, maxX: east, maxY: north };
  }
  const south = spec.projBounds.minY + row * cellH;
  return { minX: west, minY: south, maxX: east, maxY: south + cellH };
}

/** 反算投影矩形为 lon/lat 外包矩形（8 点采样）；任何点非有限 → undefined */
export function projectedRectToLonLatBounds(
  proj4Def: string,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
): { minLon: number; minLat: number; maxLon: number; maxLat: number } | undefined {
  const midX = (rect.minX + rect.maxX) / 2;
  const midY = (rect.minY + rect.maxY) / 2;
  const samples: Array<[number, number]> = [
    [rect.minX, rect.minY],
    [rect.minX, rect.maxY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [midX, rect.minY],
    [midX, rect.maxY],
    [rect.minX, midY],
    [rect.maxX, midY],
  ];
  let converter: Proj4Converter;
  try {
    converter = crsToLonLatConverter(proj4Def);
  } catch {
    return undefined;
  }
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [px, py] of samples) {
    let out: [number, number] | undefined;
    try {
      const r = converter.forward([px, py]);
      if (Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1])) out = [r[0], r[1]];
    } catch {
      out = undefined;
    }
    if (!out) return undefined;
    minLon = Math.min(minLon, out[0]);
    maxLon = Math.max(maxLon, out[0]);
    minLat = Math.min(minLat, out[1]);
    maxLat = Math.max(maxLat, out[1]);
  }
  return { minLon, minLat, maxLon, maxLat };
}

/**
 * 瓦片键集合 → 该 CRS 网格下的 lon/lat 范围（bounds.ts 的 crs 分支实现）。
 * 取最大层级的 min/max x,y（与 boundsFromTileKeys 口径一致）；tms 时先把 TMS 行号
 * 翻转为 XYZ 行号（y_xyz = rows - 1 - y_tms）。
 */
export function crsBoundsFromTileKeys(
  keys: Iterable<string>,
  crs: XyzLayerCrs,
  tms: boolean,
): [number, number, number, number] | undefined {
  let level = -1;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const key of keys) {
    const parts = String(key ?? '').split('/');
    if (parts.length !== 3) continue;
    const z = Number(parts[0]);
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0)) continue;
    if (z !== level) {
      if (z < level) continue;
      level = z;
      minX = maxX = x;
      minY = maxY = y;
      continue;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (level < 0 || !Number.isFinite(minX)) return undefined;

  const spec = proj4GridSpecOf(crs);
  const { cols, rows } = gridAtLevel(spec, level);
  // tms：TMS 行号（自南向北）→ XYZ 行号（自北向北翻转：y_xyz = rows-1-y_tms）
  let xyzMinY = minY;
  let xyzMaxY = maxY;
  if (tms) {
    xyzMinY = rows - 1 - maxY;
    xyzMaxY = rows - 1 - minY;
  }
  // 行列钳制（防越界键）
  const col0 = Math.min(cols - 1, Math.max(0, minX));
  const col1 = Math.min(cols - 1, Math.max(0, maxX));
  const row0 = Math.min(rows - 1, Math.max(0, xyzMinY));
  const row1 = Math.min(rows - 1, Math.max(0, xyzMaxY));
  // 西/东取列边缘；北/南取行边缘（top-left：北 = row0 的上边缘，南 = row1+1 的上边缘）
  const west = spec.projBounds.minX + (col0 * (spec.projBounds.maxX - spec.projBounds.minX)) / cols;
  const east = spec.projBounds.minX + ((col1 + 1) * (spec.projBounds.maxX - spec.projBounds.minX)) / cols;
  const topOrigin = spec.origin === 'top-left';
  const northProj = topOrigin
    ? spec.projBounds.maxY - (row0 * (spec.projBounds.maxY - spec.projBounds.minY)) / rows
    : spec.projBounds.minY + ((row1 + 1) * (spec.projBounds.maxY - spec.projBounds.minY)) / rows;
  const southProj = topOrigin
    ? spec.projBounds.maxY - ((row1 + 1) * (spec.projBounds.maxY - spec.projBounds.minY)) / rows
    : spec.projBounds.minY + (row0 * (spec.projBounds.maxY - spec.projBounds.minY)) / rows;
  const bounds = projectedRectToLonLatBounds(spec.proj4, {
    minX: west,
    minY: Math.min(southProj, northProj),
    maxX: east,
    maxY: Math.max(southProj, northProj),
  });
  if (!bounds) return undefined;
  // 瓦片键集合的足迹恒 ⊆ validBounds；反算外包在强非线性投影的高纬收敛处可能
  // 越出有效范围（如 3° 带全带瓦片）——钳制回 validBounds，zoomTo 定位语义不被污染。
  const [vbMinLon, vbMinLat, vbMaxLon, vbMaxLat] = spec.validBounds;
  const minLon = Math.min(vbMaxLon, Math.max(vbMinLon, bounds.minLon));
  const maxLon = Math.min(vbMaxLon, Math.max(vbMinLon, bounds.maxLon));
  const minLat = Math.min(vbMaxLat, Math.max(vbMinLat, bounds.minLat));
  const maxLat = Math.min(vbMaxLat, Math.max(vbMinLat, bounds.maxLat));
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * 某层级上 lon/lat 子范围（与 validBounds 求交后）覆盖的瓦片数（scale.ts 的 crs 分支）。
 * 非线性投影用投影包围盒近似（**只多不少**，作为护栏是保守方向）；范围与网格无交 → 0。
 */
export function crsTilesInRange(
  bounds: readonly [number, number, number, number],
  zoom: number,
  crs: XyzLayerCrs,
): number {
  if (!Number.isInteger(zoom) || zoom < 0) return 0;
  const spec = proj4GridSpecOf(crs);
  // lon/lat 求交（validBounds 之外裁掉）
  const [vbMinLon, vbMinLat, vbMaxLon, vbMaxLat] = spec.validBounds;
  const minLon = Math.max(vbMinLon, Math.min(bounds[0], bounds[2]));
  const maxLon = Math.min(vbMaxLon, Math.max(bounds[0], bounds[2]));
  const minLat = Math.max(vbMinLat, Math.min(bounds[1], bounds[3]));
  const maxLat = Math.min(vbMaxLat, Math.max(bounds[1], bounds[3]));
  if (minLon >= maxLon || minLat >= maxLat) return 0;
  const sub = projectedBoundsOfCrs(spec.proj4, [minLon, minLat, maxLon, maxLat]);
  if (!sub) return 0;
  // 投影包围盒钳制进网格包围盒，再换算行列区间
  const minX = Math.max(spec.projBounds.minX, sub.minX);
  const maxX = Math.min(spec.projBounds.maxX, sub.maxX);
  const minY = Math.max(spec.projBounds.minY, sub.minY);
  const maxY = Math.min(spec.projBounds.maxY, sub.maxY);
  if (minX >= maxX || minY >= maxY) return 0;
  const { cols, rows, cellW, cellH } = gridAtLevel(spec, zoom);
  const west = Math.min(cols - 1, Math.max(0, Math.floor((minX - spec.projBounds.minX) / cellW)));
  const east = Math.min(cols - 1, Math.max(0, Math.floor((maxX - spec.projBounds.minX) / cellW)));
  const rowTop = Math.min(rows - 1, Math.max(0, Math.floor((spec.projBounds.maxY - maxY) / cellH)));
  const rowBottom = Math.min(rows - 1, Math.max(0, Math.floor((spec.projBounds.maxY - minY) / cellH)));
  const xCount = east - west + 1;
  const yCount = Math.max(0, rowBottom - rowTop + 1);
  return xCount * yCount;
}

// ---------------------------------------------------------------------------
// Cesium TilingScheme 实现
// ---------------------------------------------------------------------------

/** MapProjection 结构对象（Cesium 消费 project/unproject/ellipsoid） */
class Proj4MapProjection {
  readonly ellipsoid = Ellipsoid.WGS84;
  private readonly forwardConverter: Proj4Converter;
  private readonly inverseConverter: Proj4Converter;

  constructor(private readonly proj4Def: string) {
    this.forwardConverter = lonLatToCrsConverter(proj4Def);
    this.inverseConverter = crsToLonLatConverter(proj4Def);
  }

  /** Cartographic(弧度) → 投影坐标 Cartesian3（米；z 原样透传） */
  project(cartographic: Cartographic, result?: Cartesian3): Cartesian3 {
    const lon = (cartographic.longitude * 180) / Math.PI;
    const lat = (cartographic.latitude * 180) / Math.PI;
    const p = this.forwardConverter.forward([lon, lat]) as [number, number];
    const out = result ?? new Cartesian3();
    out.x = Number.isFinite(p[0]) ? p[0] : 0;
    out.y = Number.isFinite(p[1]) ? p[1] : 0;
    out.z = cartographic.height ?? 0;
    return out;
  }

  /** 投影坐标 Cartesian3 → Cartographic(弧度) */
  unproject(cartesian: Cartesian3, result?: Cartographic): Cartographic {
    const p = this.inverseConverter.forward([cartesian.x, cartesian.y]) as [number, number];
    const lonRad = (Number.isFinite(p[0]) ? p[0] : 0) * (Math.PI / 180);
    const latRad = (Number.isFinite(p[1]) ? p[1] : 0) * (Math.PI / 180);
    const out = result ?? ({ height: 0 } as Cartographic);
    out.longitude = lonRad;
    out.latitude = latRad;
    out.height = cartesian.z ?? 0;
    return out;
  }
}

/**
 * proj4 任意投影 TilingScheme（结构兼容 Cesium.TilingScheme）。
 * @throws proj4 定义不可用 / validBounds 非法 —— 均为可读中文错误。
 */
export class Proj4TilingScheme {
  readonly ellipsoid = Ellipsoid.WGS84;
  /** 方案覆盖的地理矩形（= validBounds） */
  readonly rectangle: Rectangle;
  /** MapProjection 结构对象（proj4 正反算） */
  readonly projection: Proj4MapProjection;
  /** 网格规格（纯数学部分，供诊断/测试） */
  readonly spec: Proj4GridSpec;

  constructor(crs: XyzLayerCrs) {
    const defError = validateProj4Def(crs.proj4);
    if (defError) throw new Error(defError);
    this.spec = proj4GridSpecOf(crs);
    this.projection = new Proj4MapProjection(this.spec.proj4);
    const [minLon, minLat, maxLon, maxLat] = this.spec.validBounds;
    this.rectangle = Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat);
  }

  getNumberOfXTilesAtLevel(level: number): number {
    return this.spec.rootX * 2 ** level;
  }

  getNumberOfYTilesAtLevel(level: number): number {
    return this.spec.rootY * 2 ** level;
  }

  /** 地理矩形 → native（投影坐标，米）外包矩形 */
  rectangleToNativeRectangle(rectangle: Rectangle, result?: Rectangle): Rectangle {
    const lonLat = {
      minLon: (rectangle.west * 180) / Math.PI,
      minLat: (rectangle.south * 180) / Math.PI,
      maxLon: (rectangle.east * 180) / Math.PI,
      maxLat: (rectangle.north * 180) / Math.PI,
    };
    const projected = projectedBoundsOfCrs(this.spec.proj4, [
      lonLat.minLon,
      lonLat.minLat,
      lonLat.maxLon,
      lonLat.maxLat,
    ]);
    const out = result ?? new Rectangle();
    if (!projected) {
      out.west = rectangle.west;
      out.south = rectangle.south;
      out.east = rectangle.east;
      out.north = rectangle.north;
      return out;
    }
    out.west = projected.minX;
    out.south = projected.minY;
    out.east = projected.maxX;
    out.north = projected.maxY;
    return out;
  }

  /** 瓦片矩形（native = 投影坐标，米） */
  tileXYToNativeRectangle(x: number, y: number, level: number, result?: Rectangle): Rectangle {
    const cell = crsTileProjectedRect(this.spec, x, y, level);
    const out = result ?? new Rectangle();
    out.west = cell.minX;
    out.south = cell.minY;
    out.east = cell.maxX;
    out.north = cell.maxY;
    return out;
  }

  /** 瓦片矩形（地理 lon/lat，弧度）——proj4 反算四角 + 四边中点的 lon/lat 外包 */
  tileXYToRectangle(x: number, y: number, level: number, result?: Rectangle): Rectangle {
    const cell = crsTileProjectedRect(this.spec, x, y, level);
    const bounds = projectedRectToLonLatBounds(this.spec.proj4, cell);
    const out = result ?? new Rectangle();
    if (!bounds) {
      out.west = out.south = out.east = out.north = 0;
      return out;
    }
    // 网格足迹恒 ⊆ validBounds；强非线性投影（tmerc 高纬收敛）的反算外包可能越出
    // validBounds（如 3° 带全带瓦片反算出带外经度）——钳制回有效范围， zoomTo/裁剪语义不被污染。
    const [vbMinLon, vbMinLat, vbMaxLon, vbMaxLat] = this.spec.validBounds;
    const minLon = Math.min(vbMaxLon, Math.max(vbMinLon, bounds.minLon));
    const maxLon = Math.min(vbMaxLon, Math.max(vbMinLon, bounds.maxLon));
    const minLat = Math.min(vbMaxLat, Math.max(vbMinLat, bounds.minLat));
    const maxLat = Math.min(vbMaxLat, Math.max(vbMinLat, bounds.maxLat));
    out.west = (minLon * Math.PI) / 180;
    out.south = (minLat * Math.PI) / 180;
    out.east = (maxLon * Math.PI) / 180;
    out.north = (maxLat * Math.PI) / 180;
    return out;
  }

  /** 地理位置弧度（lon/lat，WGS84）→ 瓦片行列号；方案矩形之外返回 undefined（Cesium 约定） */
  positionToTileXY(position: Cartographic, level: number, result?: Cartesian2): Cartesian2 | undefined {
    const lon = (position.longitude * 180) / Math.PI;
    const lat = (position.latitude * 180) / Math.PI;
    let p: [number, number] | undefined;
    try {
      const out = lonLatToCrsConverter(this.spec.proj4).forward([lon, lat]) as [number, number];
      if (Array.isArray(out) && Number.isFinite(out[0]) && Number.isFinite(out[1])) p = out;
    } catch {
      p = undefined;
    }
    if (!p) return undefined;
    const tile = crsPositionToTile(this.spec, level, p[0], p[1]);
    if (!tile) return undefined;
    const out = result ?? new Cartesian2();
    out.x = tile.x;
    out.y = tile.y;
    return out;
  }
}

// 让 TS 把本类视为结构兼容的 TilingScheme（Cesium 的 TilingScheme 是带私差异的 class 声明，
// 这里只做类型断言导出别名，运行时零开销）。
export type Proj4TilingSchemeLike = Proj4TilingScheme & TilingScheme;
