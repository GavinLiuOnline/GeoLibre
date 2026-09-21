/**
 * core/editing · draw-geometry（自 gis-full 原样移植） —— 绘制几何构造（纯函数，可单测）
 *
 * 从 stores/drawingTools 抽出的无副作用部分：
 * 绘制顶点 → GeoJSON 要素（点 / 折线 / 闭合多边形），并给出稳定要素 id，
 * 便于「绘制 → 顶点编辑 → 属性编辑 → 场景序列化」整条链路在无浏览器环境下回归。
 */
import type { Feature, Position } from "geojson";

/** 绘制类型 */
export type DrawKind = "point" | "line" | "polygon";

/** 绘制要素 id 前缀 → 便于在属性面板/日志中识别来源 */
export const DRAW_ID_PREFIX: Record<DrawKind, string> = {
  point: "draw-point",
  line: "draw-line",
  polygon: "draw-polygon",
};

export function drawKindLabel(kind: DrawKind): string {
  return kind === "point" ? "点" : kind === "line" ? "折线" : "多边形";
}

let featureCounter = 0;

/** 重置序号（测试用；运行时一般无需调用） */
export function resetDrawFeatureSeq(): void {
  featureCounter = 0;
}

function nextSeq(): number {
  featureCounter += 1;
  return featureCounter;
}

/**
 * 绘制顶点 → GeoJSON 要素：
 * - point：每个落点一个 Point 要素；
 * - line：一个 LineString 要素；
 * - polygon：一个 Polygon 要素（环自动首尾闭合）。
 *
 * 要素 id 稳定且可读（`draw-line-1`），保证写回图层后能被属性面板与顶点编辑定位。
 */
export function positionsToFeatures(
  kind: DrawKind,
  positions: Position[],
): Feature[] {
  const seq = nextSeq();
  if (kind === "point") {
    return positions.map<Feature>((p, i) => ({
      type: "Feature",
      id: `${DRAW_ID_PREFIX.point}-${seq}-${i + 1}`,
      geometry: { type: "Point", coordinates: p },
      properties: { __draw: "point" },
    }));
  }
  if (kind === "line") {
    return [
      {
        type: "Feature",
        id: `${DRAW_ID_PREFIX.line}-${seq}`,
        geometry: { type: "LineString", coordinates: positions },
        properties: { __draw: "line", vertexCount: positions.length },
      },
    ];
  }
  const ring: Position[] = [...positions];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    // 闭合点维度与首点保持一致（GeoJSON 环首尾应完全相等）
    ring.push(
      first.length === 3 ? [first[0], first[1], first[2] ?? 0] : [first[0], first[1]],
    );
  }
  return [
    {
      type: "Feature",
      id: `${DRAW_ID_PREFIX.polygon}-${seq}`,
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { __draw: "polygon", vertexCount: positions.length },
    },
  ];
}
