/**
 * editor/core · importer/csv —— CSV 点位解析（纯函数）
 *
 * 把含经度/纬度列的 CSV 解析为 Point FeatureCollection：
 * - 经纬度列支持自动识别（lon/lng/longitude/x/经度；lat/latitude/y/纬度；height/altitude/z/高程）
 * - 也可用 options.lonField / latField / heightField 显式指定列名
 * - RFC4180 风格解析：支持引号字段、双引号转义、逗号/换行分隔
 * - 经纬度越界（|lon|>180、|lat|>90）或非数字的行跳过并记录行号
 */
import type { GeoJSONFeature, GeoJSONFeatureCollection, GeoJSONPosition } from '@geolibre/gis-shared';

export interface CsvPointOptions {
  /** 经度列名（缺省自动识别） */
  lonField?: string;
  /** 纬度列名（缺省自动识别） */
  latField?: string;
  /** 高程列名（可选；缺省自动识别，找不到则忽略） */
  heightField?: string;
}

export interface CsvParseResult {
  geojson: GeoJSONFeatureCollection;
  /** 命中的经度列名（原始表头） */
  lonField: string;
  /** 命中的纬度列名 */
  latField: string;
  /** 命中的高程列名（可选） */
  heightField?: string;
  /** 被跳过的数据行号（1 基，含表头行计数） */
  skippedRows: number[];
}

export const LON_FIELD_CANDIDATES = ['lon', 'lng', 'longitude', 'x', '经度'];
export const LAT_FIELD_CANDIDATES = ['lat', 'latitude', 'y', '纬度'];
export const HEIGHT_FIELD_CANDIDATES = ['height', 'altitude', 'alt', 'z', '高程', 'elevation'];

export function parseCsvToGeoJSON(text: string, options: CsvPointOptions = {}): CsvParseResult {
  const rows = parseCsvRows(text);
  if (rows.length < 2) {
    throw new Error('CSV 至少需要表头和一行数据');
  }
  const headers = rows[0].map((h) => h.trim());
  const lowerHeaders = headers.map((h) => h.toLowerCase());

  const lonIdx = findColumn(options.lonField, LON_FIELD_CANDIDATES, headers, lowerHeaders, '经度', true);
  const latIdx = findColumn(options.latField, LAT_FIELD_CANDIDATES, headers, lowerHeaders, '纬度', true);
  const heightIdx = options.heightField
    ? findColumn(options.heightField, HEIGHT_FIELD_CANDIDATES, headers, lowerHeaders, '高程', true)
    : findColumn(undefined, HEIGHT_FIELD_CANDIDATES, headers, lowerHeaders, '高程', false);

  const skippedRows: number[] = [];
  const features: GeoJSONFeature[] = [];
  for (let row = 1; row < rows.length; row++) {
    const cells = rows[row];
    if (cells.every((c) => c.trim() === '')) continue;

    const lon = toNumber(cells[lonIdx]);
    const lat = toNumber(cells[latIdx]);
    const height = heightIdx >= 0 ? toNumber(cells[heightIdx]) : undefined;
    if (lon === null || lat === null || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      skippedRows.push(row);
      continue;
    }

    const properties: Record<string, unknown> = {};
    headers.forEach((header, i) => {
      const value = cells[i]?.trim() ?? '';
      if (value === '') return;
      const num = toNumber(value);
      properties[header] = num ?? value;
    });

    const position: GeoJSONPosition = height !== null && height !== undefined ? [lon, lat, height] : [lon, lat];
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: position }, properties });
  }

  if (features.length === 0) {
    throw new Error(`CSV 没有可用的有效坐标行（跳过 ${skippedRows.length} 行）`);
  }
  return {
    geojson: { type: 'FeatureCollection', features },
    lonField: headers[lonIdx],
    latField: headers[latIdx],
    ...(heightIdx >= 0 ? { heightField: headers[heightIdx] } : {}),
    skippedRows,
  };
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

function findColumn(
  explicit: string | undefined,
  candidates: string[],
  headers: string[],
  lowerHeaders: string[],
  label: string,
  required: boolean,
): number {
  if (explicit) {
    const idx = lowerHeaders.indexOf(explicit.trim().toLowerCase());
    if (idx === -1) {
      throw new Error(`CSV 中不存在「${label}」列：${explicit}（现有列：${headers.join(', ')}）`);
    }
    return idx;
  }
  const idx = lowerHeaders.findIndex((h) => candidates.includes(h));
  if (idx === -1) {
    if (required) {
      throw new Error(
        `未找到「${label}」列：自动识别候选 ${candidates.join('/')}，现有列：${headers.join(', ')}（可用 options 显式指定列名）`,
      );
    }
    return -1;
  }
  return idx;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/** RFC4180 风格行解析：引号字段、"" 转义、\r\n | \n | \r 行分隔（自动去 BOM） */
function parseCsvRows(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < source.length) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      // \r\n 视为单次换行
      if (ch === '\r' && source[i + 1] === '\n') i++;
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // 最后一行（无换行结尾时）
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}
