import assert from "node:assert/strict";
import { describe, it } from "node:test";

import proj4 from 'proj4';
import type { GeoJSONFeatureCollection } from '@geolibre/gis-shared';

import { applySevenParameter, sampleTransform, transformGeoJSON, transformPosition } from '../packages/processing/src/reprojection-transform';

/** 参考值来源：proj4js 直接计算（proj4('EPSG:4326', def, [116.391, 39.907])） */
const LONLAT: [number, number] = [116.391, 39.907];
const MERCATOR = [12956586.852919903, 4852436.961991247];
const GK3_114 = [704464.0525952806, 4421940.733201582];
const UTM50N = [447945.31341121916, 4417612.695562761];

describe('transformGeoJSON 坐标配准', () => {
  it('EPSG:4326 → EPSG:3857（Web 墨卡托）结果与参考值一致', () => {
    const result = transformPosition(LONLAT, 'EPSG:4326', 'EPSG:3857');
    assert.ok(Math.abs((result[0]) - (MERCATOR[0])) < Math.pow(10, -(1)) / 2);
    assert.ok(Math.abs((result[1]) - (MERCATOR[1])) < Math.pow(10, -(1)) / 2);
  });

  it('EPSG:4326 → EPSG:4547（CGCS2000 3 度带 CM 114E）', () => {
    const result = transformPosition(LONLAT, 'EPSG:4326', 'EPSG:4547');
    assert.ok(Math.abs((result[0]) - (GK3_114[0])) < Math.pow(10, -(1)) / 2);
    assert.ok(Math.abs((result[1]) - (GK3_114[1])) < Math.pow(10, -(1)) / 2);
  });

  it('UTM 50N（EPSG:32650）', () => {
    const result = transformPosition(LONLAT, 'EPSG:4326', 'EPSG:32650');
    assert.ok(Math.abs((result[0]) - (UTM50N[0])) < Math.pow(10, -(1)) / 2);
    assert.ok(Math.abs((result[1]) - (UTM50N[1])) < Math.pow(10, -(1)) / 2);
  });

  it('自定义 proj4 定义字符串与内置 EPSG:4544 结果一致', () => {
    const custom = '+proj=tmerc +lat_0=0 +lon_0=105 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
    const viaCode = transformPosition(LONLAT, 'EPSG:4326', 'EPSG:4544');
    const viaCustom = transformPosition(LONLAT, 'EPSG:4326', custom);
    assert.ok(Math.abs((viaCustom[0]) - (viaCode[0])) < Math.pow(10, -(6)) / 2);
    assert.ok(Math.abs((viaCustom[1]) - (viaCode[1])) < Math.pow(10, -(6)) / 2);
  });

  it('4326 → 4490 → 4326 往返一致（CGCS2000 ≈ WGS84）', () => {
    const fwd = transformPosition(LONLAT, 'EPSG:4326', 'EPSG:4490');
    const back = transformPosition(fwd, 'EPSG:4490', 'EPSG:4326');
    assert.ok(Math.abs((back[0]) - (LONLAT[0])) < Math.pow(10, -(9)) / 2);
    assert.ok(Math.abs((back[1]) - (LONLAT[1])) < Math.pow(10, -(9)) / 2);
  });

  it('递归转换 FeatureCollection/MultiPolygon 全部坐标位，保留属性并去掉过期 bbox', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      bbox: [116, 39, 117, 40],
      features: [
        {
          type: 'Feature',
          properties: { name: '测试', value: 42 },
          geometry: {
            type: 'MultiPolygon',
            coordinates: [[[[116, 39, 10], [117, 39, 20], [117, 40, 30], [116, 39, 10]]]],
          },
        },
      ],
    };
    const out = transformGeoJSON(fc, 'EPSG:4326', 'EPSG:3857');
    assert.ok(!('bbox' in Object((out))));
    assert.strictEqual((out.type), 'FeatureCollection');
    const feature = (out as GeoJSONFeatureCollection).features[0];
    assert.deepStrictEqual((feature.properties), { name: '测试', value: 42 });
    const ring = (feature.geometry as { coordinates: number[][][][] }).coordinates[0][0];
    const expected = proj4('EPSG:4326', '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs', [116, 39]);
    // 坐标被转换且第三维高度原样保留
    assert.ok(Math.abs((ring[0][0]) - (expected[0])) < Math.pow(10, -(3)) / 2);
    assert.ok(Math.abs((ring[0][1]) - (expected[1])) < Math.pow(10, -(3)) / 2);
    assert.strictEqual((ring[0][2]), 10);
    assert.deepStrictEqual((ring[3]), ring[0]); // 闭合环保持闭合
  });

  it('sampleTransform 返回逐点转换前后对照', () => {
    const samples = sampleTransform(
      [[116, 39], [117, 40], [110, 35]],
      'EPSG:4326',
      'EPSG:3857',
    );
    assert.strictEqual((samples).length, (3));
    assert.deepStrictEqual((samples[0].source), [116, 39]);
    const direct = transformPosition([116, 39], 'EPSG:4326', 'EPSG:3857');
    assert.ok(Math.abs((samples[0].target[0]) - (direct[0])) < Math.pow(10, -(6)) / 2);
    assert.ok(Math.abs((samples[0].target[1]) - (direct[1])) < Math.pow(10, -(6)) / 2);
    assert.deepStrictEqual((samples[2].source), [110, 35]);
  });
});

