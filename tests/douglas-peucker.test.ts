import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoJSONPosition } from '@geolibre/gis-shared';

import { simplifyPositions, simplifyRing } from '../packages/processing/src/douglas-peucker';

const p = (x: number, y: number): GeoJSONPosition => [x, y];

describe('Douglas-Peucker 抽稀', () => {
  it('共线点列只保留首尾点', () => {
    const line = [p(0, 0), p(1, 0), p(2, 0), p(3, 0)];
    const result = simplifyPositions(line, 0.1);
    assert.deepStrictEqual((result), [p(0, 0), p(3, 0)]);
  });

  it('显著偏离点被保留，容差内的点被剔除（确定性用例）', () => {
    // 首轮对 (0,0)-(4,0) 弦：dmax=0.1 在 idx1；右段 (1,0.1)-(4,0) 内两点距离 0.047/0.017 均小于容差
    const line = [p(0, 0), p(1, 0.1), p(2, 0.02), p(3, 0.05), p(4, 0)];
    const result = simplifyPositions(line, 0.06);
    assert.deepStrictEqual((result), [p(0, 0), p(1, 0.1), p(4, 0)]);
  });

  it('容差为 0 时返回全部点的副本（不修改输入）', () => {
    const line = [p(0, 0), p(1, 0.5), p(2, 0)];
    const result = simplifyPositions(line, 0);
    assert.strictEqual((result).length, (3));
    assert.notStrictEqual((result), line);
    assert.deepStrictEqual((result[1]), line[1]);
    // 修改副本不影响输入
    result[1][0] = 999;
    assert.strictEqual((line[1][0]), 1);
  });

  it('闭合环抽稀：边中点被剔除、角点保留、闭合性保持', () => {
    const ring = [
      p(0, 0),
      p(1, 0), // 边中点（应剔除）
      p(2, 0),
      p(2, 1), // 边中点（应剔除）
      p(2, 2),
      p(1, 2), // 边中点（应剔除）
      p(0, 2),
      p(0, 0),
    ];
    const result = simplifyRing(ring, 0.1);
    assert.deepStrictEqual((result), [p(0, 0), p(2, 0), p(2, 2), p(0, 2), p(0, 0)]);
    assert.deepStrictEqual((result[0]), result[result.length - 1]);
  });

  it('闭合环无法简化为有效环（<4 点）时返回原始环', () => {
    const ring = [p(0, 0), p(1, 0.01), p(2, 0.02), p(2, 0.04), p(0, 0)];
    const result = simplifyRing(ring, 0.05);
    assert.deepStrictEqual((result), ring);
  });
});
