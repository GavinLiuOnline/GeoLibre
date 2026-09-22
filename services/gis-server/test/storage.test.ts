/**
 * server · services/storage 单测（t22）
 *
 * 覆盖 `normalizeSceneDocument` 对**顶层 `basemap` 字段**的透传（t19 编辑器底图管理引入）：
 *   1. 完整透传（注册表 items + activeId/id + 各可选字段原样保留）
 *   2. 异常形态容错（null / 数组 / 字符串 / 数字 / 布尔 → 视为缺省，不抛错）
 *   3. 与 metadata.basemap 镜像的一致性（双写、仅顶层、仅镜像三种形态）
 *   4. 真实落盘 round-trip：createScene → getScene / saveScene（移除镜像后仍能保存/加载底图）
 *
 * 运行：pnpm --filter server test  （node:test + tsx，直接跑 TS 源码，无需先构建）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

// DATA_DIR 在 storage 模块加载时读取，必须在 dynamic import 之前设置
const TEST_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
process.env.DATA_DIR = TEST_DATA_DIR;

const storage = await import('../src/services/storage.ts');

after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

/** 一份「编辑器底图管理」导出的完整注册表快照（内置 OSM / 天地图 vec + 自定义） */
const BASEMAP = {
  activeId: 'tianditu-vec',
  id: 'tianditu-vec',
  items: [
    {
      id: 'osm',
      kind: 'preset',
      label: 'OpenStreetMap',
      urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors',
      isBuiltin: true,
      isActive: false,
      maximumLevel: 19,
      visible: true,
    },
    {
      id: 'tianditu-vec',
      kind: 'preset',
      label: '天地图 矢量',
      urlTemplate: 'https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}&tk={token}',
      annotationUrlTemplate: 'https://t{s}.tianditu.gov.cn/DataServer?T=cva_w&x={x}&y={y}&l={z}&tk={token}',
      token: 'tianditu-key-123',
      attribution: '天地图 TDT',
      subdomains: ['0', '1', '2', '3'],
      maximumLevel: 18,
      requiresToken: true,
      isBuiltin: true,
      isActive: true,
      visible: true,
    },
    {
      id: 'custom-1',
      kind: 'custom',
      label: '我的 ArcGIS 底图',
      urlTemplate: 'https://example.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      isBuiltin: false,
      isActive: false,
      visible: true,
    },
  ],
};

function baseScene(extra = {}) {
  return {
    version: 1,
    name: 't22 basemap 透传',
    camera: { lon: 116.39, lat: 39.9, height: 1000, heading: 0, pitch: -45, roll: 0 },
    layers: [],
    ...extra,
  };
}

describe('normalizeSceneDocument · 顶层 basemap 透传（t22）', () => {
  it('完整透传：注册表 items / activeId / id 与全部可选字段原样保留', () => {
    const doc = storage.normalizeSceneDocument(baseScene({ basemap: BASEMAP }));
    assert.deepStrictEqual(doc.basemap, BASEMAP);
    assert.equal(doc.basemap.activeId, 'tianditu-vec');
    assert.equal(doc.basemap.id, 'tianditu-vec');
    assert.equal(doc.basemap.items.length, 3);
    assert.deepStrictEqual(doc.basemap.items.map((i) => i.isActive), [false, true, false]);
    assert.equal(doc.basemap.items[1].token, 'tianditu-key-123');
    assert.equal(doc.basemap.items[1].annotationUrlTemplate?.includes('cva_w'), true);
    assert.deepStrictEqual(doc.basemap.items[1].subdomains, ['0', '1', '2', '3']);
    assert.equal(doc.basemap.items[2].kind, 'custom');
    assert.equal(doc.basemap.items[2].isBuiltin, false);
  });

  it('basemap 缺省 → 字段为 undefined（不产出空对象）', () => {
    const doc = storage.normalizeSceneDocument(baseScene());
    assert.equal(doc.basemap, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(doc, 'basemap'), true);
  });

  it('异常形态容错：null / 数组 / 字符串 / 数字 / 布尔 → undefined，不抛错', () => {
    for (const bad of [null, [], ['osm'], 'osm', 42, true, false]) {
      const doc = storage.normalizeSceneDocument(baseScene({ basemap: bad }));
      assert.equal(doc.basemap, undefined, `basemap=${JSON.stringify(bad)} 应被忽略`);
    }
  });

  it('空对象与未知扩展键原样保留（服务端不做深校验，与 metadata 同款语义）', () => {
    const doc = storage.normalizeSceneDocument(baseScene({ basemap: {} }));
    assert.deepStrictEqual(doc.basemap, {});

    const weird = { activeId: 'x', items: 'not-an-array', extra: { future: true } };
    const doc2 = storage.normalizeSceneDocument(baseScene({ basemap: weird }));
    assert.deepStrictEqual(doc2.basemap, weird);
  });

  it('不污染图层与其它字段：basemap 只出现在顶层', () => {
    const doc = storage.normalizeSceneDocument(
      baseScene({
        basemap: BASEMAP,
        layers: [{ id: 'l1', name: '面', type: 'geojson', source: { kind: 'inline' } }],
      }),
    );
    assert.equal(doc.layers.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(doc.layers[0], 'basemap'), false);
    assert.equal(doc.name, 't22 basemap 透传');
    assert.deepStrictEqual(doc.camera, { lon: 116.39, lat: 39.9, height: 1000, heading: 0, pitch: -45, roll: 0 });
  });
});

