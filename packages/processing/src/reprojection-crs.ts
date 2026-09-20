/**
 * editor/core · reprojection/crs —— 常用坐标系定义与解析
 *
 * - 内置常用 EPSG：4326 / 3857 / 4490（CGCS2000）/ 4534~4549（CGCS2000 高斯克吕格 3 度带）/ UTM 各带（326/327 系列）
 * - 支持直接粘贴 proj4 定义字符串（以 '+' 开头或不含 'EPSG:' 前缀的未知输入一律按自定义定义处理）
 * - Cesium 使用 WGS84，配准默认目标为 EPSG:4326
 */

/** 坐标系定义 */
export interface CrsDefinition {
  /** EPSG 代码（如 'EPSG:4326'） */
  code: string;
  /** 显示名 */
  name: string;
  /** proj4 定义字符串 */
  def: string;
  /** 坐标单位 */
  unit: 'degree' | 'metre';
  /** 是否地理坐标系（经纬度） */
  geographic: boolean;
}

// CGCS2000 3 度带：EPSG:4534（CM 75°E）起每 +1 带号 CM +3°，至 4549（CM 120°E），
// 东偏 500000m；4544 = CM 105°E，4547 = CM 114°E。
function cgcs2000Tmerc(code: number, centralMeridian: number): CrsDefinition {
  return {
    code: `EPSG:${code}`,
    name: `CGCS2000 / 3-degree Gauss-Kruger CM ${centralMeridian}E`,
    def: `+proj=tmerc +lat_0=0 +lon_0=${centralMeridian} +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs`,
    unit: 'metre',
    geographic: false,
  };
}

function utmCrs(zone: number, south: boolean): CrsDefinition {
  return {
    code: `EPSG:${south ? 32700 + zone : 32600 + zone}`,
    name: `WGS 84 / UTM zone ${zone}${south ? 'S' : 'N'}`,
    def: `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`,
    unit: 'metre',
    geographic: false,
  };
}

/** 内置常用坐标系（显式列出核心项；3 度带与 UTM 见 generateCgcs2000GaussKruger3 / getUtmCrs） */
export const BUILTIN_CRS_LIST: readonly CrsDefinition[] = [
  {
    code: 'EPSG:4326',
    name: 'WGS 84（经纬度）',
    def: '+proj=longlat +datum=WGS84 +no_defs',
    unit: 'degree',
    geographic: true,
  },
  {
    code: 'EPSG:3857',
    name: 'WGS 84 / Pseudo-Mercator（Web 墨卡托）',
    def: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
    unit: 'metre',
    geographic: false,
  },
  {
    code: 'EPSG:4490',
    name: 'CGCS2000（经纬度）',
    def: '+proj=longlat +ellps=GRS80 +no_defs',
    unit: 'degree',
    geographic: true,
  },
  cgcs2000Tmerc(4544, 105),
  cgcs2000Tmerc(4547, 114),
];

/** 生成 CGCS2000 高斯克吕格 3 度带全系（EPSG:4534~4549，CM 75°E~120°E） */
export function generateCgcs2000GaussKruger3(): CrsDefinition[] {
  const list: CrsDefinition[] = [];
  for (let code = 4534; code <= 4549; code++) {
    list.push(cgcs2000Tmerc(code, 75 + (code - 4534) * 3));
  }
  return list;
}

/** 构造 UTM 带定义（zone 1~60；north → EPSG:326XX，south → EPSG:327XX） */
export function getUtmCrs(zone: number, south = false): CrsDefinition {
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) {
    throw new Error(`UTM 带号必须在 1~60：${zone}`);
  }
  return utmCrs(zone, south);
}

/** 解析结果：内置 code 或自定义 proj4 定义字符串的统一形态 */
export interface ResolvedCrs {
  /** 原始输入 */
  input: string;
  /** 命中内置/EPSG 代码时给出规范代码 */
  code?: string;
  /** proj4 定义字符串（可直接交给 proj4） */
  def: string;
  /** 显示名（内置时） */
  name?: string;
  /** 坐标单位（未知时为 undefined，如自定义定义） */
  unit?: 'degree' | 'metre';
  /** 是否地理坐标系（自定义定义时为 undefined） */
  geographic?: boolean;
  /** 是否自定义 proj4 定义（非内置代码） */
  custom: boolean;
}

/** 在内置表中查找（大小写不敏感；接受 'epsg:4326'、'4326'） */
export function findCrs(code: string): CrsDefinition | undefined {
  const normalized = code.trim().toUpperCase();
  const withPrefix = normalized.startsWith('EPSG:') ? normalized : `EPSG:${normalized}`;
  const explicit = BUILTIN_CRS_LIST.find((crs) => crs.code === withPrefix);
  if (explicit) return explicit;

  // CGCS2000 3 度带全系 / UTM 全带
  const cgcs = generateCgcs2000GaussKruger3().find((crs) => crs.code === withPrefix);
  if (cgcs) return cgcs;

  const utm = parseUtmCode(withPrefix);
  if (utm) return utmCrs(utm.zone, utm.south);
  return undefined;
}

/** 识别 EPSG:32601~32660（北）/ EPSG:32701~32760（南） */
function parseUtmCode(code: string): { zone: number; south: boolean } | undefined {
  const match = /^EPSG:(326|327)(\d{2})$/.exec(code);
  if (!match) return undefined;
  const zone = Number(match[2]);
  if (zone < 1 || zone > 60) return undefined;
  return { zone, south: match[1] === '327' };
}

/**
 * 把用户输入解析为 proj4 定义：
 * - 内置 EPSG 代码（'EPSG:4326' / '4326' / 'EPSG:32650' 等）→ 内置定义
 * - 其他输入一律视为**自定义 proj4 定义字符串**原样返回（如 '+proj=tmerc +lon_0=117 ...'）
 */
export function resolveCrs(input: string): ResolvedCrs {
  const crs = findCrs(input);
  if (crs) {
    return {
      input,
      code: crs.code,
      def: crs.def,
      name: crs.name,
      unit: crs.unit,
      geographic: crs.geographic,
      custom: false,
    };
  }
  if (!input.trim()) {
    throw new Error('坐标系定义为空：请选择内置 EPSG 或粘贴 proj4 定义字符串');
  }
  return { input, def: input.trim(), custom: true };
}
