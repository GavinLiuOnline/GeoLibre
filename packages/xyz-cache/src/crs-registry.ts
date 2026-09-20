/**
 * editor/core · localCache/crsRegistry —— XYZ 缓存图层的 CRS 注册表（t37）
 *
 * 用户要求：「缓存的 xyz 不只是能使用 3857 和 4326，配准的所有都可以，包括 proj4」。
 * 本模块是 XYZ 缓存坐标系体系的**唯一数据源**：
 * - 预置注册表 `XYZ_CRS_REGISTRY`：内置 3857/4326/4490（作为 t30 内置切片方案的简写别名）
 *   + CGCS2000 6度/3度带全系（EPSG:4491–4549，代码区间经 epsg.io EPSG v12 核对）
 *   + Beijing 1954 / Xian 1980 常用带 + UTM（中国常用 50N/51N，全系可由 proj4 内置 defs 解析）；
 * - 每条 { id, label, proj4, validBounds, origin, tileMatrix }；投影带类条目 validBounds
 *   为「带状全域」默认值，用户可在属性面板按缓存实际范围改写（网格按 validBounds 均分）；
 * - 自定义：用户粘贴 proj4 定义 + 有效范围四值，或直填 EPSG:CODE
 *   （先查注册表，再查 proj4.defs 已注册定义——proj4js 不内置 CGCS2000 等编码，
 *   注册表存在的意义就是把常用 EPSG 映射到 proj4 定义）；
 * - `resolveCrsInput` / `normalizeXyzLayerCrs`：UI 输入与 metadata 反序列化的统一校验入口
 *   （**proj4 定义只在 forward/inverse 调用时才抛错**——构造 Converter 不报错，
 *   因此校验必须做一次采样点正反算探针）。
 *
 * EPSG 代码 → 中央经线对照（已核对，生成规则写进各 series 工厂）：
 * - CGCS2000 6° 带号系 EPSG:4491–4501（zone 13–23，FE = zone×1e6+500000）
 * - CGCS2000 6° CM 系 EPSG:4502–4512（CM 75E–135E，FE 500000）
 * - CGCS2000 3° 带号系 EPSG:4513–4533（zone 25–45，FE = zone×1e6+500000）
 * - CGCS2000 3° CM 系 EPSG:4534–4549（CM 75E–120E，FE 500000）
 * - Beijing 1954 6° 带号系 EPSG:21413–21423；6° CM 系 EPSG:21453–21463（Krassowsky 1940）
 * - Xian 1980 6° CM 系 EPSG:2338–2348；3° 带号系 EPSG:2349–2369（IAG 1975）
 *
 * 网格约定：投影带类条目 tileMatrix='square-2^z'（2^z 方格均分 validBounds）；
 * 经纬度类条目（4326/4490/4214/4610）tileMatrix='geodetic-2x1'（2×1 根瓦片，
 * 与 Cesium GeographicTilingScheme 及 GeoServer EPSG4326 GridSet 对齐）。
 *
 * 注意：本模块不 import Cesium（纯数据 + proj4），可被 UI/store 与引擎两侧安全复用。
 */
import proj4 from 'proj4';

import type { XyzCrsTileMatrix, XyzLayerCrs } from './types';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** CRS 注册表条目 */
export interface CrsRegistryEntry {
  /** 稳定 id（写入 metadata.crs.id；如 'EPSG:4544'） */
  id: string;
  /** 显示名（采用 EPSG 官方命名） */
  label: string;
  /** proj4 定义字符串 */
  proj4: string;
  /** 有效范围 [minLon, minLat, maxLon, maxLat]（度；网格均分范围，UI 可改写） */
  validBounds: [number, number, number, number];
  /** 瓦片原点（XYZ 标准左上） */
  origin: 'top-left' | 'bottom-left';
  /** 瓦片网格形态 */
  tileMatrix: XyzCrsTileMatrix;
  /** 分类（UI 分组展示） */
  category: 'builtin' | 'cgcs2000' | 'beijing54' | 'xian80' | 'utm';
  /** 是否地理坐标系（经纬度直格） */
  geographic: boolean;
  /**
   * 内置切片方案别名（仅 3857/4326/4490）：选择时直接写 metadata.tilingMode
   * （走 t30 既有 WebMercator/GeographicTilingScheme 快路径，**不写 metadata.crs**），
   * 保证既有行为逐字节回归。
   */
  nativeTilingMode?: 'web-mercator' | 'geographic';
}

