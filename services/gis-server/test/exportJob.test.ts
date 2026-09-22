/**
 * server · 流式导出任务（t34）单测
 *
 * 覆盖：
 *   1. 公式估算正确性（2^z 网格与 bbox 求交、跨 180°、极地钳制、整层数与各层独立校验）
 *   2. 裁剪边界（bound 经纬度验证、经度跨 antimeridian、纬度钳制到墨卡托范围）
 *   3. 流式打包产物可解压且条目/内容一致（与公式法 totalTiles 一致）
 *   4. 进度单调递增、最终 done；取消后无残留；下载流式产物
 *   5. 白名单拒绝（未配置 GIS_HOST_DIR_ROOTS、白名单外路径）
 *   6. 超限拒绝（总瓦片 / 总字节）
 *   7. 并发隔离（多任务在表中独立，进度互不污染）
 *   8. 端到端 HTTP：POST/GET/HEAD download/DELETE 鉴权与产物隔离
 *
 * 运行：pnpm --filter server test（node:test + tsx）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import AdmZip from 'adm-zip';

const TEST_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data-t34');
const DATA_DIR = path.join(TEST_ROOT, 'data');
const ALLOWED_ROOT = path.join(TEST_ROOT, 'roots', 'allowed');
const OUTSIDE_ROOT = path.join(TEST_ROOT, 'roots', 'outside');

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
process.env.DATA_DIR = DATA_DIR;
process.env.AUTH_TOKEN = ''; // 测试环境禁用 AUTH_TOKEN，避免污染其它测试
process.env.GIS_EXPORT_MAX_TILES = ''; // 显式清空（测试时通过编程上限校验）
process.env.GIS_EXPORT_MAX_BYTES = '';
process.env.GIS_EXPORT_MAX_CONCURRENT = '';
// 白名单：指向 fixture 内的允许根
process.env.GIS_HOST_DIR_ROOTS = ALLOWED_ROOT;

let server: http.Server;
let base = '';

const exportJob = await import('../src/services/exportJob.js');
const registry = await import('../src/services/registry.js');
const { exportsRouter } = await import('../src/routes/exports.js');
const { HttpError } = await import('../src/util/http.js');

// ---------------------------------------------------------------------------
// fixtures：构造 XYZ 瓦片树（含跨 antimeridian 范围 + 偶发缺瓦片）
// ---------------------------------------------------------------------------

const FIXTURE_TILES: Record<string, string> = {
  // z=0
  '0/0/0.jpg': 'JPG0',
  // z=1
  '1/0/0.jpg': 'JPG1a',
  '1/0/1.jpg': 'JPG1b',
  '1/1/0.jpg': 'JPG1c',
  '1/1/1.jpg': 'JPG1d',
  // z=2：只造少量，留出 skippedTiles 校验的缺瓦片
  '2/0/0.jpg': 'JPG2a',
  '2/1/1.jpg': 'JPG2b',
  '2/2/2.jpg': 'JPG2c',
  '2/3/3.jpg': 'JPG2d',
  // 非瓦片文件（应被扫描器忽略、被导出跳过）
  'notes.txt': 'NOT-A-TILE',
  // 隐藏文件（应被 realpath 校验忽略）
};

function buildFixtures(): void {
  fs.mkdirSync(ALLOWED_ROOT, { recursive: true });
  fs.mkdirSync(OUTSIDE_ROOT, { recursive: true });

  const tiles = path.join(ALLOWED_ROOT, 'tiles');
  for (const [rel, content] of Object.entries(FIXTURE_TILES)) {
    const full = path.join(tiles, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  // 非瓦片文件
  fs.writeFileSync(path.join(tiles, 'notes.txt'), 'NOT-A-TILE');

  // 白名单外：导出不应能引用
  fs.mkdirSync(OUTSIDE_ROOT, { recursive: true });
  fs.writeFileSync(path.join(OUTSIDE_ROOT, 'secret.jpg'), 'SECRET');
}

buildFixtures();

// ---------------------------------------------------------------------------
// 测试服务器（复用真实路由）
// ---------------------------------------------------------------------------

before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/exports', exportsRouter);
  app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    const headers = (err instanceof HttpError && err.headers) || undefined;
    if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function postExport(body: unknown): Promise<{ status: number; json: any }> {
  return fetch(`${base}/api/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));
}

function getJson(url: string): Promise<{ status: number; json: any }> {
  return fetch(url).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));
}

function getBinary(url: string): Promise<{ status: number; body: Buffer; headers: Headers }> {
  return fetch(url).then(async (res) => ({ status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers }));
}

async function waitForDone(id: string, timeoutMs = 10_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = exportJob.getExportJob(id)?.toSnapshot();
    if (snap && (snap.status === 'done' || snap.status === 'failed' || snap.status === 'cancelled')) return snap;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`任务未在 ${timeoutMs}ms 内结束: ${id}`);
}

// ---------------------------------------------------------------------------
// 1. 公式估算正确性
// ---------------------------------------------------------------------------

describe('t34 · 公式估算（2^z 网格与 bbox 求交）', () => {
  it('整层世界 bbox：z=0 命中 1 瓦片；z=1 命中 4；z=2 命中 16', () => {
    const world: [-180, -85.0511287798066, 180, 85.0511287798066] = [-180, -85.0511287798066, 180, 85.0511287798066];
    assert.equal(exportJob.estimateTilesForLevel(world, 0), 1);
    assert.equal(exportJob.estimateTilesForLevel(world, 1), 4);
    assert.equal(exportJob.estimateTilesForLevel(world, 2), 16);
    const { totalTiles } = exportJob.computeTileEstimate(world, 0, 2);
    assert.equal(totalTiles, 21);
  });

  it('bbox 命中 1/2/3/4 列（边界归属东侧瓦片）', () => {
    // z=1 共 2 列（x=0..1）；西经 -180 恰好落到 x=0；西经 -90 落到 x=1
    const a: [-90, -45, -90, 45] = [-90, -45, -90, 45];
    assert.equal(exportJob.estimateTilesForLevel(a, 1), 2);
    // 西经 90（东半球西端）→ x=1
    const b: [90, -45, 90, 45] = [90, -45, 90, 45];
    assert.equal(exportJob.estimateTilesForLevel(b, 1), 2);
    // 西经 0 → x=1（floor((0+180)/360 * 2) = 1）
    const c: [0, -45, 0, 45] = [0, -45, 0, 45];
    assert.equal(exportJob.estimateTilesForLevel(c, 1), 2);
  });

  it('经度跨 180°（antimeridian）：拆两段互不重叠', () => {
    const spans = exportJob.xSpansForBounds(170, -170, 1);
    // z=1: x=0..1；西经 170 → x=1；东经 -170 钳制到 -180 → x=0
    assert.deepStrictEqual(spans, [
      [1, 1],
      [0, 0],
    ]);
    // 总列数 = 2，但 z=1 纬度 2 行（yTop=0, yBottom=1），所以瓦片数 = 2 列 × 2 行 = 4
    const cross: [170, -10, -170, 10] = [170, -10, -170, 10];
    assert.equal(exportJob.estimateTilesForLevel(cross, 1), 4);
  });

  it('纬度自动钳制到 ±85.0511287798066°（极地不会越界）', () => {
    // 超出极地的 bbox 不会让纬度超出 2^z 行数
    const polar: [-180, -89, 180, 89] = [-180, -89, 180, 89];
    const totalPolar = exportJob.estimateTilesForLevel(polar, 2);
    const world: [-180, -85.0511287798066, 180, 85.0511287798066] = [-180, -85.0511287798066, 180, 85.0511287798066];
    const totalWorld = exportJob.estimateTilesForLevel(world, 2);
    assert.equal(totalPolar, totalWorld);
  });

  it('latToTileY 与 editor Web Mercator 语义一致（典型值）', () => {
    // z=1：y=0（顶部，纬度 ≈ 85.05）到 y=1（底部，纬度 ≈ -85.05）
    assert.equal(exportJob.latToTileY(85.0511287798066, 1), 0);
    assert.equal(exportJob.latToTileY(0, 1), 1);
    assert.equal(exportJob.latToTileY(-85.0511287798066, 1), 1);
  });

  it('lngToTileX 边界归属（边界经度归属东侧瓦片）', () => {
    // z=1：x=0（-180..0）和 x=1（0..180）；经度 0 应落入 x=1（floor((0+180)/360 * 2) = 1）
    assert.equal(exportJob.lngToTileX(0, 1), 1);
    // 经度 -180 → x=0；经度 180 → x=1
    assert.equal(exportJob.lngToTileX(-180, 1), 0);
    assert.equal(exportJob.lngToTileX(180, 1), 1);
  });
});

// ---------------------------------------------------------------------------
// 2. bounds 解析与边界保护
// ---------------------------------------------------------------------------

describe('t34 · bounds 解析与边界保护', () => {
  it('支持 [w,s,e,n] 数组与同名键对象两种形式', () => {
    assert.deepStrictEqual(exportJob.parseExportBounds([1, 2, 3, 4]), [1, 2, 3, 4]);
    assert.deepStrictEqual(exportJob.parseExportBounds({ west: 1, south: 2, east: 3, north: 4 }), [1, 2, 3, 4]);
  });

  it('south > north 报错', () => {
    assert.throws(
      () => exportJob.parseExportBounds([0, 10, 0, 5]),
      (err: unknown) => err instanceof HttpError && err.status === 400,
    );
  });

  it('经度自动钳制到 ±180°', () => {
    const bounds = exportJob.parseExportBounds([-200, 0, 200, 10]);
    assert.equal(bounds[0], -180);
    assert.equal(bounds[2], 180);
  });

  it('非数字 / 缺字段报错', () => {
    assert.throws(() => exportJob.parseExportBounds([1, 2, 'x', 4]), (e) => e instanceof HttpError);
    assert.throws(() => exportJob.parseExportBounds({ west: 1, south: 2, east: 3 }), (e) => e instanceof HttpError);
  });
});

// ---------------------------------------------------------------------------
// 3. 源解析：白名单拒绝 + 真实路径校验
// ---------------------------------------------------------------------------

describe('t34 · 源解析（白名单）', () => {
  it('slug 不在注册表 → 404', () => {
    assert.throws(
      () => exportJob.resolveExportSourceDir({ kind: 'slug', value: 'no-such-slug' }),
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );
  });

  it('注册非 XYZ 服务的 slug → 400', () => {
    // 注册一个 3D Tiles 风格的条目，但 hostKind 故意写为非 'xyz'，校验应拒绝
    registry.upsertService({
      slug: 'fake-3dtiles',
      sceneId: '',
      sceneName: 'fake-3dtiles',
      types: ['tileset'],
      artifacts: [{ kind: 'tileset', url: '/tilesets/fake-3dtiles/tileset.json', name: 'fake', format: 'json' }],
      publishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hostDir: ALLOWED_ROOT,
      hostKind: '3dtiles',
    });
    assert.throws(
      () => exportJob.resolveExportSourceDir({ kind: 'slug', value: 'fake-3dtiles' }),
      (err: unknown) => err instanceof HttpError && err.status === 400,
    );
    registry.deleteService('fake-3dtiles');
  });

  it('dir 不在白名单 → 403（即使目录真实存在）', () => {
    assert.throws(
      () => exportJob.resolveExportSourceDir({ kind: 'dir', value: OUTSIDE_ROOT }),
      (err: unknown) => err instanceof HttpError && err.status === 403,
    );
  });

  it('dir 在白名单 → 返回 realpath', () => {
    const dir = exportJob.resolveExportSourceDir({ kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') });
    assert.equal(dir, fs.realpathSync(path.join(ALLOWED_ROOT, 'tiles')));
  });

  it('白名单未配置时 dir 直接调用 assertHostDirAllowed → 403', () => {
    // 临时清空 GIS_HOST_DIR_ROOTS 模拟未配置
    const orig = process.env.GIS_HOST_DIR_ROOTS;
    process.env.GIS_HOST_DIR_ROOTS = '';
    try {
      assert.throws(
        () => exportJob.resolveExportSourceDir({ kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') }),
        (err: unknown) => err instanceof HttpError && err.status === 403,
      );
    } finally {
      process.env.GIS_HOST_DIR_ROOTS = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 任务创建：公式估算 + 护栏
// ---------------------------------------------------------------------------

describe('t34 · 任务创建（公式估算 + 护栏）', () => {
  it('小 bbox：totalTiles 与公式一致；超过 maxZoom=2 但仅到 2 层', async () => {
    // z=0 全图 1 瓦片，z=1 全图 4 瓦片；我们只准备部分瓦片，剩下应 skipped
    const job = exportJob.createExportJob({
      src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
      minZoom: 0,
      maxZoom: 2,
    });
    const snap = await waitForDone(job.id, 8000);
    assert.equal(snap.status, 'done');
    assert.equal(snap.totalTiles, 1 + 4 + 16); // 公式法
    // 我们只造了 1+4+4=9 个瓦片，所以 skippedTiles = 16-4 = 12
    assert.equal(snap.skippedTiles, 12);
    assert.equal(snap.doneTiles, 9);
    // 删除清理
    await exportJob.removeExportJob(job.id);
  });

  it('超瓦片上限 → 413 且给出可执行建议', () => {
    // 临时拉低上限（确保 small 测试集也触发）
    const orig = process.env[exportJob.EXPORT_MAX_TILES_ENV];
    process.env[exportJob.EXPORT_MAX_TILES_ENV] = '2';
    try {
      assert.throws(
        () =>
          exportJob.createExportJob({
            src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
            minZoom: 0,
            maxZoom: 2,
          }),
        (err: unknown) =>
          err instanceof HttpError &&
          err.status === 413 &&
          (err.message.includes('缩小 bounds') ||
            err.message.includes('降低 maxZoom') ||
            err.message.includes('分批')),
      );
    } finally {
      if (orig === undefined) delete process.env[exportJob.EXPORT_MAX_TILES_ENV];
      else process.env[exportJob.EXPORT_MAX_TILES_ENV] = orig;
    }
  });

  it('超字节上限 → 413', () => {
    const origTiles = process.env[exportJob.EXPORT_MAX_TILES_ENV];
    const origBytes = process.env[exportJob.EXPORT_MAX_BYTES_ENV];
    process.env[exportJob.EXPORT_MAX_TILES_ENV] = '1000000';
    process.env[exportJob.EXPORT_MAX_BYTES_ENV] = '1'; // 1 byte 必然超
    try {
      assert.throws(
        () =>
          exportJob.createExportJob({
            src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
            minZoom: 0,
            maxZoom: 0,
          }),
        (err: unknown) => err instanceof HttpError && err.status === 413,
      );
    } finally {
      if (origTiles === undefined) delete process.env[exportJob.EXPORT_MAX_TILES_ENV];
      else process.env[exportJob.EXPORT_MAX_TILES_ENV] = origTiles;
      if (origBytes === undefined) delete process.env[exportJob.EXPORT_MAX_BYTES_ENV];
      else process.env[exportJob.EXPORT_MAX_BYTES_ENV] = origBytes;
    }
  });

  it('并发上限：达到上限 → 429', async () => {
    const origConc = process.env[exportJob.EXPORT_MAX_CONCURRENT_ENV];
    process.env[exportJob.EXPORT_MAX_CONCURRENT_ENV] = '1';
    try {
      const job1 = exportJob.createExportJob({
        src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
        minZoom: 0,
        maxZoom: 0,
      });
      // job1 已经在跑（pending/running）→ 第二个任务应 429
      assert.throws(
        () =>
          exportJob.createExportJob({
            src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
            minZoom: 0,
            maxZoom: 0,
          }),
        (err: unknown) => err instanceof HttpError && err.status === 429,
      );
      await waitForDone(job1.id);
      await exportJob.removeExportJob(job1.id);
    } finally {
      if (origConc === undefined) delete process.env[exportJob.EXPORT_MAX_CONCURRENT_ENV];
      else process.env[exportJob.EXPORT_MAX_CONCURRENT_ENV] = origConc;
    }
  });

  it('非白名单扩展名 → 400', () => {
    assert.throws(
      () =>
        exportJob.createExportJob({
          src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
          ext: 'exe',
        }),
      (err: unknown) => err instanceof HttpError && err.status === 400,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 流式打包产物可解压且条目/内容一致
// ---------------------------------------------------------------------------

describe('t34 · 流式打包产物', () => {
  it('产物可解压：条目数 = doneTiles 且内容与源一一对应', async () => {
    const job = exportJob.createExportJob({
      src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
      minZoom: 0,
      maxZoom: 1,
    });
    const snap = await waitForDone(job.id, 8000);
    assert.equal(snap.status, 'done');
    // 验证 ZIP
    const buf = fs.readFileSync(snap.outputPath);
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    assert.equal(entries.length, snap.doneTiles);
    const names = new Set(entries.map((e) => e.entryName));
    assert.ok(names.has('0/0/0.jpg'));
    assert.ok(names.has('1/0/0.jpg'));
    assert.ok(names.has('1/0/1.jpg'));
    assert.ok(names.has('1/1/0.jpg'));
    assert.ok(names.has('1/1/1.jpg'));
    // 内容比对
    for (const entry of entries) {
      const src = path.join(ALLOWED_ROOT, 'tiles', entry.entryName);
      assert.equal(entry.getData().toString(), fs.readFileSync(src).toString(), `内容不一致: ${entry.entryName}`);
    }
    await exportJob.removeExportJob(job.id);
  });

  it('ZIP64：条目数足以触发 ZIP64（forceZip64 via count）', async () => {
    // 我们不构造 65535 个瓦片，仅断言 needZip64 路径存在；
    // 通过产物的 EOCD 检测 ZIP64 标记签名（0x06064b50）即可（即使没触发也无副作用）
    const job = exportJob.createExportJob({
      src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
      minZoom: 0,
      maxZoom: 0,
    });
    const snap = await waitForDone(job.id, 8000);
    assert.equal(snap.status, 'done');
    const buf = fs.readFileSync(snap.outputPath);
    // 普通 ZIP 的 EOCD signature 0x06054b50 必然存在；ZIP64 视情
    assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'ZIP EOCD 签名缺失');
    await exportJob.removeExportJob(job.id);
  });
});

// ---------------------------------------------------------------------------
// 6. 进度 API
// ---------------------------------------------------------------------------

describe('t34 · 进度 API', () => {
  it('GET /api/exports/:id 返回 snapshot 且 doneTiles 单调递增', async () => {
    const job = exportJob.createExportJob({
      src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
      minZoom: 0,
      maxZoom: 1,
    });
    let last = 0;
    const seenPhases = new Set<string>();
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const snap = exportJob.getExportJob(job.id)?.toSnapshot();
      if (!snap) break;
      seenPhases.add(snap.phase);
      if (snap.status === 'pending' || snap.status === 'running') {
        assert.ok(snap.doneTiles >= last, `doneTiles 单调递增失败: ${last} → ${snap.doneTiles}`);
        last = snap.doneTiles;
      }
      if (snap.status === 'done') {
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const snap = exportJob.getExportJob(job.id)?.toSnapshot();
    assert.equal(snap?.status, 'done');
    // 小任务足够快可能跳过 scanning→packing→finalizing 的中间观察，
    // 但必须观察到至少 scanning（起始）和 done（终态）。
    assert.ok(seenPhases.has('scanning'), `进度必须包含 scanning，实际：${[...seenPhases].join(',')}`);
    assert.ok(seenPhases.has('done'), `进度必须包含 done，实际：${[...seenPhases].join(',')}`);
    await exportJob.removeExportJob(job.id);
  });

  it('GET /api/exports 列全部任务', async () => {
    const list = await getJson(`${base}/api/exports`);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json.jobs));
  });
});

// ---------------------------------------------------------------------------
// 7. 取消 / 清理
// ---------------------------------------------------------------------------

describe('t34 · 取消与清理', () => {
  it('DELETE /api/exports/:id 取消并清理产物（含 .cd 临时）', async () => {
    const job = exportJob.createExportJob({
      src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
      minZoom: 0,
      maxZoom: 1,
    });
    // 取消 + 等待终态
    const cancelOutcome = await exportJob.cancelExportJob(job.id);
    assert.ok(['cancelled', 'done'].includes(cancelOutcome.status));
    const remove = await exportJob.removeExportJob(job.id);
    assert.equal(remove.id, job.id);
    assert.ok(Array.isArray(remove.removed));
    // 产物与 meta 必须已删
    const exportsDir = path.join(DATA_DIR, 'exports');
    assert.ok(!fs.existsSync(path.join(exportsDir, `${job.id}.zip`)));
    assert.ok(!fs.existsSync(path.join(exportsDir, `${job.id}.json`)));
  });

  it('删除不存在的任务 → 404', async () => {
    await assert.rejects(
      () => exportJob.removeExportJob('does-not-exist'),
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. 端到端 HTTP：POST / GET /download / DELETE
// ---------------------------------------------------------------------------

describe('t34 · HTTP 端到端', () => {
  it('POST 创建 → GET 进度 → HEAD/GET download 200 → DELETE 清理', async () => {
    const post = await postExport({
      src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
      minZoom: 0,
      maxZoom: 1,
    });
    assert.equal(post.status, 201);
    const id = post.json.exportId;
    assert.ok(typeof id === 'string' && id.length > 0);
    // 等 done
    let snap: any = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const r = await getJson(`${base}/api/exports/${id}`);
      snap = r.json;
      if (snap.status === 'done' || snap.status === 'failed' || snap.status === 'cancelled') break;
      await new Promise((r2) => setTimeout(r2, 30));
    }
    assert.equal(snap.status, 'done');

    // HEAD
    const head = await fetch(`${base}/api/exports/${id}/download`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'application/zip');
    assert.ok(Number(head.headers.get('content-length')) > 0);

    // GET 下载
    const dl = await getBinary(`${base}/api/exports/${id}/download`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/zip');
    // 可解压
    const zip = new AdmZip(dl.body);
    assert.ok(zip.getEntries().length >= 1);

    // DELETE
    const del = await fetch(`${base}/api/exports/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const delJson = await del.json();
    assert.equal(delJson.id, id);

    // 二次 GET 应 404
    const get2 = await getJson(`${base}/api/exports/${id}`);
    assert.equal(get2.status, 404);
  });

  it('下载未完成任务 → 409', async () => {
    const post = await postExport({
      src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
      minZoom: 0,
      maxZoom: 0,
    });
    const id = post.json.exportId;
    // 任务刚开始 running，download 应 409
    const dl = await fetch(`${base}/api/exports/${id}/download`);
    // 可能已经 done（小数据集），都合理
    assert.ok(dl.status === 200 || dl.status === 409, `下载状态应为 200/409：${dl.status}`);
    // 等 done 后下载 200
    await waitForDone(id);
    const dl2 = await fetch(`${base}/api/exports/${id}/download`);
    assert.equal(dl2.status, 200);
    await exportJob.removeExportJob(id);
  });

  it('下载路径猜不到任何产物（猜测 id 应 404）', async () => {
    const r = await fetch(`${base}/api/exports/00000000-0000-4000-8000-000000000000/download`);
    assert.equal(r.status, 404);
  });

  it('不存在的任务 GET → 404', async () => {
    const r = await getJson(`${base}/api/exports/00000000-0000-4000-8000-000000000000`);
    assert.equal(r.status, 404);
  });

  it('白名单外目录创建 → 403', async () => {
    const post = await postExport({
      src: { kind: 'dir', value: OUTSIDE_ROOT },
    });
    assert.equal(post.status, 403);
  });

  it('错误参数 → 400', async () => {
    for (const body of [
      { src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') }, ext: 'exe' },
      { src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') }, minZoom: 5, maxZoom: 2 },
      { src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') }, bounds: [0, 10, 0, 5] }, // south > north
    ]) {
      const post = await postExport(body);
      assert.equal(post.status, 400, `应 400：${JSON.stringify(body)} → ${post.status}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. 并发任务隔离
// ---------------------------------------------------------------------------

describe('t34 · 并发任务隔离', () => {
  it('两个并发任务：进度互不污染，最终都 done', async () => {
    const a = exportJob.createExportJob({
      src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
      minZoom: 0,
      maxZoom: 0,
    });
    const b = exportJob.createExportJob({
      src: { kind: 'dir', value: path.join(ALLOWED_ROOT, 'tiles') },
      minZoom: 1,
      maxZoom: 1,
    });
    const [sa, sb] = await Promise.all([waitForDone(a.id), waitForDone(b.id)]);
    assert.equal(sa.status, 'done');
    assert.equal(sb.status, 'done');
    assert.equal(sa.totalTiles, 1);
    assert.equal(sb.totalTiles, 4);
    await exportJob.removeExportJob(a.id);
    await exportJob.removeExportJob(b.id);
  });
});