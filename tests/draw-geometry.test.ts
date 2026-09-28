/*
  editing/draw-geometry.test —— 绘制 → 顶点编辑 → 属性编辑 数据链路
  （自 gis-full drawGeometry.test 移植；场景序列化两例属 gis-full sceneIO 专属，不在本仓范围）

  验收点：
  - 绘制点/折线/多边形：环自动闭合、id 稳定可读、双击重复末点兜底；
  - 顶点拖拽：折线中点更新、闭合环首点移动同步闭合点；
  - 要素删除：按 id 过滤后集合正确。
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, GeoJSON, Position, Polygon } from "geojson";

import { positionsToFeatures, resetDrawFeatureSeq } from "../packages/core/src/editing/draw-geometry";
import {
  appendFeatures,
  dedupeConsecutivePositions,
  enumerateVertices,
  findFeature,
  listFeatures,
  replaceFeature,
  replaceFeatureGeometry,
  updateVertex,
} from "../packages/core/src/editing/geojson-edit";

const p = (x: number, y: number): Position => [x, y];

describe("draw-geometry · 绘制 → 顶点编辑 → 属性编辑 数据链路", () => {
  it("绘制多边形：环自动闭合、顶点数记录、id 稳定可读", () => {
    const features = positionsToFeatures("polygon", [p(0, 0), p(1, 0), p(1, 1)]);
    assert.strictEqual(features.length, 1);
    const geometry = features[0].geometry;
    assert.strictEqual(geometry?.type, "Polygon");
    if (geometry?.type !== "Polygon") throw new Error("unexpected");
    assert.strictEqual(geometry.coordinates[0].length, 4);
    assert.deepStrictEqual(geometry.coordinates[0][3], geometry.coordinates[0][0]);
    assert.match(String(features[0].id), /^draw-polygon-\d+$/);
    assert.strictEqual((features[0].properties as Record<string, unknown>).__draw, "polygon");
    assert.strictEqual((features[0].properties as Record<string, unknown>).vertexCount, 3);
  });

  it("绘制折线：双击重复末点被清理后才写回", () => {
    // Cesium DOUBLE_CLICK 会先触发两次 LEFT_CLICK（同一坐标）
    const raw = [p(0, 0), p(1, 1), p(1, 1)];
    const cleaned = dedupeConsecutivePositions(raw);
    const features = positionsToFeatures("line", cleaned);
    const geometry = features[0].geometry;
    if (geometry?.type !== "LineString") throw new Error("unexpected");
    assert.strictEqual(geometry.coordinates.length, 2);
  });

  it("绘制点：每个落点一个要素（支持连续点绘）", () => {
    resetDrawFeatureSeq();
    const features = positionsToFeatures("point", [p(1, 2), p(3, 4)]);
    assert.strictEqual(features.length, 2);
    assert.notStrictEqual(features[0].id, features[1].id);
  });

  it("顶点拖拽：修改折线中间顶点并保留其余顶点", () => {
    const drawn = positionsToFeatures("line", [p(0, 0), p(1, 1), p(2, 0)]);
    const feature = drawn[0];
    if (feature.geometry?.type !== "LineString") throw new Error("unexpected");

    const vertices = enumerateVertices(feature.geometry);
    assert.strictEqual(vertices.length, 3);
    const moved = updateVertex(feature.geometry, vertices[1].path, p(1, 5));
    if (moved.type !== "LineString") throw new Error("unexpected");
    assert.deepStrictEqual(moved.coordinates, [p(0, 0), p(1, 5), p(2, 0)]);
  });

  it("顶点拖拽：移动多边形首点时闭合点同步更新", () => {
    const drawn = positionsToFeatures("polygon", [p(0, 0), p(1, 0), p(1, 1)]);
    const geometry = drawn[0].geometry;
    if (geometry?.type !== "Polygon") throw new Error("unexpected");

    const moved = updateVertex(geometry, [0, 0], p(-1, -1)) as Polygon;
    const ring = moved.coordinates[0];
    assert.deepStrictEqual(ring[0], p(-1, -1));
    assert.deepStrictEqual(ring[ring.length - 1], p(-1, -1));
  });

  it("完整链路：绘制折线 → 顶点编辑 → 属性编辑（写回图层内嵌数据）", () => {
    resetDrawFeatureSeq();
    // 1. 绘制写回图层内嵌数据（addGeoJsonLayer 场景的等价数据操作）
    let data: GeoJSON = appendFeatures(undefined, positionsToFeatures("line", [p(0, 0), p(1, 1)]));
    const drawnId = listFeatures(data)[0].id as string;

    // 2. 顶点编辑：把第 2 个顶点拖到 (1, 2)
    const before = findFeature(data, drawnId);
    if (before?.geometry?.type !== "LineString") throw new Error("unexpected");
    const vertices = enumerateVertices(before.geometry);
    data = replaceFeatureGeometry(data, drawnId, updateVertex(before.geometry, vertices[1].path, p(1, 2)));

    // 3. 属性编辑：新增 name 字段（属性面板保存的等价数据操作）
    const afterVertex = findFeature(data, drawnId) as Feature;
    data = replaceFeature(data, drawnId, {
      ...afterVertex,
      properties: { __draw: "line", vertexCount: 2, name: "编辑后的折线" },
    });

    // 4. 结果：几何与属性均已更新且 id 保持稳定
    const restored = findFeature(data, drawnId) as Feature;
    assert.deepStrictEqual(restored.geometry, { type: "LineString", coordinates: [p(0, 0), p(1, 2)] });
    assert.strictEqual((restored.properties as Record<string, unknown>).name, "编辑后的折线");
    assert.strictEqual(restored.id, drawnId);
  });

  it("要素删除：删除后集合不再包含该要素", () => {
    const data = appendFeatures(undefined, positionsToFeatures("point", [p(1, 1), p(2, 2)]));
    const [first, second] = listFeatures(data);
    const next: GeoJSON = {
      type: "FeatureCollection",
      features: listFeatures(data).filter((f) => f.id !== first.id),
    };
    assert.deepStrictEqual(listFeatures(next).map((f) => f.id), [second.id]);
  });
});