/** proj4 输入解析结果（成功形态） */
export interface ResolvedXyzCrs extends XyzLayerCrs {}

/** resolveCrsInput / normalizeXyzLayerCrs 的统一返回 */
export type CrsResolveResult =
  | { ok: true; crs: ResolvedXyzCrs }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// proj4 定义工具（缓存 Converter；校验必须做正反算探针）
// ---------------------------------------------------------------------------

/** Converter 缓存（同一定义串全局复用，避免每瓦片重建） */
const converterCache = new Map<string, proj4.Converter>();

/**
 * lon/lat(度) → 该 CRS 投影坐标 的 Converter（缓存）。
 * @throws proj4 对无法解析的定义在调用 forward/inverse 时才抛错——调用方需 try/catch。
 */
export function lonLatToCrsConverter(def: string): proj4.Converter {
  const key = `fwd:${def}`;
  let converter = converterCache.get(key);
  if (!converter) {
    converter = proj4('EPSG:4326', def);
    converterCache.set(key, converter);
  }
  return converter;
}

/** 投影坐标 → lon/lat(度) 的 Converter（缓存） */
export function crsToLonLatConverter(def: string): proj4.Converter {
  const key = `inv:${def}`;
  let converter = converterCache.get(key);
  if (!converter) {
    converter = proj4(def, 'EPSG:4326');
    converterCache.set(key, converter);
  }
  return converter;
}

/**
 * 校验 proj4 定义可用性：用采样点做一次正算 + 反算探针。
 * proj4 对「语法上能构造但实际不可用」的定义（如乱码字符串）**构造不报错、调用才抛错**，
 * 因此这里必须真正调用 forward/inverse 并检查有限性。
 *
 * 采样点：给定 `validBounds` 时取其 4 角 + 中心（**在 CRS 自身有效域内采样**——
 * tmerc/UTM 等投影带在中央经线 ±90° 处奇异，固定全球采样点对远离本初子午线的
 * 投影带（如 CGCS2000 CM 81E、UTM 50N）必然发散，不能作为「定义不可用」的依据）；
 * 未给定时回落全球常识采样点（通用入口 / UI 即时校验）。
 * @returns 可用返回 undefined；不可用返回可读错误文案。
 */
export function validateProj4Def(
  def: string,
  validBounds?: readonly [number, number, number, number],
): string | undefined {
  const trimmed = def.trim();
  if (!trimmed) return 'proj4 定义为空：请选择注册表条目、直填 EPSG:CODE 或粘贴 proj4 定义字符串';
  let converter: proj4.Converter;
  try {
    converter = lonLatToCrsConverter(trimmed);
  } catch (err) {
    return `proj4 定义无法解析：${err instanceof Error ? err.message : String(err)}`;
  }
  // 采样点：有效范围 4 角 + 中心；无效范围或缺省 → 全球常识采样点
  let samples: Array<[number, number]> = [
    [0, 0],
    [105, 35],
    [-60, -20],
  ];
  if (validBounds) {
    const normalized = normalizeCrsValidBounds(validBounds, {
      geographic: isGeographicProj4Def(trimmed),
    });
    if (normalized) {
      const [minLon, minLat, maxLon, maxLat] = normalized;
      samples = [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
      ];
    }
  }
  try {
    for (const [lon, lat] of samples) {
      const p = converter.forward([lon, lat]);
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        return `proj4 定义正向计算结果非有限值（采样点 ${lon},${lat}），定义不可用：${trimmed}`;
      }
      const back = converter.inverse(p);
      if (
        !Array.isArray(back) ||
        !Number.isFinite(back[0]) ||
        !Number.isFinite(back[1]) ||
        Math.abs(back[0] - lon) > 1e-6 ||
        Math.abs(back[1] - lat) > 1e-6
      ) {
        return `proj4 定义正反算不一致（反算偏离超过 1e-6°），定义不可用：${trimmed}`;
      }
    }
  } catch (err) {
    return `proj4 定义不可用（计算抛错：${err instanceof Error ? err.message : String(err)}）：${trimmed}`;
  }
  return undefined;
}

