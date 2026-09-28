/**
 * editor/core · localCache/crsRegistry 单测（t37）
 *
 * 覆盖验收要点：
 * 1. 预置注册表完整性：3857/4326/4490 内置别名（nativeTilingMode 快路径）+
 *    CGCS2000 6°/3° 带（带号系 + CM 系，含任务点名的 4513/4523/4533/4547/4549）+
 *    Beijing 1954 / Xian 1980 + UTM 50N/51N；
 * 2. proj4 定义正确性抽查：中央经线 / 东偏 / 椭球片段（EPSG 官方参数对照）；
 * 3. findCrsEntry：大小写不敏感、接受 'epsg:xxxx' / '4544' 裸代码；
 * 4. validateProj4Def：空串 / 乱码给出可读错误；合法定义（tmerc / longlat）通过；
 * 5. normalizeCrsValidBounds：经纬度允许 ±90，投影类禁止触极；
 * 6. resolveCrsInput：注册表命中（含裸代码）/ EPSG 直填未注册 → 可读错误 /
 *    自定义 proj4（投影类必填 validBounds、经纬度缺省全球）/ origin、tileMatrix 透传；
 * 7. normalizeXyzLayerCrs：metadata 反序列化 round-trip（JSON 往返后逐字段一致）；
 * 8. isXyzLayerCrs 判定（字符串形态 'EPSG:4490' 不认——那是配准 projection 字段）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  XYZ_CRS_REGISTRY,
  findCrsEntry,
  isGeographicProj4Def,
  isXyzLayerCrs,
  normalizeCrsValidBounds,
  normalizeXyzLayerCrs,
  resolveCrsInput,
  validateProj4Def,
} from '../packages/xyz-cache/src/crs-registry';

const TM_105 = '+proj=tmerc +lat_0=0 +lon_0=105 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';

// ---------------------------------------------------------------------------
// 注册表完整性
// ---------------------------------------------------------------------------

describe('t37 · XYZ_CRS_REGISTRY 预置注册表', () => {
  it('内置别名：3857/4326/4490 带 nativeTilingMode，网格形态与地理性正确', () => {
    const byId = (id: string) => findCrsEntry(id)!;

    const m3857 = byId('EPSG:3857');
    assert.strictEqual(m3857.nativeTilingMode, 'web-mercator');
    assert.strictEqual(m3857.tileMatrix, 'square-2^z');
    assert.strictEqual(m3857.geographic, false);
    assert.deepStrictEqual(m3857.validBounds, [-180, -85.0511287798066, 180, 85.0511287798066]);

    const g4326 = byId('EPSG:4326');
    assert.strictEqual(g4326.nativeTilingMode, 'geographic');
    assert.strictEqual(g4326.tileMatrix, 'geodetic-2x1');
    assert.strictEqual(g4326.geographic, true);
    assert.deepStrictEqual(g4326.validBounds, [-180, -90, 180, 90]);

    const cgcs4490 = byId('EPSG:4490');
    assert.strictEqual(cgcs4490.nativeTilingMode, 'geographic');
    assert.ok(cgcs4490.proj4.includes('+ellps=GRS80'));
  });

  it('任务点名条目齐全：EPSG:4513 / 4523 / 4533 / 4547 / 4549（CGCS2000 3° 带）', () => {
    // 3° 带号系：EPSG:4513 → zone 25 / CM 75E；4523 → zone 35 / CM 105E；4533 → zone 45 / CM 135E
    const z25 = findCrsEntry('EPSG:4513')!;
    assert.strictEqual(z25.category, 'cgcs2000');
    assert.ok(z25.proj4.includes('+lon_0=75'));
    assert.ok(z25.proj4.includes('+x_0=25500000')); // FE = zone×1e6 + 500000
    assert.ok(z25.proj4.includes('+ellps=GRS80'));

    const z35 = findCrsEntry('EPSG:4523')!;
    assert.ok(z35.proj4.includes('+lon_0=105'));
    assert.ok(z35.proj4.includes('+x_0=35500000'));

    const z45 = findCrsEntry('EPSG:4533')!;
    assert.ok(z45.proj4.includes('+lon_0=135'));
    assert.ok(z45.proj4.includes('+x_0=45500000'));

    // 3° CM 系：EPSG:4547 → CM 114E（FE 500000）；4549 → CM 120E
    const cm114 = findCrsEntry('EPSG:4547')!;
    assert.ok(cm114.proj4.includes('+lon_0=114'));
    assert.ok(cm114.proj4.includes('+x_0=500000'));
    assert.deepStrictEqual(cm114.validBounds, [112.5, 0, 115.5, 84]);

    const cm120 = findCrsEntry('EPSG:4549')!;
    assert.ok(cm120.proj4.includes('+lon_0=120'));
    assert.deepStrictEqual(cm120.validBounds, [118.5, 0, 121.5, 84]);
  });

  it('CGCS2000 6° 带两条系列（带号系 4491–4501 / CM 系 4502–4512）', () => {
    const zone13 = findCrsEntry('EPSG:4491')!;
    assert.ok(zone13.proj4.includes('+lon_0=75'));
    assert.ok(zone13.proj4.includes('+x_0=13500000')); // zone 13
    assert.deepStrictEqual(zone13.validBounds, [72, 0, 78, 84]);

    const cm75 = findCrsEntry('EPSG:4502')!;
    assert.ok(cm75.proj4.includes('+lon_0=75'));
    assert.ok(cm75.proj4.includes('+x_0=500000'));

    const cm135 = findCrsEntry('EPSG:4512')!;
    assert.ok(cm135.proj4.includes('+lon_0=135'));
  });

  it('Beijing 1954（krass 椭球）与 Xian 1980（IAG 1975）系列', () => {
    const bj54Zone = findCrsEntry('EPSG:21413')!;
    assert.strictEqual(bj54Zone.category, 'beijing54');
    assert.ok(bj54Zone.proj4.includes('+ellps=krass'));
    assert.ok(bj54Zone.proj4.includes('+lon_0=75'));

    const bj54Cm = findCrsEntry('EPSG:21453')!;
    assert.ok(bj54Cm.proj4.includes('+ellps=krass'));
    assert.ok(bj54Cm.proj4.includes('+x_0=500000'));

    const x80Cm = findCrsEntry('EPSG:2338')!;
    assert.strictEqual(x80Cm.category, 'xian80');
    assert.ok(x80Cm.proj4.includes('+a=6378140'));
    assert.ok(x80Cm.proj4.includes('+rf=298.257'));

    const x80Zone = findCrsEntry('EPSG:2349')!;
    assert.ok(x80Zone.proj4.includes('+lon_0=75'));
    assert.ok(x80Zone.proj4.includes('+x_0=25500000'));

    // 经纬度别名
    assert.strictEqual(findCrsEntry('EPSG:4214')!.nativeTilingMode, 'geographic');
    assert.strictEqual(findCrsEntry('EPSG:4610')!.nativeTilingMode, 'geographic');
  });

  it('UTM 50N / 51N（中国常用带）', () => {
    const z50 = findCrsEntry('EPSG:32650')!;
    assert.strictEqual(z50.category, 'utm');
    assert.ok(z50.proj4.includes('+proj=utm +zone=50'));
    assert.ok(!z50.proj4.includes('+south'));
    assert.deepStrictEqual(z50.validBounds, [114, 0, 120, 84]);

    const z51 = findCrsEntry('EPSG:32651')!;
    assert.ok(z51.proj4.includes('+proj=utm +zone=51'));
    assert.deepStrictEqual(z51.validBounds, [120, 0, 126, 84]);
  });

  it('所有条目字段完备且 id 唯一；投影类条目 proj4 正算探针可用', () => {
    const ids = new Set<string>();
    for (const entry of XYZ_CRS_REGISTRY) {
      assert.strictEqual(ids.has(entry.id), false);
      ids.add(entry.id);
      assert.ok(entry.label.length > (0));
      assert.strictEqual(entry.origin, 'top-left');
      assert.ok(['square-2^z', 'geodetic-2x1'].includes(entry.tileMatrix));
      assert.strictEqual(entry.validBounds.length, (4));
      if (!entry.nativeTilingMode) {
        // 非别名条目必须真的能算（在其自身有效范围内采样正反算探针）
        assert.strictEqual(validateProj4Def(entry.proj4, entry.validBounds), undefined);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 查找 / 校验
// ---------------------------------------------------------------------------

describe('t37 · findCrsEntry / validateProj4Def / normalizeCrsValidBounds', () => {
  it('findCrsEntry：大小写不敏感 + 裸代码 + 未命中 undefined', () => {
    assert.strictEqual(findCrsEntry('EPSG:4544')?.id, 'EPSG:4544');
    assert.strictEqual(findCrsEntry('epsg:4544')?.id, 'EPSG:4544');
    assert.strictEqual(findCrsEntry('  4544  ')?.id, 'EPSG:4544');
    assert.strictEqual(findCrsEntry('EPSG:999999'), undefined);
    assert.strictEqual(findCrsEntry(''), undefined);
    assert.strictEqual(findCrsEntry(undefined as never), undefined);
  });

  it('validateProj4Def：空串 / 乱码报错，tmerc / longlat 通过', () => {
    assert.match(validateProj4Def(''), /为空/);
    assert.match(validateProj4Def('   '), /为空/);
    assert.ok(validateProj4Def('这不是 proj4 定义'));
    assert.ok(validateProj4Def('+proj=nosuchprojection +lon_0=0'));

    assert.strictEqual(validateProj4Def(TM_105), undefined);
    assert.strictEqual(validateProj4Def('+proj=longlat +datum=WGS84 +no_defs'), undefined);
  });

  it('isGeographicProj4Def：longlat/latlong 判定', () => {
    assert.strictEqual(isGeographicProj4Def('+proj=longlat +datum=WGS84 +no_defs'), true);
    assert.strictEqual(isGeographicProj4Def('+proj=latlong +ellps=GRS80'), true);
    assert.strictEqual(isGeographicProj4Def(TM_105), false);
  });

  it('normalizeCrsValidBounds：经纬度允许 ±90，投影类禁止触极', () => {
    assert.deepStrictEqual(normalizeCrsValidBounds([100, 20, 110, 40], { geographic: false }), [100, 20, 110, 40]);
    assert.deepStrictEqual(normalizeCrsValidBounds([0, -90, 10, 90], { geographic: true }), [0, -90, 10, 90]);
    // 投影类：纬度触极拒绝（tmerc 在极点发散）
    assert.strictEqual(normalizeCrsValidBounds([0, -90, 10, 90], { geographic: false }), undefined);
    assert.strictEqual(normalizeCrsValidBounds([0, 89.9, 10, 90], { geographic: false }), undefined);
    // 通用非法：逆序 / 越界 / 非数字 / 长度
    assert.strictEqual(normalizeCrsValidBounds([110, 20, 100, 40], { geographic: false }), undefined);
    assert.strictEqual(normalizeCrsValidBounds([100, 20, 190, 40], { geographic: false }), undefined);
    assert.strictEqual(normalizeCrsValidBounds([100, 20, 110, Number.NaN], { geographic: false }), undefined);
    assert.strictEqual(normalizeCrsValidBounds([100, 20, 110], { geographic: false }), undefined);
    assert.strictEqual(normalizeCrsValidBounds('nope', { geographic: false }), undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveCrsInput（UI「自定义…」/ EPSG 直填统一入口）
// ---------------------------------------------------------------------------

describe('t37 · resolveCrsInput', () => {
  it('注册表命中（EPSG:CODE 直填）→ 展开定义 + 默认 validBounds + id/label', () => {
    const r = resolveCrsInput({ proj4: 'EPSG:4544' });
    assert.strictEqual(r.ok, true);
    if (!r.ok) return;
    assert.strictEqual(r.crs.kind, 'proj4');
    assert.strictEqual(r.crs.id, 'EPSG:4544');
    assert.ok(r.crs.label.includes('CGCS2000'));
    assert.ok(r.crs.proj4.includes('+lon_0=105'));
    assert.deepStrictEqual(r.crs.validBounds, [103.5, 0, 106.5, 84]);
  });

  it('裸代码 / epsgCode 参数同样命中注册表', () => {
    const bare = resolveCrsInput({ proj4: '4502' });
    assert.strictEqual(bare.ok, true);
    if (bare.ok) assert.strictEqual(bare.crs.id, 'EPSG:4502');

    const viaField = resolveCrsInput({ epsgCode: 'EPSG:4502' });
    assert.strictEqual(viaField.ok, true);
    if (viaField.ok) assert.strictEqual(viaField.crs.id, 'EPSG:4502');
  });

  it('注册表命中 + 用户 validBounds 覆盖默认值', () => {
    const r = resolveCrsInput({ proj4: 'EPSG:4547', validBounds: [113, 5, 114.5, 60] });
    assert.strictEqual(r.ok, true);
    if (r.ok) assert.deepStrictEqual(r.crs.validBounds, [113, 5, 114.5, 60]);
  });

  it('未注册的 EPSG 代码 → 可读错误（指引改粘贴 proj4）', () => {
    const r = resolveCrsInput({ proj4: 'EPSG:999999' });
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.match(r.error, /无法识别 EPSG:999999/);
  });

  it('自定义投影定义：validBounds 必填；给定时原样采用', () => {
    const missing = resolveCrsInput({ proj4: TM_105 });
    assert.strictEqual(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /必须填写有效范围/);

    const ok = resolveCrsInput({ proj4: TM_105, validBounds: [103, 20, 107, 50] });
    assert.strictEqual(ok.ok, true);
    if (ok.ok) {
      assert.strictEqual(ok.crs.proj4, TM_105);
      assert.deepStrictEqual(ok.crs.validBounds, [103, 20, 107, 50]);
      assert.strictEqual(ok.crs.id, undefined);
    }
  });

  it('经纬度自定义定义：validBounds 缺省全球', () => {
    const r = resolveCrsInput({ proj4: '+proj=longlat +datum=WGS84 +no_defs' });
    assert.strictEqual(r.ok, true);
    if (r.ok) assert.deepStrictEqual(r.crs.validBounds, [-180, -90, 180, 90]);
  });

  it('非法输入：空定义 / 触极范围 / 逆序范围 → 可读错误', () => {
    assert.strictEqual(resolveCrsInput({}).ok, false);
    assert.strictEqual(resolveCrsInput({ proj4: TM_105, validBounds: [103, 90, 107, 95] }).ok, false);
    assert.strictEqual(resolveCrsInput({ proj4: TM_105, validBounds: [107, 20, 103, 50] }).ok, false);
  });

  it('origin / tileMatrix 透传（bottom-left = TMS 行序、geodetic-2x1）', () => {
    const r = resolveCrsInput({
      proj4: '+proj=longlat +datum=WGS84 +no_defs',
      origin: 'bottom-left',
      tileMatrix: 'geodetic-2x1',
    });
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.crs.origin, 'bottom-left');
      assert.strictEqual(r.crs.tileMatrix, 'geodetic-2x1');
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeXyzLayerCrs（metadata 反序列化）与 isXyzLayerCrs
// ---------------------------------------------------------------------------

describe('t37 · normalizeXyzLayerCrs round-trip / isXyzLayerCrs', () => {
  it('resolve → JSON 序列化 → normalize 逐字段一致（metadata 往返闭环）', () => {
    const resolved = resolveCrsInput({
      proj4: 'EPSG:4547',
      validBounds: [112.5, 0, 115.5, 84],
      origin: 'top-left',
    });
    assert.strictEqual(resolved.ok, true);
    if (!resolved.ok) return;
    const original = resolved.crs;

    const parsed: unknown = JSON.parse(JSON.stringify(original));
    const normalized = normalizeXyzLayerCrs(parsed);
    assert.strictEqual(normalized.kind, 'proj4');
    assert.strictEqual(normalized.proj4, original.proj4);
    assert.deepStrictEqual(normalized.validBounds, original.validBounds);
    assert.strictEqual(normalized.id, original.id);
    assert.strictEqual(normalized.label, original.label);
    assert.strictEqual(normalized.origin, original.origin);
  });

  it('缺省字段补齐：缺 origin/tileMatrix 的 metadata 可通过（缺省值由网格层填充）', () => {
    const normalized = normalizeXyzLayerCrs({
      kind: 'proj4',
      proj4: TM_105,
      validBounds: [103, 20, 107, 50],
    });
    assert.strictEqual(normalized.proj4, TM_105);
    assert.deepStrictEqual(normalized.validBounds, [103, 20, 107, 50]);
  });

  it('非法 metadata → 可读中文错误', () => {
    assert.throws(() => normalizeXyzLayerCrs('EPSG:4490'), /对象/);
    assert.throws(() => normalizeXyzLayerCrs({ kind: 'other' }), /proj4/);
    assert.throws(() =>
      normalizeXyzLayerCrs({ kind: 'proj4', proj4: '乱码定义', validBounds: [0, 0, 1, 1] }),);
    assert.throws(() =>
      normalizeXyzLayerCrs({ kind: 'proj4', proj4: TM_105, validBounds: [107, 20, 103, 50] }), /有效范围非法/);
  });

  it('isXyzLayerCrs：对象形态才认；字符串 "EPSG:4490"（配准 projection）不认', () => {
    assert.strictEqual(isXyzLayerCrs({ kind: 'proj4', proj4: TM_105, validBounds: [0, 0, 1, 1] }), true);
    assert.strictEqual(isXyzLayerCrs('EPSG:4490'), false);
    assert.strictEqual(isXyzLayerCrs({ kind: 'proj4', proj4: TM_105 }), false);
    assert.strictEqual(isXyzLayerCrs(undefined), false);
    assert.strictEqual(isXyzLayerCrs([1, 2, 3, 4]), false);
  });
});
