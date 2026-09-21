/**
 * core/editing · geojson-edit（自 gis-full 原样移植） —— GeoJSON 要素级编辑（纯函数，可单测）
 *
 * 供绘制工具（drawingTools）与顶点编辑（stores/vertexEditor）复用：
 * - 归一化要素 id：保证每个要素都有**稳定且唯一**的 id，这是
 *   「画布拾取 → entity ↔ feature 对应 → 属性/顶点编辑」链路的基石；
 * - 要素增 / 删 / 改（属性、几何）；
 * - 顶点枚举与单点更新（路径寻址，多边形环自动处理闭合点）。
 *
 * 所有函数均返回新对象（不可变更新），原数据不被修改。
 */
import type {
  Feature,
  FeatureCollection,
  Geometry,
  GeoJSON as GeoJSONData,
  Position,
} from "geojson";

/** 自动生成的要素 id 前缀 */
export const FEATURE_ID_PREFIX = "feat-";

// ---------------------------------------------------------------------------
// 判定 / 归一化
// ---------------------------------------------------------------------------

export function isFeatureCollection(data: GeoJSONData): data is FeatureCollection {
  return data.type === "FeatureCollection";
}

export function isFeature(data: GeoJSONData): data is Feature {
  return data.type === "Feature";
}

/** 是否为几何对象（非 Feature / FeatureCollection） */
export function isGeometry(data: GeoJSONData): data is Geometry {
  return data.type !== "Feature" && data.type !== "FeatureCollection";
}

function isBlankId(id: unknown): boolean {
  return id === undefined || id === null || id === "";
}

/**
 * 归一化要素 id：
 * - FeatureCollection：逐个要素保证唯一 id，缺省/重复 id 自动分配 `feat-N`；
 * - Feature：缺 id 时补 `feat-1`；
 * - 纯几何：原样返回（无要素概念）。
 *
 * 返回新对象，保持原有文档形态（Feature 仍是 Feature、纯几何仍是纯几何）。
 */
export function normalizeFeatureIds<T extends GeoJSONData>(data: T): T {
  if (isFeatureCollection(data)) {
    const used = new Set<string>();
    let seq = 1;
    const nextSeq = (): string => {
      let id = `${FEATURE_ID_PREFIX}${seq++}`;
      while (used.has(id)) id = `${FEATURE_ID_PREFIX}${seq++}`;
      return id;
    };
    const features = data.features.map((feature) => {
      const raw = isBlankId(feature.id) ? undefined : String(feature.id);
      const id = raw === undefined || used.has(raw) ? nextSeq() : raw;
      used.add(id);
      return { ...feature, id } as Feature;
    });
    return { ...data, features } as T;
  }
  if (isFeature(data) && isBlankId(data.id)) {
    return { ...data, id: `${FEATURE_ID_PREFIX}1` } as T;
  }
  return data;
}

/** 把任意 GeoJSONData 展开为要素数组（纯几何包成匿名 Feature） */
export function listFeatures(data: GeoJSONData | undefined): Feature[] {
  if (!data) return [];
  if (isFeatureCollection(data)) return data.features;
  if (isFeature(data)) return [data];
  return [{ type: "Feature", geometry: data, properties: null }];
}

/** 把任意 GeoJSONData 归一化为 FeatureCollection（保持要素 id） */
export function toFeatureCollection(data: GeoJSONData | undefined): FeatureCollection {
  if (!data) return { type: "FeatureCollection", features: [] };
  if (isFeatureCollection(data)) return data;
  return { type: "FeatureCollection", features: listFeatures(data) };
}

// ---------------------------------------------------------------------------
// 要素查找 / 增删改
// ---------------------------------------------------------------------------

/** 按要素 id 查找（id 比较统一转字符串） */
export function findFeature(
  data: GeoJSONData | undefined,
  featureId: string | number | undefined,
): Feature | undefined {
  if (featureId === undefined) return undefined;
  const key = String(featureId);
  return listFeatures(data).find((f) => !isBlankId(f.id) && String(f.id) === key);
}

/** 追加要素（纯几何数据先包成 FeatureCollection） */
export function appendFeatures(
  data: GeoJSONData | undefined,
  features: Feature[],
): GeoJSONData {
  const fc = toFeatureCollection(data);
  return { ...fc, features: [...fc.features, ...features] };
}