/** 定义是否为经纬度（longlat/latlong）——决定 validBounds 纬度是否允许到 ±90 */
export function isGeographicProj4Def(def: string): boolean {
  return /(^|\s)\+proj=(longlat|latlong)(\s|$)/.test(def.trim());
}

// ---------------------------------------------------------------------------
// 预置条目工厂
// ---------------------------------------------------------------------------

/** Web Mercator 有效纬度（±85.0511287798066°，与 generate2d.MERCATOR_MAX_LAT 一致；此处不引入该模块避免环） */
const WEB_MERCATOR_MAX_LAT = 85.0511287798066;

/** 经纬度类缓存的全球范围（度） */
const WORLD_DEGREES: [number, number, number, number] = [-180, -90, 180, 90];

/**
 * 中国投影带类条目的默认纬度范围（度）。
 * 取 [0, 84]：Gauss-Kruger 在极点奇异（proj4 在 |lat|=90 处 forward 会得到 Infinity），
 * 84°N 也是 UTM 北带的实用上限；用户可按缓存实际范围在属性面板改写。
 */
const BELT_DEFAULT_BOUNDS_LAT: [number, number] = [0, 84];

/** 通用：Gauss-Kruger 投影带条目 */
function gaussKrugerBelt(input: {
  id: string;
  label: string;
  category: CrsRegistryEntry['category'];
  /** 椭球片段（如 '+ellps=GRS80' / '+ellps=krass' / '+a=6378140 +rf=298.257'） */
  ellipsoid: string;
  centralMeridian: number;
  /** 东偏（500000 或 zone×1e6+500000） */
  falseEasting: number;
  /** 带宽（6 或 3 度）→ 默认 validBounds 经度半宽 */
  beltWidth: number;
}): CrsRegistryEntry {
  const half = input.beltWidth / 2;
  const minLon = Math.max(-180, input.centralMeridian - half);
  const maxLon = Math.min(180, input.centralMeridian + half);
  return {
    id: input.id,
    label: input.label,
    proj4:
      `+proj=tmerc +lat_0=0 +lon_0=${input.centralMeridian} +k=1 ` +
      `+x_0=${input.falseEasting} +y_0=0 ${input.ellipsoid} +units=m +no_defs`,
    validBounds: [minLon, BELT_DEFAULT_BOUNDS_LAT[0], maxLon, BELT_DEFAULT_BOUNDS_LAT[1]],
    origin: 'top-left',
    tileMatrix: 'square-2^z',
    category: input.category,
    geographic: false,
  };
}

/** CGCS2000 投影带（GRS80 椭球） */
function cgcs2000Belt(id: string, centralMeridian: number, falseEasting: number, beltWidth: 3 | 6): CrsRegistryEntry {
  return gaussKrugerBelt({
    id,
    label: `CGCS2000 / ${beltWidth}-degree Gauss-Kruger${falseEasting > 1_000_000 ? ` zone ${Math.round((falseEasting - 500_000) / 1_000_000)}` : ` CM ${centralMeridian}E`}`,
    category: 'cgcs2000',
    ellipsoid: '+ellps=GRS80',
    centralMeridian,
    falseEasting,
    beltWidth,
  });
}

/** Beijing 1954 投影带（Krassowsky 1940 椭球） */
function beijing54Belt(id: string, centralMeridian: number, falseEasting: number): CrsRegistryEntry {
  return gaussKrugerBelt({
    id,
    label: `Beijing 1954 / Gauss-Kruger${falseEasting > 1_000_000 ? ` zone ${Math.round((falseEasting - 500_000) / 1_000_000)}` : ` CM ${centralMeridian}E`}`,
    category: 'beijing54',
    ellipsoid: '+ellps=krass',
    centralMeridian,
    falseEasting,
    beltWidth: 6,
  });
}