describe('metadata.basemap 镜像一致性（t19 临时方案 ↔ t22 正式字段）', () => {
  it('双写：顶层 basemap 与 metadata.basemap 同时保留且内容一致', () => {
    const doc = storage.normalizeSceneDocument(baseScene({ basemap: BASEMAP, metadata: { basemap: BASEMAP, author: 'editor' } }));
    assert.deepStrictEqual(doc.basemap, BASEMAP);
    assert.deepStrictEqual(doc.metadata?.basemap, BASEMAP);
    assert.deepStrictEqual(doc.metadata?.basemap, doc.basemap);
    assert.equal(doc.metadata?.author, 'editor');
  });

  it('仅顶层（移除镜像）→ 正常保存/加载，底图完整还原', () => {
    const created = storage.createScene(baseScene({ basemap: BASEMAP }));
    const loaded = storage.getScene(created.id);
    assert.deepStrictEqual(loaded.basemap, BASEMAP);
    assert.equal(loaded.metadata, undefined);

    // 落盘文件里确实带顶层 basemap（而不是被白名单丢弃）
    const file = path.join(TEST_DATA_DIR, 'scenes', `${created.id}.json`);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(onDisk.basemap, BASEMAP);

    storage.deleteScene(created.id);
  });

  it('仅镜像（旧写法，向后兼容）→ metadata.basemap 保留，顶层缺省', () => {
    const doc = storage.normalizeSceneDocument(baseScene({ metadata: { basemap: BASEMAP } }));
    assert.equal(doc.basemap, undefined);
    assert.deepStrictEqual(doc.metadata?.basemap, BASEMAP);

    const created = storage.createScene(baseScene({ metadata: { basemap: BASEMAP } }));
    const loaded = storage.getScene(created.id);
    assert.equal(loaded.basemap, undefined);
    assert.deepStrictEqual(loaded.metadata?.basemap, BASEMAP);
    storage.deleteScene(created.id);
  });

  it('saveScene 覆盖更新激活底图 → 读取反映新 activeId（顶层字段）', () => {
    const created = storage.createScene(baseScene({ basemap: BASEMAP }));
    const next = {
      ...BASEMAP,
      activeId: 'custom-1',
      id: 'custom-1',
      items: BASEMAP.items.map((i) => ({ ...i, isActive: i.id === 'custom-1' })),
    };
    const saved = storage.saveScene(created.id, baseScene({ basemap: next }));
    assert.equal(saved.basemap?.activeId, 'custom-1');
    const loaded = storage.getScene(created.id);
    assert.equal(loaded.basemap?.activeId, 'custom-1');
    assert.deepStrictEqual(loaded.basemap?.items.map((i) => i.isActive), [false, false, true]);
    storage.deleteScene(created.id);
  });
});