/** 替换要素（属性/几何整体替换）；未命中返回原数据 */
export function replaceFeature(
  data: GeoJSONData | undefined,
  featureId: string | number,
  next: Feature,
): GeoJSONData {
  if (!data) return data as unknown as GeoJSONData;
  const key = String(featureId);
  if (isFeatureCollection(data)) {
    let hit = false;
    const features = data.features.map((f) => {
      if (!isBlankId(f.id) && String(f.id) === key) {
        hit = true;
        return { ...next, id: next.id ?? f.id };
      }
      return f;
    });
    return hit ? { ...data, features } : data;
  }
  if (isFeature(data)) {
    return !isBlankId(data.id) && String(data.id) === key ? next : data;
  }
  return data;
}

/** 删除要素（FeatureCollection 删除后仍为集合；单 Feature 删除后为空集合） */
export function removeFeature(
  data: GeoJSONData | undefined,
  featureId: string | number,
): GeoJSONData {
  const key = String(featureId);
  if (!data) return { type: "FeatureCollection", features: [] };
  if (isFeatureCollection(data)) {
    return {
      ...data,
      features: data.features.filter((f) => isBlankId(f.id) || String(f.id) !== key),
    };
  }
  if (isFeature(data)) {
    return { type: "FeatureCollection", features: [] };
  }
  return data;
}

/** 替换某要素的几何（属性不变）；几何为 null 表示清空几何 */
export function replaceFeatureGeometry(
  data: GeoJSONData | undefined,
  featureId: string | number,
  geometry: Geometry | null,
): GeoJSONData {
  const feature = findFeature(data, featureId);
  if (!feature) return data as unknown as GeoJSONData;
  return replaceFeature(data, featureId, { ...feature, geometry } as Feature);
}

// ---------------------------------------------------------------------------
// 顶点（路径寻址）
// ---------------------------------------------------------------------------

/**
 * 顶点引用：
 * - Point：path = []
 * - MultiPoint / LineString：path = [index]
 * - MultiLineString / Polygon：path = [lineIndex, index]
 * - MultiPolygon：path = [polygonIndex, ringIndex, index]
 */
export interface VertexRef {
  path: number[];
  position: Position;
}

/** 判断两个坐标位是否（近似）相同 */
export function samePosition(
  a: Position | undefined,
  b: Position | undefined,
  epsilon = 1e-9,
): boolean {
  if (!a || !b) return false;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (Math.abs(av - bv) > epsilon) return false;
  }
  return true;
}

/** 环是否闭合（首尾坐标相同） */
export function isClosedRing(ring: Position[]): boolean {
  return ring.length > 2 && samePosition(ring[0], ring[ring.length - 1]);
}

/**
 * 枚举几何的可编辑顶点。
 * 多边形/多多边形的环若首尾重合（GeoJSON 规范），只枚举到倒数第二个点，
 * 保证闭合点不会被单独拖动（更新时会同步改写闭合点）。
 */
export function enumerateVertices(geometry: Geometry): VertexRef[] {
  const out: VertexRef[] = [];
  const pushPositions = (positions: Position[], prefix: number[]): void => {
    positions.forEach((position, index) => {
      out.push({ path: [...prefix, index], position });
    });
  };
  switch (geometry.type) {
    case "Point":
      out.push({ path: [], position: geometry.coordinates });
      break;
    case "MultiPoint":
      pushPositions(geometry.coordinates, []);
      break;
    case "LineString":
      pushPositions(geometry.coordinates, []);
      break;
    case "MultiLineString":
      geometry.coordinates.forEach((line, i) => pushPositions(line, [i]));
      break;
    case "Polygon":
      geometry.coordinates.forEach((ring, i) => {
        const list = isClosedRing(ring) ? ring.slice(0, -1) : ring;
        pushPositions(list, [i]);
      });
      break;
    case "MultiPolygon":
      geometry.coordinates.forEach((polygon, i) => {
        polygon.forEach((ring, j) => {
          const list = isClosedRing(ring) ? ring.slice(0, -1) : ring;
          pushPositions(list, [i, j]);
        });
      });
      break;
  }
  return out;
}

