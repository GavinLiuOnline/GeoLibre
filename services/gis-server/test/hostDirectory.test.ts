/**
 * server · 目录托管（t26）单测
 *
 * 覆盖：
 *   1. 轻量扫描：XYZ 层级/每层计数/扩展名抽样；上界生效（与文件数量级无关）；
 *      3D Tiles 只读 tileset.json 元信息
 *   2. POST /api/services/host-directory：白名单未配置 403 + 指引、白名单外 403、
 *      软链逃逸 403、成功注册（含 slug 覆盖）、GET /api/services 可见
 *   3. 托管路由：/tiles/<slug>/...、/tilesets/<slug>/... 200/404、Content-Type、
 *      Cache-Control、HEAD、扩展名过滤 403、目录穿越（含 %2F 绕过）403、软链文件 403
 *   4. DELETE /api/services/:slug：注销托管服务且**不动源目录任何文件**
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

const TEST_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data-t26');
const DATA_DIR = path.join(TEST_ROOT, 'data');
const ALLOWED_ROOT = path.join(TEST_ROOT, 'roots', 'allowed');
const OUTSIDE_ROOT = path.join(TEST_ROOT, 'roots', 'outside');

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
process.env.DATA_DIR = DATA_DIR;
delete process.env.AUTH_TOKEN;
delete process.env.GIS_HOST_DIR_ROOTS;

// fixture：XYZ 瓦片树（0/1/2 层 + 多扩展名）+ 3D Tiles 数据集 + 越界软链目标
function writeFixture(): void {
  const tiles = path.join(ALLOWED_ROOT, 'tiles');
  const files: Array<[string, string]> = [
    ['0/0/0.jpg', 'jpg0'],
    ['1/0/0.jpg', 'jpg1a'],
    ['1/0/1.jpg', 'jpg1b'],
    ['1/1/0.jpg', 'jpg1c'],
    ['2/3/2.png', 'png2'],
    ['2/3/3.png', 'png2b'],
    ['2/4/4.webp', 'webp2'],
    ['notes.txt', 'not-a-tile'], // 非白名单扩展名
    ['tiles.exe', 'nope'], // 非白名单扩展名
  ];
  for (const [rel, content] of files) {
    const full = path.join(tiles, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  // 3D Tiles 数据集（tileset.json + b3dm + 非白名单文件）
  const ds = path.join(ALLOWED_ROOT, 'dataset');
  fs.mkdirSync(path.join(ds, 'tiles'), { recursive: true });
  fs.writeFileSync(
    path.join(ds, 'tileset.json'),
    JSON.stringify({ asset: { version: '1.1' }, geometricError: 500, root: { geometricError: 0, content: { uri: 'tiles/tile.b3dm' } } }),
  );
  fs.writeFileSync(path.join(ds, 'tiles', 'tile.b3dm'), 'b3dm');
  fs.writeFileSync(path.join(ds, 'readme.md'), 'no'); // 非白名单

  // 越界目标（白名单之外）
  fs.mkdirSync(OUTSIDE_ROOT, { recursive: true });
  fs.writeFileSync(path.join(OUTSIDE_ROOT, 'secret.jpg'), 'secret');

  // 软链 1：允许根内的目录软链 → 指向白名单外（注册时应被 realpath 拦下）
  fs.symlinkSync(OUTSIDE_ROOT, path.join(ALLOWED_ROOT, 'escape-dir'));
  // 软链 2：托管目录内的文件软链 → 指向白名单外（请求时应被 realpath 拦下）
  fs.symlinkSync(path.join(OUTSIDE_ROOT, 'secret.jpg'), path.join(tiles, '1', 'escape.jpg'));
}

writeFixture();

const hostDirectory = await import('../src/services/hostDirectory.ts');
const registry = await import('../src/services/registry.js');
const { servicesRouter } = await import('../src/routes/services.js');
const { createHostedFilesHandler } = await import('../src/routes/hostedFiles.js');
const { HttpError } = await import('../src/util/http.js');

// ---------------------------------------------------------------------------
// 测试服务器（复用真实路由与托管处理器）
// ---------------------------------------------------------------------------
let server: http.Server;
let base = '';

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/services', servicesRouter);
  app.use('/tiles', createHostedFilesHandler('xyz'));
  app.use('/tilesets', createHostedFilesHandler('3dtiles'));
  app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
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

async function postHost(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/services/host-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// 1. 轻量扫描
// ---------------------------------------------------------------------------
describe('t26 · 轻量扫描（不读瓦片内容、开销有界）', () => {
  it('XYZ：枚举顶层层级 + 每层计数 + 抽样扩展名', () => {
    const scan = hostDirectory.scanXyzDirectory(path.join(ALLOWED_ROOT, 'tiles'));
    assert.deepStrictEqual(scan.levels, [0, 1, 2]);
    assert.deepStrictEqual(scan.tileCounts, { '0': 1, '1': 3, '2': 3 }); // escape.jpg 是软链，不计入
    assert.equal(scan.totalTiles, 7);
    assert.deepStrictEqual(scan.extensions, ['jpg', 'png', 'webp']);
    assert.equal(scan.primaryExt, 'jpg');
    assert.equal(scan.contentRead, false);
    assert.equal(scan.truncated, false);
    assert.ok(scan.scannedEntries <= 32, `扫描条目数应有界: ${scan.scannedEntries}`);
  });

  it('XYZ：计数上界生效（模拟 240 万文件量级只需有界时间）', () => {
    const scan = hostDirectory.scanXyzDirectory(path.join(ALLOWED_ROOT, 'tiles'), {
      maxTilesPerLevel: 2,
      maxTotalEntries: 4,
    });
    assert.equal(scan.truncated, true);
    assert.ok(scan.scannedEntries <= 4, `扫描条目数应受上限约束: ${scan.scannedEntries}`);
    assert.deepStrictEqual(scan.levels, [0, 1, 2]);
    assert.ok(scan.totalTiles <= 4);
  });

  it('XYZ：非瓦片树结构 → 400', () => {
    assert.throws(
      () => hostDirectory.scanXyzDirectory(OUTSIDE_ROOT),
      (err: unknown) => err instanceof HttpError && err.status === 400,
    );
  });

  it('3D Tiles：只读 tileset.json 元信息 + 有界统计扩展名', () => {
    const scan = hostDirectory.scan3dTilesDirectory(path.join(ALLOWED_ROOT, 'dataset'));
    assert.equal(scan.tilesetPath, 'tileset.json');
    assert.equal(scan.datasetRoot, '');
    assert.equal(scan.assetVersion, '1.1');
    assert.equal(scan.geometricError, 500);
    assert.deepStrictEqual(scan.extensions, ['b3dm', 'json']); // readme.md 被扩展名过滤
    assert.equal(scan.truncated, false);
  });

  it('扩展名白名单：只允许瓦片/模型/清单类', () => {
    const root = path.join(ALLOWED_ROOT, 'tiles');
    assert.ok(hostDirectory.resolveHostedFile(root, '0/0/0.jpg', hostDirectory.XYZ_TILE_EXTENSIONS));
    for (const bad of ['notes.txt', 'tiles.exe', '0/0/0.JPG.exe', 'noext']) {
      assert.throws(
        () => hostDirectory.resolveHostedFile(root, bad, hostDirectory.XYZ_TILE_EXTENSIONS),
        (err: unknown) => err instanceof HttpError && (err.status === 403 || err.status === 404),
        `${bad} 应被拒绝`,
      );
    }
    // 目录穿越 / 绝对路径 / 反斜杠 / NUL
    for (const bad of ['../outside/secret.jpg', '/etc/passwd', 'a\\b.jpg', 'x/../../y.jpg', 'a\0.jpg']) {
      assert.throws(
        () => hostDirectory.resolveHostedFile(root, bad, hostDirectory.XYZ_TILE_EXTENSIONS),
        (err: unknown) => err instanceof HttpError && err.status === 403,
        `${bad} 应被拒绝`,
      );
    }
    // 托管目录内的软链指向白名单外 → 403
    assert.throws(
      () => hostDirectory.resolveHostedFile(root, '1/escape.jpg', hostDirectory.XYZ_TILE_EXTENSIONS),
      (err: unknown) => err instanceof HttpError && err.status === 403,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. 注册接口与安全默认
// ---------------------------------------------------------------------------
describe('t26 · POST /api/services/host-directory（安全默认 + 注册）', () => {
  it('未配置白名单根 → 403 且给出开启指引', async () => {
    delete process.env.GIS_HOST_DIR_ROOTS;
    const { status, json } = await postHost({ dir: path.join(ALLOWED_ROOT, 'tiles'), kind: 'xyz' });
    assert.equal(status, 403);
    assert.match(json.error, /GIS_HOST_DIR_ROOTS/);
    assert.match(json.error, /未启用/);
  });

  it('白名单外的目录 → 403', async () => {
    process.env.GIS_HOST_DIR_ROOTS = ALLOWED_ROOT;
    const { status, json } = await postHost({ dir: OUTSIDE_ROOT, kind: 'xyz' });
    assert.equal(status, 403);
    assert.match(json.error, /不在允许根内/);
  });

  it('软链逃逸（允许根内的软链指向根外）→ 403', async () => {
    process.env.GIS_HOST_DIR_ROOTS = ALLOWED_ROOT;
    const { status, json } = await postHost({ dir: path.join(ALLOWED_ROOT, 'escape-dir'), kind: 'xyz' });
    assert.equal(status, 403);
    assert.match(json.error, /不在允许根内/);
  });

  it('目录不存在 → 404；kind 非法 → 400', async () => {
    process.env.GIS_HOST_DIR_ROOTS = ALLOWED_ROOT;
    const missing = await postHost({ dir: path.join(ALLOWED_ROOT, 'nope'), kind: 'xyz' });
    assert.equal(missing.status, 404);
    const badKind = await postHost({ dir: path.join(ALLOWED_ROOT, 'tiles'), kind: 'wmts' });
    assert.equal(badKind.status, 400);
  });

  it('XYZ 注册成功：返回 /tiles/<slug>/{z}/{x}/{y}.<ext> 且 GET /api/services 可见', async () => {
    process.env.GIS_HOST_DIR_ROOTS = ALLOWED_ROOT;
    const { status, json } = await postHost({
      dir: path.join(ALLOWED_ROOT, 'tiles'),
      kind: 'xyz',
      slug: 'livedir-tiles',
      title: '本机瓦片目录',
    });
    assert.equal(status, 201);
    assert.equal(json.entry.slug, 'livedir-tiles');
    assert.equal(json.entry.hostKind, 'xyz');
    assert.equal(json.entry.hostDir, fs.realpathSync(path.join(ALLOWED_ROOT, 'tiles')));
    assert.deepStrictEqual(json.entry.types, ['tiles']);
    assert.equal(json.entry.artifacts[0].url, '/tiles/livedir-tiles/{z}/{x}/{y}.jpg');
    assert.equal(json.scan.levels.length, 3);
    assert.equal(json.scan.contentRead, false);

    const list = (await (await fetch(`${base}/api/services`)).json()) as Array<{ slug: string }>;
    assert.ok(list.some((s) => s.slug === 'livedir-tiles'), 'GET /api/services 应列出目录托管服务');
  });

  it('同 slug 重复注册 → 覆盖（同名覆盖，注册表只有一条）', async () => {
    process.env.GIS_HOST_DIR_ROOTS = ALLOWED_ROOT;
    const { status } = await postHost({
      dir: path.join(ALLOWED_ROOT, 'tiles'),
      kind: 'xyz',
      slug: 'livedir-tiles',
      title: '改名后',
    });
    assert.equal(status, 201);
    const list = (await (await fetch(`${base}/api/services`)).json()) as Array<{ slug: string; sceneName: string }>;
    assert.equal(list.filter((s) => s.slug === 'livedir-tiles').length, 1);
    assert.equal(list.find((s) => s.slug === 'livedir-tiles')?.sceneName, '改名后');
  });

  it('3D Tiles 注册成功：返回 /tilesets/<slug>/tileset.json', async () => {
    process.env.GIS_HOST_DIR_ROOTS = ALLOWED_ROOT;
    const { status, json } = await postHost({
      dir: path.join(ALLOWED_ROOT, 'dataset'),
      kind: '3dtiles',
      slug: 'livedir-3dtiles',
    });
    assert.equal(status, 201);
    assert.equal(json.entry.hostKind, '3dtiles');
    assert.equal(json.entry.artifacts[0].url, '/tilesets/livedir-3dtiles/tileset.json');
    assert.equal(json.scan.assetVersion, '1.1');
  });
});

// ---------------------------------------------------------------------------
// 3. 托管路由
// ---------------------------------------------------------------------------
describe('t26 · 托管路由（/tiles 与 /tilesets）', () => {
  before(() => {
    process.env.GIS_HOST_DIR_ROOTS = ALLOWED_ROOT;
  });

  it('GET 已注册瓦片 → 200 + 正确 Content-Type + 缓存头', async () => {
    const res = await fetch(`${base}/tiles/livedir-tiles/1/0/0.jpg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /image\/jpeg/);
    assert.match(res.headers.get('cache-control') ?? '', /max-age=\d+/);
    assert.equal(await res.text(), 'jpg1a');
  });

  it('HEAD 已注册瓦片 → 200 且无响应体', async () => {
    const res = await fetch(`${base}/tiles/livedir-tiles/1/0/0.jpg`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /image\/jpeg/);
    assert.equal(await res.text(), '');
  });

  it('未注册 slug → 404；已注册但文件缺失 → 404', async () => {
    assert.equal((await fetch(`${base}/tiles/no-such-slug/0/0/0.jpg`)).status, 404);
    assert.equal((await fetch(`${base}/tiles/livedir-tiles/9/9/9.jpg`)).status, 404);
  });

  it('非白名单扩展名 → 403', async () => {
    assert.equal((await fetch(`${base}/tiles/livedir-tiles/notes.txt`)).status, 403);
    assert.equal((await fetch(`${base}/tiles/livedir-tiles/tiles.exe`)).status, 403);
  });

  it('目录穿越（含 %2F 绕过）→ 403', async () => {
    const res = await fetch(`${base}/tiles/livedir-tiles/0%2f..%2f..%2froots%2foutside%2fsecret.jpg`);
    assert.equal(res.status, 403);
  });

  it('托管目录内的软链文件指向根外 → 403（realpath 拦截）', async () => {
    assert.equal((await fetch(`${base}/tiles/livedir-tiles/1/escape.jpg`)).status, 403);
  });

  it('3D Tiles 托管：tileset.json 与 b3dm 200，非白名单 403', async () => {
    const ts = await fetch(`${base}/tilesets/livedir-3dtiles/tileset.json`);
    assert.equal(ts.status, 200);
    assert.match(ts.headers.get('content-type') ?? '', /application\/json/);
    assert.equal((await ts.json()).asset.version, '1.1');
    const b3dm = await fetch(`${base}/tilesets/livedir-3dtiles/tiles/tile.b3dm`);
    assert.equal(b3dm.status, 200);
    assert.equal((await fetch(`${base}/tilesets/livedir-3dtiles/readme.md`)).status, 403);
  });

  it('类型不匹配：/tiles 下访问 3D Tiles slug → 404；/tilesets 下访问瓦片 slug → 404', async () => {
    assert.equal((await fetch(`${base}/tiles/livedir-3dtiles/tileset.json`)).status, 404);
    assert.equal((await fetch(`${base}/tilesets/livedir-tiles/0/0/0.jpg`)).status, 404);
  });
});

// ---------------------------------------------------------------------------
// 4. 注销
// ---------------------------------------------------------------------------
describe('t26 · DELETE /api/services/:slug（不动源目录）', () => {
  it('注销托管服务：200 + 说明，源目录文件保持原样，托管地址随即 404', async () => {
    process.env.GIS_HOST_DIR_ROOTS = ALLOWED_ROOT;
    const dir = path.join(ALLOWED_ROOT, 'tiles');
    const before = fs.readdirSync(path.join(dir, '1')).sort();

    const res = await fetch(`${base}/api/services/livedir-tiles`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mode: string; sourceDir?: string; message: string; removedGeneratedFiles: boolean };
    assert.equal(body.mode, 'hosted');
    assert.equal(body.removedGeneratedFiles, false);
    assert.equal(body.sourceDir, fs.realpathSync(dir));
    assert.match(body.message, /未被删除/);

    // 源目录仍在，且文件集合与内容不变
    assert.ok(fs.existsSync(dir));
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, '1')).sort(), before);
    assert.equal(fs.readFileSync(path.join(dir, '1', '0', '0.jpg'), 'utf8'), 'jpg1a');

    // 注册表与托管映射已移除
    const list = (await (await fetch(`${base}/api/services`)).json()) as Array<{ slug: string }>;
    assert.ok(!list.some((s) => s.slug === 'livedir-tiles'));
    assert.equal((await fetch(`${base}/tiles/livedir-tiles/1/0/0.jpg`)).status, 404);
  });

  it('注销不存在的服务 → 404', async () => {
    assert.equal((await fetch(`${base}/api/services/none-here`, { method: 'DELETE' })).status, 404);
  });

  it('源目录被移走后条目自动失效（listServices 对账）', async () => {
    process.env.GIS_HOST_DIR_ROOTS = ALLOWED_ROOT;
    const movable = path.join(ALLOWED_ROOT, 'movable');
    fs.mkdirSync(path.join(movable, '0', '0'), { recursive: true });
    fs.writeFileSync(path.join(movable, '0', '0', '0.jpg'), 'x');
    const { status } = await postHost({ dir: movable, kind: 'xyz', slug: 'livedir-movable' });
    assert.equal(status, 201);
    assert.ok(registry.getRegisteredService('livedir-movable'));

    fs.rmSync(movable, { recursive: true, force: true });
    const list = (await (await fetch(`${base}/api/services`)).json()) as Array<{ slug: string }>;
    assert.ok(!list.some((s) => s.slug === 'livedir-movable'), '源目录消失后条目应被剔除');
  });
});