/** Xian 1980 投影带（IAG 1975 椭球：a=6378140, rf=298.257） */
function xian80Belt(id: string, centralMeridian: number, falseEasting: number, beltWidth: 3 | 6): CrsRegistryEntry {
  return gaussKrugerBelt({
    id,
    label: `Xian 1980 / ${beltWidth}-degree Gauss-Kruger${falseEasting > 1_000_000 ? ` zone ${Math.round((falseEasting - 500_000) / 1_000_000)}` : ` CM ${centralMeridian}E`}`,
    category: 'xian80',
    ellipsoid: '+a=6378140 +rf=298.257',
    centralMeridian,
    falseEasting,
    beltWidth,
  });
}

/** 内置简写别名（3857/4326/4490）：走 t30 既有 tilingMode 快路径 */
function builtinAlias(id: string, label: string, def: string, mode: 'web-mercator' | 'geographic', bounds: [number, number, number, number], geographic: boolean): CrsRegistryEntry {
  return {
    id,
    label,
    proj4: def,
    validBounds: bounds,
    origin: 'top-left',
    tileMatrix: geographic ? 'geodetic-2x1' : 'square-2^z',
    category: 'builtin',
    geographic,
    nativeTilingMode: mode,
  };
}

// ---------------------------------------------------------------------------
// 预置注册表
// ---------------------------------------------------------------------------

/** CGCS2000 6° 带号系（EPSG:4491–4501，zone 13–23，CM 75E+6°·i） */
function cgcs2000Zone6Series(): CrsRegistryEntry[] {
  const list: CrsRegistryEntry[] = [];
  for (let i = 0; i <= 10; i++) {
    const zone = 13 + i;
    list.push(cgcs2000Belt(`EPSG:${4491 + i}`, 75 + i * 6, zone * 1_000_000 + 500_000, 6));
  }
  return list;
}

/** CGCS2000 6° CM 系（EPSG:4502–4512，CM 75E–135E，FE 500000） */
function cgcs2000Cm6Series(): CrsRegistryEntry[] {
  const list: CrsRegistryEntry[] = [];
  for (let i = 0; i <= 10; i++) {
    list.push(cgcs2000Belt(`EPSG:${4502 + i}`, 75 + i * 6, 500_000, 6));
  }
  return list;
}

/** CGCS2000 3° 带号系（EPSG:4513–4533，zone 25–45，CM 75E+3°·i） */
function cgcs2000Zone3Series(): CrsRegistryEntry[] {
  const list: CrsRegistryEntry[] = [];
  for (let i = 0; i <= 20; i++) {
    const zone = 25 + i;
    list.push(cgcs2000Belt(`EPSG:${4513 + i}`, 75 + i * 3, zone * 1_000_000 + 500_000, 3));
  }
  return list;
}

/** CGCS2000 3° CM 系（EPSG:4534–4549，CM 75E–120E，FE 500000） */
function cgcs2000Cm3Series(): CrsRegistryEntry[] {
  const list: CrsRegistryEntry[] = [];
  for (let i = 0; i <= 15; i++) {
    list.push(cgcs2000Belt(`EPSG:${4534 + i}`, 75 + i * 3, 500_000, 3));
  }
  return list;
}

/** Beijing 1954 6° 带号系（EPSG:21413–21423）与 6° CM 系（EPSG:21453–21463） */
function beijing54Series(): CrsRegistryEntry[] {
  const list: CrsRegistryEntry[] = [];
  for (let i = 0; i <= 10; i++) {
    const zone = 13 + i;
    list.push(beijing54Belt(`EPSG:${21413 + i}`, 75 + i * 6, zone * 1_000_000 + 500_000));
  }
  for (let i = 0; i <= 10; i++) {
    list.push(beijing54Belt(`EPSG:${21453 + i}`, 75 + i * 6, 500_000));
  }
  return list;
}

