/*
  geojson-lightweight 单测：轻量化变换（DP 简化 + 精度截断）与框选过滤。
*/
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FeatureCollection } from "geojson";

import {
  featuresIntersectingBbox,
  lightweightGeoJson,
} from "../apps/geolibre-desktop/src/lib/geojson-lightweight";

function makeFc(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: 1,
        properties: { name: "折线" },
        geometry: {
          type: "LineString",
          coordinates: [
            [116.000001, 39.900001],
            [116.000002, 39.900002],
            [116.000003, 39.900003],
            [116.000004, 39.900004],
            [116.000005, 39.900005],
          ],
        },
      },
      {
        type: "Feature",
        id: "pt-2",
        properties: { name: "点" },
        geometry: { type: "Point", coordinates: [116.123456789, 39.987654321] },
      },
      {
        type: "Feature",
        properties: { name: "远处面" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [120, 30],
              [121, 30],
              [121, 31],
              [120, 31],
              [120, 30],
            ],
          ],
        },
      },
    ],
  };
}

test("lightweightGeoJson：精度截断生效且保留维度", () => {
  const result = lightweightGeoJson(makeFc(), { toleranceDeg: 0, precision: 5 });
  const point = result.fc.features[1];
  assert.deepEqual(point?.geometry, {
    type: "Point",
    coordinates: [116.12346, 39.98765],
  });
  // 非破坏：原集合坐标不变
  const original = makeFc();
  assert.equal(
    (original.features[1]?.geometry as { coordinates: number[] }).coordinates[0],
    116.123456789,
  );
});

test("lightweightGeoJson：共线折线被 DP 简化，顶点数下降", () => {
  const result = lightweightGeoJson(makeFc(), { toleranceDeg: 0.01, precision: 6 });
  const line = result.fc.features[0]?.geometry as { type: string; coordinates: number[][] };
  assert.equal(line.type, "LineString");
  assert.ok(line.coordinates.length < 5, `expected fewer vertices, got ${line.coordinates.length}`);
  assert.ok(result.verticesAfter < result.verticesBefore);
});

test("lightweightGeoJson：面环简化后仍闭合（≥4 点）", () => {
  const result = lightweightGeoJson(makeFc(), { toleranceDeg: 0.01, precision: 6 });
  const polygon = result.fc.features[2]?.geometry as { coordinates: number[][][] };
  assert.ok(polygon.coordinates[0].length >= 4);
  const first = polygon.coordinates[0][0];
  const last = polygon.coordinates[0][polygon.coordinates[0].length - 1];
  assert.deepEqual(first, last);
});

test("featuresIntersectingBbox：按坐标包围盒求交，键约定 feature.id ?? 下标", () => {
  // 框选覆盖北京附近两个要素（id:1 折线与无 id 的点 → 键 "1"）
  const keys = featuresIntersectingBbox(makeFc(), [115.9, 39.8, 116.3, 40.1]);
  assert.deepEqual(keys, ["1", "pt-2"]);
});

test("featuresIntersectingBbox：不相交返回空", () => {
  const keys = featuresIntersectingBbox(makeFc(), [130, 20, 131, 21]);
  assert.deepEqual(keys, []);
});
