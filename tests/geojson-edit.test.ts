/*
  editing/geojson-edit.test —— GeoJSON 要素级编辑纯函数（自 gis-full geojsonEdit.test 移植）

  验收点：
  - 要素 id 归一化（feat-N 分配 / 重复 id 重排 / 纯几何原样）；
  - 要素增 / 删 / 改（属性、几何），未命中返回原数据（引用不变）；
  - 顶点枚举路径寻址（Polygon/MultiPolygon 环跳过闭合点）；
  - 单点更新：闭合环首点移动同步闭合点；非法路径返回原几何；
  - dedupeConsecutivePositions 兜底双击重复末点。
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, Geometry, GeoJSON, Position, Polygon } from "geojson";

import {
  appendFeatures,
  dedupeConsecutivePositions,
  enumerateVertices,
  findFeature,
  isClosedRing,
  listFeatures,
  normalizeFeatureIds,
  removeFeature,
  replaceFeature,
  replaceFeatureGeometry,
  updateVertex,
} from "../packages/core/src/editing/geojson-edit";

const p = (x: number, y: number, z?: number): Position =>
  z === undefined ? [x, y] : [x, y, z];

const pointFeature = (id: string | number | undefined, x: number, y: number): Feature => ({
  type: "Feature",
  ...(id === undefined ? {} : { id }),
  geometry: { type: "Point", coordinates: [x, y] },
  properties: {},
});

describe("geojson-edit · 要素 id 归一化", () => {
  it("为缺 id 的要素分配 feat-N，且保留已有唯一 id", () => {
    const data: GeoJSON = {
      type: "FeatureCollection",
      features: [pointFeature(undefined, 1, 1), pointFeature("keep", 2, 2), pointFeature(undefined, 3, 3)],
    };
    const out = normalizeFeatureIds(data);
    const ids = listFeatures(out).map((f) => f.id);
    assert.strictEqual(ids[0], "feat-1");
    assert.strictEqual(ids[1], "keep");
    assert.strictEqual(ids[2], "feat-2");
  });

  it("重复 id 会被重新分配，保证唯一", () => {
    const data: GeoJSON = {
      type: "FeatureCollection",
      features: [pointFeature("dup", 1, 1), pointFeature("dup", 2, 2)],
    };
    const out = normalizeFeatureIds(data);
    const ids = listFeatures(out).map((f) => String(f.id));
    assert.strictEqual(new Set(ids).size, 2);
    assert.strictEqual(ids[0], "dup");
    assert.strictEqual(ids[1], "feat-1");
  });

  it("单独 Feature 缺 id 时补 feat-1，纯几何原样返回", () => {
    const feature = normalizeFeatureIds<GeoJSON>(pointFeature(undefined, 1, 1));
    assert.strictEqual((feature as Feature).id, "feat-1");

    const geometry: GeoJSON = { type: "Point", coordinates: [1, 2] };
    assert.strictEqual(normalizeFeatureIds(geometry), geometry);
  });

  it("不修改输入（不可变）", () => {
    const data: GeoJSON = {
      type: "FeatureCollection",
      features: [pointFeature(undefined, 1, 1)],
    };
    const out = normalizeFeatureIds(data);
    assert.strictEqual(listFeatures(data)[0].id, undefined);
    assert.strictEqual(listFeatures(out)[0].id, "feat-1");
  });

  it("listFeatures 把纯几何包成匿名 Feature", () => {
    const features = listFeatures({ type: "LineString", coordinates: [p(0, 0), p(1, 1)] });
    assert.strictEqual(features.length, 1);
    assert.strictEqual(features[0].geometry?.type, "LineString");
    assert.strictEqual(features[0].properties, null);
  });
});

describe("geojson-edit · 要素增删改", () => {
  const fc: GeoJSON = {
    type: "FeatureCollection",
    features: [pointFeature("a", 1, 1), pointFeature("b", 2, 2)],
  };

  it("findFeature 支持字符串/数字 id 比较", () => {
    assert.strictEqual(findFeature(fc, "a")?.id, "a");
    assert.strictEqual(findFeature({ ...fc, features: [pointFeature(7, 1, 1)] }, 7)?.id, 7);
    assert.strictEqual(findFeature(fc, "nope"), undefined);
    assert.strictEqual(findFeature(fc, undefined), undefined);
  });

  it("appendFeatures 追加要素并保持集合形态", () => {
    const out = appendFeatures(fc, [pointFeature("c", 3, 3)]);
    assert.strictEqual(listFeatures(out).length, 3);
    assert.strictEqual(listFeatures(fc).length, 2);
  });

  it("appendFeatures 对纯几何数据自动包成 FeatureCollection", () => {
    const out = appendFeatures({ type: "Point", coordinates: [0, 0] }, [pointFeature("c", 3, 3)]);
    assert.strictEqual(out.type, "FeatureCollection");
    assert.strictEqual(listFeatures(out).length, 2);
  });

  it("replaceFeature 命中才替换，未命中返回原数据", () => {
    const next = pointFeature("a", 9, 9);
    const out = replaceFeature(fc, "a", next);
    assert.deepStrictEqual(findFeature(out, "a")?.geometry, { type: "Point", coordinates: [9, 9] });
    assert.strictEqual(replaceFeature(fc, "zzz", next), fc);
  });

  it("removeFeature 删除要素；单 Feature 删除后为空集合", () => {
    const out = removeFeature(fc, "a");
    assert.deepStrictEqual(listFeatures(out).map((f) => f.id), ["b"]);

    const single: GeoJSON = pointFeature("solo", 1, 1);
    const removed = removeFeature(single, "solo");
    assert.strictEqual(removed.type, "FeatureCollection");
    assert.strictEqual(listFeatures(removed).length, 0);
  });

  it("replaceFeatureGeometry 只改几何，属性保留", () => {
    const withProps: GeoJSON = {
      type: "FeatureCollection",
      features: [{ ...pointFeature("a", 1, 1), properties: { name: "x" } }],
    };
    const out = replaceFeatureGeometry(withProps, "a", {
      type: "Point",
      coordinates: [5, 5],
    });
    const feature = findFeature(out, "a");
    assert.deepStrictEqual(feature?.properties, { name: "x" });
    assert.deepStrictEqual(feature?.geometry, { type: "Point", coordinates: [5, 5] });
    assert.strictEqual(replaceFeatureGeometry(withProps, "missing", null), withProps);
  });
});

describe("geojson-edit · 顶点枚举与更新", () => {
  it("枚举 Point / LineString / Polygon，多边形环跳过闭合点", () => {
    assert.deepStrictEqual(enumerateVertices({ type: "Point", coordinates: [1, 2] }), [
      { path: [], position: [1, 2] },
    ]);

    assert.strictEqual(enumerateVertices({ type: "LineString", coordinates: [p(0, 0), p(1, 1)] }).length, 2);

    const polygon: Polygon = {
      type: "Polygon",
      coordinates: [[p(0, 0), p(1, 0), p(1, 1), p(0, 0)]],
    };
    const verts = enumerateVertices(polygon);
    assert.strictEqual(verts.length, 3);
    assert.deepStrictEqual(verts.map((v) => v.path), [[0, 0], [0, 1], [0, 2]]);
  });

  it("MultiPolygon 路径为 [面, 环, 点]", () => {
    const geometry: Geometry = {
      type: "MultiPolygon",
      coordinates: [
        [[p(0, 0), p(1, 0), p(1, 1), p(0, 0)]],
        [[p(5, 5), p(6, 5), p(6, 6), p(5, 5)]],
      ],
    };
    const verts = enumerateVertices(geometry);
    assert.deepStrictEqual(verts[0].path, [0, 0, 0]);
    assert.deepStrictEqual(verts[verts.length - 1].path, [1, 0, 2]);
  });

  it("updateVertex 更新点样式几何的单个顶点且不修改输入", () => {
    const line: Geometry = { type: "LineString", coordinates: [p(0, 0), p(1, 1)] };
    const out = updateVertex(line, [1], [9, 9]);
    assert.deepStrictEqual((out as typeof line).coordinates, [p(0, 0), p(9, 9)]);
    assert.deepStrictEqual(line.coordinates, [p(0, 0), p(1, 1)]);
  });

  it("updateVertex 移动闭合环首点时同步改写闭合点", () => {
    const polygon: Geometry = {
      type: "Polygon",
      coordinates: [[p(0, 0), p(1, 0), p(1, 1), p(0, 0)]],
    };
    const out = updateVertex(polygon, [0, 0], [2, 2]) as Polygon;
    assert.deepStrictEqual(out.coordinates[0], [p(2, 2), p(1, 0), p(1, 1), p(2, 2)]);
    assert.strictEqual(isClosedRing(out.coordinates[0]), true);
  });

  it("updateVertex 路径非法时返回原几何（引用不变）", () => {
    const line: Geometry = { type: "LineString", coordinates: [p(0, 0)] };
    assert.strictEqual(updateVertex(line, [3], [9, 9]), line);
    assert.strictEqual(updateVertex(line, [], [9, 9]), line);
  });

  it("Point 高程序号可写回三坐标", () => {
    const out = updateVertex({ type: "Point", coordinates: [1, 2] }, [], [1, 2, 30]);
    assert.deepStrictEqual((out as Extract<Geometry, { type: "Point" }>).coordinates, [1, 2, 30]);
  });
});

describe("geojson-edit · 绘制辅助", () => {
  it("dedupeConsecutivePositions 去掉双击产生的重复末点", () => {
    const positions = [p(1, 1), p(2, 2), p(2, 2), p(3, 3), p(3, 3), p(3, 3)];
    assert.deepStrictEqual(dedupeConsecutivePositions(positions), [p(1, 1), p(2, 2), p(3, 3)]);
  });

  it("dedupeConsecutivePositions 保留非连续重复点", () => {
    const positions = [p(1, 1), p(2, 2), p(1, 1)];
    assert.strictEqual(dedupeConsecutivePositions(positions).length, 3);
  });

  it("dedupeConsecutivePositions 不修改输入数组", () => {
    const positions = [p(1, 1), p(1, 1)];
    const out = dedupeConsecutivePositions(positions);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(positions.length, 2);
  });
});