/** Xian 1980 6° CM 系（EPSG:2338–2348）与 3° 带号系（EPSG:2349–2369） */
function xian80Series(): CrsRegistryEntry[] {
  const list: CrsRegistryEntry[] = [];
  for (let i = 0; i <= 10; i++) {
    list.push(xian80Belt(`EPSG:${2338 + i}`, 75 + i * 6, 500_000, 6));
  }
  for (let i = 0; i <= 20; i++) {
    const zone = 25 + i;
    list.push(xian80Belt(`EPSG:${2349 + i}`, 75 + i * 3, zone * 1_000_000 + 500_000, 3));
  }
  return list;
}

/** UTM 预置（WGS84；proj4 内置 EPSG:326xx/327xx defs，按需可扩展到全系） */
function utmPresets(): CrsRegistryEntry[] {
  const make = (zone: number, south: boolean): CrsRegistryEntry => {
    const code = (south ? 32700 : 32600) + zone;
    const lon0 = -183 + zone * 6;
    return {
      id: `EPSG:${code}`,
      label: `WGS 84 / UTM zone ${zone}${south ? 'S' : 'N'}`,
      proj4: `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`,
      validBounds: south
        ? [lon0 - 3, -84, lon0 + 3, 0]
        : [lon0 - 3, 0, lon0 + 3, 84],
      origin: 'top-left',
      tileMatrix: 'square-2^z',
      category: 'utm',
      geographic: false,
    };
  };
  // 中国常用 50N（114°E–120°E）/ 51N（120°E–126°E）；需要其它带时用「自定义…」直填 EPSG:326XX
  return [make(50, false), make(51, false)];
}

/**
 * 预置 CRS 注册表（t37）。
 * 内置 3857/4326/4490 为 t30 既有切片方案的简写别名（选择时写 tilingMode，不写 metadata.crs）；
 * 其余条目走 proj4 自定义切片方案。条目可按需继续扩充（追加进本数组即可）。
 */
export const XYZ_CRS_REGISTRY: readonly CrsRegistryEntry[] = [
  builtinAlias(
    'EPSG:3857',
    'Web Mercator（EPSG:3857，标准 XYZ 网格）',
    '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
    'web-mercator',
    [-180, -WEB_MERCATOR_MAX_LAT, 180, WEB_MERCATOR_MAX_LAT],
    false,
  ),
  builtinAlias(
    'EPSG:4326',
    'Geographic（EPSG:4326 经纬度直方格）',
    '+proj=longlat +datum=WGS84 +no_defs',
    'geographic',
    WORLD_DEGREES,
    true,
  ),
  builtinAlias(
    'EPSG:4490',
    'CGCS2000（EPSG:4490 经纬度，网格同 4326）',
    '+proj=longlat +ellps=GRS80 +no_defs',
    'geographic',
    WORLD_DEGREES,
    true,
  ),
  ...cgcs2000Zone6Series(),
  ...cgcs2000Cm6Series(),
  ...cgcs2000Zone3Series(),
  ...cgcs2000Cm3Series(),
  builtinAlias(
    'EPSG:4214',
    'Beijing 1954（EPSG:4214 经纬度，网格同 4326）',
    '+proj=longlat +ellps=krass +no_defs',
    'geographic',
    WORLD_DEGREES,
    true,
  ),
  ...beijing54Series(),
  builtinAlias(
    'EPSG:4610',
    'Xian 1980（EPSG:4610 经纬度，网格同 4326）',
    '+proj=longlat +a=6378140 +rf=298.257 +no_defs',
    'geographic',
    WORLD_DEGREES,
    true,
  ),
  ...xian80Series(),
  ...utmPresets(),
];

/** 按 id 查注册表（大小写不敏感；接受 'epsg:4544' / '4544'） */
export function findCrsEntry(id: string): CrsRegistryEntry | undefined {
  const normalized = String(id ?? '').trim().toUpperCase();
  if (!normalized) return undefined;
  const withPrefix = normalized.startsWith('EPSG:') ? normalized : `EPSG:${normalized}`;
  return XYZ_CRS_REGISTRY.find((entry) => entry.id.toUpperCase() === withPrefix);
}

// ---------------------------------------------------------------------------
// validBounds 校验 / 归一化
// ---------------------------------------------------------------------------