/** 第 `depth` 层环状坐标数组是否闭合（用于更新后同步闭合点） */
function ringIsClosed(ring: Position[]): boolean {
  return isClosedRing(ring);
}

/**
 * 按路径更新单个顶点坐标，返回新几何（不可变）。
 * - 多边形环若原本闭合，更新首点后会同步改写末点，保持环闭合；
 * - 路径非法时返回原几何。
 */
export function updateVertex(
  geometry: Geometry,
  path: number[],
  position: Position,
): Geometry {
  switch (geometry.type) {
    case "Point":
      return path.length === 0 ? { ...geometry, coordinates: position } : geometry;
    case "MultiPoint":
      return updatePositionList(geometry, "coordinates", path, position);
    case "LineString":
      return updatePositionList(geometry, "coordinates", path, position);
    case "MultiLineString": {
      const [i, j] = path;
      if (i === undefined || j === undefined) return geometry;
      const line = geometry.coordinates[i];
      if (!line || j >= line.length) return geometry;
      const nextLine = replaceAt(line, j, position);
      return {
        ...geometry,
        coordinates: replaceAt(geometry.coordinates, i, nextLine),
      };
    }
    case "Polygon": {
      const [i, j] = path;
      if (i === undefined || j === undefined) return geometry;
      const ring = geometry.coordinates[i];
      if (!ring || j >= ring.length) return geometry;
      return {
        ...geometry,
        coordinates: replaceAt(
          geometry.coordinates,
          i,
          moveRingVertex(ring, j, position),
        ),
      };
    }
    case "MultiPolygon": {
      const [i, j, k] = path;
      if (i === undefined || j === undefined || k === undefined) return geometry;
      const polygon = geometry.coordinates[i];
      const ring = polygon?.[j];
      if (!ring || k >= ring.length) return geometry;
      const nextPolygon = replaceAt(polygon, j, moveRingVertex(ring, k, position));
      return {
        ...geometry,
        coordinates: replaceAt(geometry.coordinates, i, nextPolygon),
      };
    }
    default:
      return geometry;
  }
}

/** MultiPoint / LineString 单层坐标数组更新 */
function updatePositionList<G extends Geometry & { coordinates: Position[] }>(
  geometry: G,
  _key: "coordinates",
  path: number[],
  position: Position,
): G {
  const [i] = path;
  if (i === undefined || i >= geometry.coordinates.length) return geometry;
  return { ...geometry, coordinates: replaceAt(geometry.coordinates, i, position) };
}

/** 移动环上一点；若环闭合且移动的是首点，同步改写末点 */
function moveRingVertex(
  ring: Position[],
  index: number,
  position: Position,
): Position[] {
  const closed = ringIsClosed(ring);
  const next = replaceAt(ring, index, position);
  if (closed && index === 0 && next.length > 1) {
    return replaceAt(next, next.length - 1, position);
  }
  return next;
}

function replaceAt<T>(list: T[], index: number, value: T): T[] {
  const next = list.slice();
  next[index] = value;
  return next;
}

// ---------------------------------------------------------------------------
// 绘制辅助
// ---------------------------------------------------------------------------

/**
 * 去除连续重复的坐标位。
 *
 * 用途：Cesium 的 LEFT_DOUBLE_CLICK 会先触发两次 LEFT_CLICK（同一位置），
 * 折线/多边形绘制结束时会产生一个重复顶点，这里做兜底清理。
 */
export function dedupeConsecutivePositions(
  positions: Position[],
  epsilon = 1e-9,
): Position[] {
  const out: Position[] = [];
  for (const position of positions) {
    const prev = out[out.length - 1];
    if (prev && samePosition(prev, position, epsilon)) continue;
    out.push(position);
  }
  return out;
}

/** 环是否首尾闭合（导出别名，语义更直白） */
export { isClosedRing as isRingClosed };

/** 几何类型 → 中文标签（UI / 日志用） */
export function geometryLabel(type: Geometry["type"]): string {
  switch (type) {
    case "Point":
      return "点";
    case "MultiPoint":
      return "多点";
    case "LineString":
      return "折线";
    case "MultiLineString":
      return "多折线";
    case "Polygon":
      return "面";
    case "MultiPolygon":
      return "多面";
    case "GeometryCollection":
      return "几何集合";
    default:
      return type;
  }
}
