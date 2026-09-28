import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCsvToGeoJSON } from '../packages/processing/src/import-csv';

describe('parseCsvToGeoJSON CSV 点位解析', () => {
  it('自动识别 lon/lat 列并解析数值属性', () => {
    const text = [
      'lon,lat,name,height',
      '116.39,39.90,北京,50',
      '121.47,31.23,上海,10',
    ].join('\n');
    const result = parseCsvToGeoJSON(text);
    assert.strictEqual((result.geojson.features).length, (2));
    assert.strictEqual((result.lonField), 'lon');
    assert.strictEqual((result.latField), 'lat');
    assert.strictEqual((result.heightField), 'height');
    const first = result.geojson.features[0];
    assert.strictEqual((first.geometry?.type), 'Point');
    assert.deepStrictEqual(((first.geometry as { coordinates: number[] }).coordinates), [116.39, 39.9, 50]);
    assert.deepStrictEqual((first.properties), { lon: 116.39, lat: 39.9, name: '北京', height: 50 });
  });

  it('lng/latitude 列名、带引号的逗号字段（RFC4180）', () => {
    const text = [
      '"lng","lat","desc"',
      '"120.15","30.28","West Lake, Hangzhou"',
    ].join('\n');
    const result = parseCsvToGeoJSON(text);
    assert.strictEqual((result.lonField), 'lng');
    assert.strictEqual((result.latField), 'lat');
    assert.strictEqual((result.geojson.features[0].properties?.desc), 'West Lake, Hangzhou');
    assert.deepStrictEqual(((result.geojson.features[0].geometry as { coordinates: number[] }).coordinates), [
      120.15, 30.28,
    ]);
  });

  it('中文表头（经度/纬度）+ CRLF + BOM', () => {
    const text = '\uFEFF经度,纬度,备注\r\n116,40,点A\r\n117,41,点B';
    const result = parseCsvToGeoJSON(text);
    assert.strictEqual((result.lonField), '经度');
    assert.strictEqual((result.latField), '纬度');
    assert.strictEqual((result.geojson.features).length, (2));
  });

  it('显式指定列名 + 高程列可选', () => {
    const text = ['x,y,z', '116,39,10'].join('\n');
    const result = parseCsvToGeoJSON(text, { lonField: 'x', latField: 'y' });
    // 未指定 heightField 时 z 也会被自动识别为高程
    assert.strictEqual((result.heightField), 'z');
    assert.deepStrictEqual(((result.geojson.features[0].geometry as { coordinates: number[] }).coordinates), [
      116, 39, 10,
    ]);
  });

  it('非法行跳过并记录行号', () => {
    const text = [
      'lon,lat',
      '116,39',
      'abc,40', // 经度非法
      '117,99', // 纬度越界
      '118,41',
    ].join('\n');
    const result = parseCsvToGeoJSON(text);
    assert.strictEqual((result.geojson.features).length, (2));
    assert.deepStrictEqual((result.skippedRows), [2, 3]);
  });

  it('缺少经纬度列时抛出明确错误', () => {
    assert.throws((() => parseCsvToGeoJSON('name,age\na,1')), /经度/);
    assert.throws((() => parseCsvToGeoJSON('lon,name\n116,a', { latField: 'y' })), /纬度/);
  });
});