describe('七参数布尔莎模型', () => {
  it('全零参数为恒等变换', () => {
    const out = applySevenParameter([116.391, 39.907, 100], {});
    assert.ok(Math.abs((out[0]) - (116.391)) < Math.pow(10, -(12)) / 2);
    assert.ok(Math.abs((out[1]) - (39.907)) < Math.pow(10, -(12)) / 2);
    assert.ok(Math.abs((out[2]) - (100)) < Math.pow(10, -(6)) / 2);
  });

  it('赤道本初子午线上的 dx=100 平移表现为高程 +100m', () => {
    const out = applySevenParameter([0, 0, 0], { dx: 100 });
    assert.ok(Math.abs((out[0]) - (0)) < Math.pow(10, -(9)) / 2);
    assert.ok(Math.abs((out[1]) - (0)) < Math.pow(10, -(9)) / 2);
    assert.ok(Math.abs((out[2]) - (100)) < Math.pow(10, -(6)) / 2);
  });

  it('尺度参数 scale=1e6 ppm（放大 2 倍）使高程增至椭球半径量级', () => {
    const out = applySevenParameter([0, 0, 0], { scale: 1e6 });
    assert.ok(Math.abs((out[2]) - (6378137)) < Math.pow(10, -(0)) / 2);
  });

  it('rz 旋转 1 角秒 ≈ 经度偏移 1/3600°（角秒换算正确）', () => {
    const out = applySevenParameter([0, 0, 0], { rz: 1 });
    assert.ok(Math.abs((out[0]) - (1 / 3600)) < Math.pow(10, -(12)) / 2);
    assert.ok((Math.abs(out[1])) < (1e-12));
  });

  it('含七参数的完整配准：反向参数可还原源坐标', () => {
    const fwd = { dx: 10, dy: -20, dz: 30, rx: 0.5, ry: -0.4, rz: 0.3, scale: 2 };
    const inv = { dx: -10, dy: 20, dz: -30, rx: -0.5, ry: 0.4, rz: -0.3, scale: -2 };
    const moved = transformPosition(LONLAT, 'EPSG:4326', 'EPSG:4326', { seven: fwd });
    const restored = transformPosition(moved, 'EPSG:4326', 'EPSG:4326', { seven: inv });
    // 一阶近似（旋转为小角）下应高度接近原坐标
    assert.ok(Math.abs((restored[0]) - (LONLAT[0])) < Math.pow(10, -(3)) / 2);
    assert.ok(Math.abs((restored[1]) - (LONLAT[1])) < Math.pow(10, -(3)) / 2);
  });
});
