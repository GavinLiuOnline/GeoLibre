import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findCrs, resolveCrs } from '../packages/processing/src/reprojection-crs';

describe('crs 内置坐标系', () => {
  it('解析内置 EPSG 代码（大小写/前缀不敏感）', () => {
    assert.ok((findCrs('EPSG:4326')?.def).includes('longlat'));
    assert.strictEqual((findCrs('epsg:4326')?.code), 'EPSG:4326');
    assert.strictEqual((findCrs('4326')?.geographic), true);
    assert.strictEqual((findCrs('EPSG:3857')?.unit), 'metre');
    assert.ok((findCrs('EPSG:4490')?.name).includes('CGCS2000'));
  });

  it('EPSG:4544/4547 高斯克吕格 3 度带中央子午线正确（105E/114E）', () => {
    const crs4544 = findCrs('EPSG:4544');
    const crs4547 = findCrs('EPSG:4547');
    assert.ok((crs4544?.def).includes('+lon_0=105'));
    assert.ok((crs4547?.def).includes('+lon_0=114'));
    assert.ok((crs4544?.def).includes('x_0=500000'));
    // 全系生成：4534 = CM 75E，每带 +3°
    assert.ok((findCrs('EPSG:4534')?.def).includes('+lon_0=75'));
    assert.ok((findCrs('EPSG:4549')?.def).includes('+lon_0=120'));
  });

  it('UTM 各带（EPSG:326XX 北 / 327XX 南）', () => {
    const north = findCrs('EPSG:32650');
    assert.ok((north?.def).includes('+proj=utm +zone=50'));
    assert.ok(!(north?.def).includes('+south'));
    const south = findCrs('EPSG:32755');
    assert.ok((south?.def).includes('+proj=utm +zone=55'));
    assert.ok((south?.def).includes('+south'));
    assert.strictEqual((findCrs('EPSG:32600')), undefined); // 非法带号
    assert.strictEqual((findCrs('EPSG:32661')), undefined);
  });

  it('未知输入按自定义 proj4 定义原样透传', () => {
    const custom = '+proj=tmerc +lat_0=0 +lon_0=117 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
    const resolved = resolveCrs(custom);
    assert.strictEqual((resolved.custom), true);
    assert.strictEqual((resolved.def), custom);
    // 空定义报错
    assert.throws((() => resolveCrs('  ')), /坐标系定义为空/);
  });
});