/** 校验并归一化 validBounds 四值（投影类 CRS 不允许 |lat| ≥ 90——tmerc 在极点发散） */
export function normalizeCrsValidBounds(
  value: unknown,
  options: { geographic: boolean },
): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const nums = value.map((v) => Number(v));
  if (!nums.every((n) => Number.isFinite(n))) return undefined;
  const [minLon, minLat, maxLon, maxLat] = nums;
  if (minLon < -180 || maxLon > 180 || minLon >= maxLon) return undefined;
  if (minLat >= maxLat) return undefined;
  if (options.geographic) {
    if (minLat < -90 || maxLat > 90) return undefined;
  } else if (minLat <= -90 || maxLat >= 90) {
    return undefined;
  }
  return [minLon, minLat, maxLon, maxLat];
}

// ---------------------------------------------------------------------------
// 输入解析 / metadata 校验
// ---------------------------------------------------------------------------

export interface CrsInputOptions {
  /** proj4 定义字符串，或 'EPSG:CODE'（先查注册表再查 proj4.defs） */
  proj4?: string;
  /** EPSG 直填（如 'EPSG:4502' / '4502'）；proj4 参数未给时使用 */
  epsgCode?: string;
  /** 有效范围四值（度）；缺省用注册表条目范围；经纬度自定义定义缺省全球；投影类自定义定义必填 */
  validBounds?: unknown;
  origin?: 'top-left' | 'bottom-left';
  tileMatrix?: XyzCrsTileMatrix;
}

/**
 * 解析用户输入为自包含的 XyzLayerCrs（UI「自定义…」/ EPSG 直填的统一入口）。
 * - 'EPSG:CODE'：注册表命中 → 用注册表定义 + 注册表 validBounds（用户给定的 validBounds 优先）；
 *   未命中 → 查 proj4.defs（应用侧可用 proj4.defs('EPSG:xxxx', '+proj=...') 注册后直填）；
 *   都未命中 → 可读错误。
 * - proj4 字符串：原样采用（正反算探针校验）。
 * - validBounds：经纬度定义缺省全球；投影类定义必填（或经注册表条目带入）。
 */
export function resolveCrsInput(input: CrsInputOptions): CrsResolveResult {
  const rawProj4 = input.proj4?.trim() ?? '';
  const rawEpsg = input.epsgCode?.trim() ?? '';
  const looksLikeCode = /^(EPSG:\s*)?\d{4,8}$/i.test(rawProj4) || (!rawProj4 && !!rawEpsg);
  const codeInput = looksLikeCode ? (rawProj4 || rawEpsg) : rawEpsg;

  let def = '';
  let id: string | undefined;
  let label: string | undefined;
  let geographic = false;
  let defaultBounds: [number, number, number, number] | undefined;

  if (codeInput && (looksLikeCode || !rawProj4)) {
    const entry = findCrsEntry(codeInput);
    if (entry) {
      def = entry.proj4;
      id = entry.id;
      label = entry.label;
      geographic = entry.geographic;
      defaultBounds = [...entry.validBounds] as [number, number, number, number];
    } else {
      const normalized = codeInput.toUpperCase().startsWith('EPSG:')
        ? codeInput.toUpperCase().replace(/\s+/g, '')
        : `EPSG:${codeInput.replace(/\s+/g, '')}`;
      const registered = proj4.defs(normalized);
      if (registered) {
        def = normalized;
        // proj4.defs 命中的定义可能是字符串（未解析）或已解析对象（含 projName）；
        // 经纬度判定两者都兼容，决定 validBounds 是否允许 ±90。
        const desc =
          typeof registered === 'string'
            ? registered
            : String((registered as { projName?: string }).projName ?? '');
        geographic = /longlat|latlong/.test(desc);
      } else {
        return {
          ok: false,
          error:
            `无法识别 ${codeInput}：CRS 注册表中没有该 EPSG 代码，proj4 也未注册该定义。` +
            '请改从注册表选择，或粘贴 proj4 定义字符串（如 +proj=tmerc +lon_0=105 ...）。',
        };
      }
    }
  } else if (rawProj4) {
    def = rawProj4;
    geographic = isGeographicProj4Def(def);
  } else {
    return { ok: false, error: '坐标系定义为空：请选择注册表条目、直填 EPSG:CODE 或粘贴 proj4 定义字符串' };
  }

  // 有效范围先于探针决策：用户输入 > 注册表默认 > 经纬度缺省全球；
  // 投影类定义两皆无 → 必填错误（2^z 方格网格没有均分范围无法成立）。
  const userBounds = input.validBounds !== undefined
    ? normalizeCrsValidBounds(input.validBounds, { geographic })
    : undefined;
  if (input.validBounds !== undefined && !userBounds) {
    return {
      ok: false,
      error:
        '有效范围非法：应为 [minLon, minLat, maxLon, maxLat]（min < max，经度 -180~180，' +
        `纬度 ${geographic ? '-90~90（经纬度定义）' : '严格 -90~90 之间（投影定义不能到极点）'}）`,
    };
  }
  const bounds = userBounds ?? defaultBounds ?? (geographic ? WORLD_DEGREES : undefined);
  if (!bounds) {
    return {
      ok: false,
      error:
        '自定义投影坐标系必须填写有效范围（minLon, minLat, maxLon, maxLat，度）——' +
        '它是 2^z 方格网格的均分范围；请填缓存实际的经纬度覆盖范围',
    };
  }
  // 探针在最终 validBounds 内采样：投影带（tmerc/UTM）在中央经线 ±90° 处奇异，
  // 用全球固定采样点会把远离本初子午线的合法投影带误判为「定义不可用」。
  const defError = validateProj4Def(def, bounds);
  if (defError) return { ok: false, error: defError };

  return {
    ok: true,
    crs: {
      kind: 'proj4',
      proj4: def,
      validBounds: bounds,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.tileMatrix ? { tileMatrix: input.tileMatrix } : {}),
      ...(id ? { id } : {}),
      ...(label ? { label } : {}),
    },
  };
}

