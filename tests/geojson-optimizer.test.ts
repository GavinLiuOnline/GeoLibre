import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoJSONFeatureCollection } from '@geolibre/gis-shared';

import { optimizeGeoJSON } from '../packages/processing/src/geojson-optimizer';

function fc(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'a', code: '001', extra: 'x' },
        geometry: {
          type: 'LineString',
          // 中间三点均在弦上/容差内，可被抽稀
          coordinates: [[110, 30], [111, 30], [112, 30], [113, 30], [114, 30.8]],
        },
      },
      {
        type: 'Feature',
        properties: { name: 'b', code: '002' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [120, 30], [121, 30], [122, 30], [122, 31], [122, 32], [121, 32], [120, 32], [120, 30],
          ]],
        },
      },
      {
        type: 'Feature',
        properties: { name: 'c' },
        geometry: { type: 'Point', coordinates: [100, 20] },
      },
    ],
  };
}

describe('optimizeGeoJSON 数据轻量化', () => {
  /** result.data 是 GeoJSONData 联合类型，本用例集均为 FeatureCollection */
  function featuresOf(result: { data: ReturnType<typeof optimizeGeoJSON>['data'] }): GeoJSONFeatureCollection {
    return result.data as GeoJSONFeatureCollection;
  }

  it('Douglas-Peucker 抽稀减少顶点并保持统计正确', () => {
    const result = optimizeGeoJSON(fc(), { tolerance: 0.3 });
    assert.strictEqual((result.beforeVertices), 14); // 5（线） + 8（环） + 1（点）
    // 线：5 → 3（首轮保留最大偏离 (113,30)，共线点剔除）；
    // 环：8 → 5（边中点剔除，闭合保持）；点不变
    assert.strictEqual((result.afterVertices), 9);
    const line = featuresOf(result).features[0].geometry as { type: string; coordinates: number[][] };
    assert.deepStrictEqual((line.coordinates), [[110, 30], [113, 30], [114, 30.8]]);
    const polygon = featuresOf(result).features[1].geometry as { coordinates: number[][][] };
    // 闭合点保持首尾一致
    assert.deepStrictEqual((polygon.coordinates[0][0]), polygon.coordinates[0][polygon.coordinates[0].length - 1]);
    assert.deepStrictEqual((polygon.coordinates[0]), [[120, 30], [122, 30], [122, 32], [120, 32], [120, 30]]);
    assert.strictEqual((result.beforeFeatures), 3);
    assert.strictEqual((result.afterFeatures), 3);
  });

  it('Point 几何不受抽稀影响', () => {
    const result = optimizeGeoJSON(fc(), { tolerance: 1 });
    const point = featuresOf(result).features[2].geometry as { type: string; coordinates: number[] };
    assert.strictEqual((point.type), 'Point');
    assert.deepStrictEqual((point.coordinates), [100, 20]);
  });

  it('keepProperties 白名单裁剪属性字段', () => {
    const result = optimizeGeoJSON(fc(), { keepProperties: ['name'] });
    assert.deepStrictEqual((featuresOf(result).features[0].properties), { name: 'a' });
    assert.deepStrictEqual((featuresOf(result).features[1].properties), { name: 'b' });
  });

  it('dropProperties 黑名单剔除属性字段，可与白名单叠加', () => {
    const onlyDrop = optimizeGeoJSON(fc(), { dropProperties: ['extra'] });
    assert.deepStrictEqual((featuresOf(onlyDrop).features[0].properties), { name: 'a', code: '001' });

    const both = optimizeGeoJSON(fc(), { keepProperties: ['name', 'code'], dropProperties: ['code'] });
    assert.deepStrictEqual((featuresOf(both).features[0].properties), { name: 'a' });
  });

  it('maxFeatures 限制要素数量（保留前 N 个）', () => {
    const result = optimizeGeoJSON(fc(), { maxFeatures: 2 });
    assert.strictEqual((result.afterFeatures), 2);
    assert.strictEqual((featuresOf(result).features).length, (2));
    assert.strictEqual(((featuresOf(result).features[0].properties as { name: string }).name), 'a');
  });

  it('无选项时不抽稀、不裁剪，返回统计', () => {
    const result = optimizeGeoJSON(fc(), {});
    assert.strictEqual((result.beforeVertices), result.afterVertices);
    assert.deepStrictEqual((featuresOf(result).features[0].properties), { name: 'a', code: '001', extra: 'x' });
  });
});
