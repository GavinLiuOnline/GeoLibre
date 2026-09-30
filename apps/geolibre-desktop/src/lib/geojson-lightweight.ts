/*
  lib/geojson-lightweight —— 数据轻量化（数据优化）的纯函数核心

  面向「矢量数据瘦身」的两类变换：
  - Douglas-Peucker 简化（复用 @geolibre/processing 的 simplifyPositions /
    simplifyRing，容差单位为度）
  - 坐标精度截断（小数位截断到 precision 位，6 位 ≈ 0.11 m）
  以及矩形框选的几何过滤：
  - featuresIntersectingBbox：按要素坐标包围盒与框选 bbox 求交，返回
    与 AttributeTable 一致的要素键（feature.id ?? 数组下标字符串）
  全部纯函数、无引擎依赖，可单测。
*/
import type { Feature, FeatureCollection, Geometry } from "geojson";

type AnyFeature = Feature<Geometry | null>;

import { simplifyPositions, simplifyRing } from "@geolibre/processing";

export interface LightweightOptions {
  /** DP 容差（度），0 表示不简化 */
  toleranceDeg: number;
  /** 坐标小数位（截断），undefined 表示不变更精度 */
  precision?: number;
}

export interface LightweightResult {
  /** 输出的要素集合（Feature.geometry 允许 null，与 geojson 规范一致） */
  fc: FeatureCollection;
  verticesBefore: number;
  verticesAfter: number;
  bytesBefore: number;
  bytesAfter: number;
}

function roundTo(value: number, precision: number | undefined): number {
  if (precision === undefined || !Number.isFinite(value)) return value;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function countVertices(geometry: Geometry | null): number {
  if (!geometry) return 0;
  switch (geometry.type) {
    case "Point":
      return 1;
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates.length;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.reduce((sum, part) => sum + part.length, 0);
    case "MultiPolygon":
      return geometry.coordinates.reduce(
        (sum, polygon) => sum + polygon.reduce((s, ring) => s + ring.length, 0),
        0,
      );
    case "GeometryCollection":
      return geometry.geometries.reduce((sum, g) => sum + countVertices(g), 0);
    default:
      return 0;
  }
}

/** 位置数组：简化 + 精度截断（保留第三维高度原值截断） */
function transformPositions(
  positions: number[][],
  options: LightweightOptions,
): number[][] {
  const simplified =
    options.toleranceDeg > 0
      ? simplifyPositions(positions as never, options.toleranceDeg)
      : positions;
  return simplified.map((p) => [
    roundTo(p[0], options.precision),
    roundTo(p[1], options.precision),
    ...(p.length > 2 ? [roundTo(p[2], options.precision)] : []),
  ]);
}

function transformRing(ring: number[][], options: LightweightOptions): number[][] {
  // 简化后至少保持闭合 4 点（线环最短形态），不足则退回原环仅截断精度
  const simplified =
    options.toleranceDeg > 0
      ? simplifyRing(ring as never, options.toleranceDeg)
      : ring;
  const usable = simplified.length >= 4 ? simplified : ring;
  return transformPositions(usable, { ...options, toleranceDeg: 0 });
}

export function transformGeometry(
  geometry: Geometry,
  options: LightweightOptions,
): Geometry {
  switch (geometry.type) {
    case "Point": {
      const [x, y, z] = geometry.coordinates as number[];
      return {
        ...geometry,
        coordinates: [
          roundTo(x, options.precision),
          roundTo(y, options.precision),
          ...(z !== undefined ? [roundTo(z, options.precision)] : []),
        ],
      };
    }
    case "MultiPoint":
    case "LineString":
      return {
        ...geometry,
        coordinates: transformPositions(geometry.coordinates as number[][], options) as never,
      };
    case "MultiLineString":
    case "Polygon":
      return {
        ...geometry,
        // Polygon 的 part 是线环（走 transformRing 保持闭合最短形态），
        // MultiLineString 的 part 是普通线
        coordinates: (geometry.coordinates as number[][][]).map((part) =>
          geometry.type === "Polygon"
            ? transformRing(part, options)
            : transformPositions(part, options),
        ) as never,
      };
    case "MultiPolygon":
      return {
        ...geometry,
        coordinates: (geometry.coordinates as number[][][][]).map((polygon) =>
          polygon.map((ring) => transformRing(ring, options)) as never,
        ) as never,
      };
    case "GeometryCollection":
      return {
        ...geometry,
        geometries: geometry.geometries.map((g) => transformGeometry(g, options)),
      };
    default:
      return geometry;
  }
}

/** 对 FeatureCollection 应用轻量化并返回前后统计（非破坏：返回新对象）。 */
export function lightweightGeoJson(
  fc: FeatureCollection,
  options: LightweightOptions,
): LightweightResult {
  const before = JSON.stringify(fc).length;
  const verticesBefore = fc.features.reduce(
    (sum, f) => sum + countVertices(f.geometry),
    0,
  );
  const out = {
    type: "FeatureCollection" as const,
    features: fc.features.map((feature): AnyFeature => ({
      ...feature,
      geometry: feature.geometry ? transformGeometry(feature.geometry, options) : null,
    })),
  };
  const verticesAfter = out.features.reduce(
    (sum, f) => sum + countVertices(f.geometry),
    0,
  );
  // 实现保证 null geometry 只在输入已为 null 时出现；此处收窄回严格集合
  return {
    fc: out as unknown as FeatureCollection,
    verticesBefore,
    verticesAfter,
    bytesBefore: before,
    bytesAfter: JSON.stringify(out).length,
  };
}

/** 要素键：与 AttributeTable 的行 id 约定一致（feature.id ?? 数组下标字符串）。 */
export function featureKey(feature: Feature, index: number): string {
  return String(feature.id ?? index);
}

/** 要素坐标包围盒 [w, s, e, n]（空几何返回 null）。 */
export function featureBbox(feature: Feature): [number, number, number, number] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const [x, y] = coords as [number, number];
      if (x < w) w = x;
      if (y < s) s = y;
      if (x > e) e = x;
      if (y > n) n = y;
      return;
    }
    for (const child of coords) visit(child);
  };
  const coords = (feature.geometry as { coordinates?: unknown } | null)?.coordinates;
  visit(coords);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** 框选：返回坐标包围盒与 bbox 相交的要素键列表。 */
export function featuresIntersectingBbox(
  fc: FeatureCollection,
  bbox: [number, number, number, number],
): string[] {
  const [w, s, e, n] = bbox;
  const keys: string[] = [];
  fc.features.forEach((feature, index) => {
    const fb = featureBbox(feature);
    if (!fb) return;
    const [fw, fs, fe, fn] = fb;
    if (fw <= e && fe >= w && fs <= n && fn >= s) keys.push(featureKey(feature, index));
  });
  return keys;
}