/**
 * 校验/归一化 metadata 里的 crs 对象（rebuildXyz 与场景打开时的统一入口）。
 * 合法返回补齐缺省值的 XyzLayerCrs；非法抛可读中文错误（含字段名，便于定位）。
 */
export function normalizeXyzLayerCrs(value: unknown): XyzLayerCrs {
  if (!value || typeof value !== 'object') {
    throw new Error('CRS 无效：应为一个 { kind: "proj4", proj4, validBounds } 对象');
  }
  const raw = value as Partial<XyzLayerCrs> & Record<string, unknown>;
  if (raw.kind !== undefined && raw.kind !== 'proj4') {
    throw new Error(`CRS 无效：暂只支持 kind: "proj4"（实际「${String(raw.kind)}」）`);
  }
  const resolved = resolveCrsInput({
    proj4: typeof raw.proj4 === 'string' ? raw.proj4 : undefined,
    validBounds: raw.validBounds,
    origin: raw.origin === 'bottom-left' ? 'bottom-left' : raw.origin === 'top-left' ? 'top-left' : undefined,
    tileMatrix: raw.tileMatrix === 'geodetic-2x1' ? 'geodetic-2x1' : raw.tileMatrix === 'square-2^z' ? 'square-2^z' : undefined,
  });
  if (!resolved.ok) throw new Error(resolved.error);
  const crs = resolved.crs;
  if (typeof raw.id === 'string' && raw.id) crs.id = raw.id;
  if (typeof raw.label === 'string' && raw.label) crs.label = raw.label;
  return crs;
}

/**
 * metadata.crs 是否可用（供 UI/引擎快速判定；不作严格校验）。
 * 注意：地理类 metadata 里可能有配准模块写入的 `{ crs: 'EPSG:4490' }`（字符串形态），
 * 那是 SceneLayer.projection 的来源，**不是**本模块的瓦片 CRS——只有对象形态才认。
 */
export function isXyzLayerCrs(value: unknown): value is XyzLayerCrs {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as XyzLayerCrs).kind === 'proj4'
    && typeof (value as XyzLayerCrs).proj4 === 'string'
    && Array.isArray((value as XyzLayerCrs).validBounds);
}
