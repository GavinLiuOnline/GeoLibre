/**
 * editor/electron/xyzDisk —— 主进程纯逻辑回归（t35）
 *
 * 模块声明：本文件零 `electron` 依赖，node 环境可直接测（vitest environment=node）。
 * 覆盖合同要求：
 * 1. parseDiskDir / assertExportPaths 路径校验（绝对路径 / NUL 字节 / realpath / 互不包含）
 * 2. 公式法：lngToTileX / latToTileY / tileToBounds / tilePassesFilter / estimateFilterTileCount
 * 3. scanXyzDirectory 有界扫描：白名单扩展名 / 层级聚合 / 主扩展名 / 采样范围 / 非 XYZ 报错
 * 4. StreamingZipWriter：基本 addFile + finalize + ZIP 中央目录可被 unzip 解析
 * 5. runDiskTileExport：directory 流式直拷 + zip 流式打包；取消时半成品清理
 * 6. XyzDiskExportRunner：start 立即返回 jobId / cancel 幂等 / 终态可达
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";;;
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  XyzDiskError,
  XyzDiskExportRunner,
  XYZ_DISK_TILE_EXTENSIONS,
  XYZ_DISK_WORLD_BOUNDS,
  assertExportPaths,
  buildDiskImportParams,
  crc32Update,
  estimateFilterTileCount,
  latToTileY,
  lngToTileX,
  normalizeDiskExportSpec,
  parseDiskDir,
  parseTileFileName,
  runDiskTileExport,
  scanXyzDirectory,
  tilePassesFilter,
  tileToBounds,
  tileXToLon,
  tileYToLat,
} from '../packages/xyz-cache/src/xyz-disk';

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

let workRoot = '';
let siblingRoot = '';

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'xyz-disk-'));
  siblingRoot = await mkdtemp(join(tmpdir(), 'xyz-sib-'));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
  await rm(siblingRoot, { recursive: true, force: true });
});

/** 在 workRoot 下创建形如 `<z>/<x>/<y>.<ext>` 的瓦片树（可选 ext 列表） */
async function seedTiles(levels: Array<{ z: number; cols: number; rows: number; ext?: string }>): Promise<void> {
  for (const level of levels) {
    const ext = level.ext ?? 'jpg';
    for (let x = 0; x < level.cols; x += 1) {
      for (let y = 0; y < level.rows; y += 1) {
        const dir = join(workRoot, String(level.z), String(x));
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${y}.${ext}`), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 路径校验
// ---------------------------------------------------------------------------

describe('parseDiskDir', () => {
  it('拒绝空 / 非字符串输入', async () => {
    await assert.rejects((parseDiskDir('')), { code: 'invalid-path' });
    await assert.rejects((parseDiskDir('   ')), { code: 'invalid-path' });
    await assert.rejects((parseDiskDir(undefined)), { code: 'invalid-path' });
    await assert.rejects((parseDiskDir(42)), { code: 'invalid-path' });
  });

  it('拒绝 NUL 字节', async () => {
    await assert.rejects((parseDiskDir(`\0${workRoot}`)), { code: 'invalid-path' });
  });

  it('拒绝相对路径', async () => {
    await assert.rejects((parseDiskDir('relative/path')), { code: 'invalid-path' });
  });

  it('realpath 不存在 / 不是目录 → 抛 invalid-path', async () => {
    await assert.rejects((parseDiskDir('/this/path/does/not/exist/at/all')), { code: 'invalid-path' });
    const filePath = join(workRoot, 'flat.txt');
    await writeFile(filePath, 'hi');
    await assert.rejects((parseDiskDir(filePath)), { code: 'invalid-path' });
  });

  it('返回 realpath 规范化结果', async () => {
    const out = await parseDiskDir(workRoot);
    // parseDiskDir 内部走 fs.realpath 归一化路径。
    // Windows 上 os.tmpdir() / mkdtemp 与 fs.realpath 可能在长名 / 短名
    // （RUNNER~1 / runneradmin）之间不一致；Node 22 fs.realpathSync 默认
    // 不展开 8.3 短名，所以两侧字符串字面值仍可能不同。语义断言改为：
    // 1) realpath 幂等（realpathSync 二次调用不再变）
    // 2) 输入原样回传（trim + 校验通过）
    // 3) realPath 与输入指向同一目录（statSync dev+ino 相同：跨平台「同文件」
    //    最鲁棒判等，Windows 上 ino 是 MFT 条目索引，与路径字面值无关）
    assert.strictEqual((realpathSync(out.realPath)), out.realPath);
    assert.strictEqual((out.input), workRoot);
    const sWork = statSync(workRoot);
    const sReal = statSync(out.realPath);
    assert.strictEqual((sReal.dev), sWork.dev);
    assert.strictEqual((sReal.ino), sWork.ino);
  });
});

describe('assertExportPaths', () => {
  it('zip 目标必须 .zip 后缀', () => {
    assert.throws((() => assertExportPaths(siblingRoot, join(workRoot, '..', 'out.bin'), 'zip')), XyzDiskError);
    assert.doesNotThrow((() => assertExportPaths(siblingRoot, join(workRoot, '..', 'out.zip'), 'zip')));
  });

  it('dest 在 src 内部 → 抛错（防自拷贝递归）', () => {
    assert.throws((() => assertExportPaths(workRoot, join(workRoot, 'sub', 'out.zip'), 'zip')), XyzDiskError);
  });

  it('src 在 dest 内部 → 抛错', () => {
    const dest = join(workRoot, 'export');
    assert.throws((() => assertExportPaths(join(dest, 'nested'), dest, 'directory')), XyzDiskError);
  });

  it('独立 dest 不报错', () => {
    assert.doesNotThrow((() => assertExportPaths(workRoot, join(siblingRoot, 'out.zip'), 'zip')));
  });

  it('拒绝相对路径 / NUL', () => {
    assert.throws((() => assertExportPaths(workRoot, 'relative', 'zip')), XyzDiskError);
    assert.throws((() => assertExportPaths(workRoot, `\0${workRoot}/x.zip`, 'zip')), /非法字符/);
  });
});

// ---------------------------------------------------------------------------
// 公式法
// ---------------------------------------------------------------------------

describe('tile coord formulas', () => {
  it('lngToTileX / tileXToLon 在 web-mercator 与 geographic 上闭环', () => {
    const zoom = 10;
    for (const mode of ['web-mercator', 'geographic'] as const) {
      for (const lng of [-180, -90, 0, 90, 180]) {
        const x = lngToTileX(lng, zoom, mode);
        assert.ok((x) >= (0));
        const n = mode === 'geographic' ? 2 ** (zoom + 1) : 2 ** zoom;
        assert.ok((x) < (n));
        assert.ok((tileXToLon(x, zoom, mode)) <= (lng + 1e-9));
      }
    }
  });

  it('latToTileY 在 ±85.05° 钳制（web-mercator），geographic 在 ±90° 钳制', () => {
    const zoom = 8;
    assert.strictEqual((latToTileY(90, zoom, 'web-mercator')), 0);
    assert.strictEqual((latToTileY(-85.06, zoom, 'web-mercator')), 2 ** zoom - 1);
    assert.strictEqual((latToTileY(90, zoom, 'geographic')), 0);
    assert.strictEqual((latToTileY(-90, zoom, 'geographic')), 2 ** zoom - 1);
  });

  it('tileToBounds：单瓦片范围包含中心经纬度', () => {
    const z = 4;
    const x = 8;
    const y = 5;
    const [w, s, e, n] = tileToBounds(z, x, y, { tilingMode: 'web-mercator' });
    assert.ok((w) < (e));
    assert.ok((s) < (n));
    assert.ok((w) <= (0));
    assert.ok((e) >= (0));
  });

  it('tileToBounds TMS：翻转 y，纬度单调正确', () => {
    const z = 2;
    const [w0, s0, e0, n0] = tileToBounds(z, 0, 0, { tilingMode: 'web-mercator' });
    const [w1, s1, e1, n1] = tileToBounds(z, 0, 0, { tilingMode: 'web-mercator', tms: true });
    // TMS y 翻转 → 经纬度不同（北起 → 南起）
    assert.notDeepStrictEqual(([s0, n0]), [s1, n1]);
  });

  it('tilePassesFilter：层级外 / 范围外 = false', () => {
    const z = 5;
    const filter = { minZoom: 6, maxZoom: 10, bounds: [-180, -85.05, 180, 85.05] as const };
    assert.strictEqual((tilePassesFilter(z, 0, 0, filter)), false);
    assert.strictEqual((tilePassesFilter(7, 0, 0, filter)), true);
    // z=8, x=50 → 西边界 ~ -109.6875，东边界 ~ -107.8125；y=124 → 赤道附近
    const tiny = { minZoom: 0, maxZoom: 18, bounds: [-110, -15, -105, 15] as const };
    assert.strictEqual((tilePassesFilter(8, 50, 124, tiny)), true);
    assert.strictEqual((tilePassesFilter(8, 0, 0, tiny)), false);
  });

  it('estimateFilterTileCount 与已知数量一致（全球 z=0 = 1, z=2 = 16）', () => {
    const world = estimateFilterTileCount({ bounds: [...XYZ_DISK_WORLD_BOUNDS], minZoom: 0, maxZoom: 0, tilingMode: 'web-mercator' });
    assert.strictEqual((world.totalTiles), 1);
    const z2 = estimateFilterTileCount({ bounds: [...XYZ_DISK_WORLD_BOUNDS], minZoom: 2, maxZoom: 2, tilingMode: 'web-mercator' });
    assert.strictEqual((z2.totalTiles), 16);
  });

  it('estimateFilterTileCount：跨 antimeridian 拆两段（覆盖范围更大）', () => {
    // wrap = [175..180] + [-180..-175]，跨越 ±180° 拼成 10°
    const wrap = estimateFilterTileCount({
      bounds: [175, -10, -175, 10],
      minZoom: 2,
      maxZoom: 2,
      tilingMode: 'web-mercator',
    });
    // noWrap = [175..180]，单段 5°
    const noWrap = estimateFilterTileCount({
      bounds: [175, -10, 180, 10],
      minZoom: 2,
      maxZoom: 2,
      tilingMode: 'web-mercator',
    });
    // 跨越 180° 应覆盖更宽经度区间，瓦片数更多
    assert.ok((wrap.totalTiles) > (noWrap.totalTiles));
  });

  it('estimateFilterTileCount：geographic 行数 = 2^z，列数 = 2^(z+1)', () => {
    const r = estimateFilterTileCount({ bounds: [-180, -85.05, 180, 85.05], minZoom: 3, maxZoom: 3, tilingMode: 'geographic' });
    // 列 16（2^4），行 8（2^3）→ 128
    assert.strictEqual((r.totalTiles), 128);
  });
});

describe('parseTileFileName', () => {
  it('白名单内的 <y>.<ext> → { y, ext }', () => {
    assert.deepStrictEqual((parseTileFileName('0.jpg')), { y: 0, ext: 'jpg' });
    assert.deepStrictEqual((parseTileFileName('123.webp')), { y: 123, ext: 'webp' });
  });

  it('白名单外 / 格式错 → undefined', () => {
    assert.strictEqual((parseTileFileName('0.gif')), undefined);
    assert.strictEqual((parseTileFileName('0.tar')), undefined);
    assert.strictEqual((parseTileFileName('foo.jpg')), undefined);
    assert.strictEqual((parseTileFileName('0jpg')), undefined);
  });
});

describe('crc32Update', () => {
  it('空字节 → 0', () => {
    assert.strictEqual((crc32Update(0, new Uint8Array())), 0);
  });
  it('链式更新与一次性更新等价', () => {
    const data = Buffer.from('hello world');
    const oneShot = crc32Update(0, new Uint8Array(data));
    let c = 0;
    for (const chunk of [data.subarray(0, 3), data.subarray(3, 7), data.subarray(7)]) {
      c = crc32Update(c, new Uint8Array(chunk));
    }
    assert.strictEqual((c), oneShot);
  });
  it('"123456789" 标准 CRC32 = 0xCBF43926', () => {
    assert.strictEqual((crc32Update(0, new Uint8Array(Buffer.from('123456789')))), 0xcbf43926 >>> 0);
  });
});

// ---------------------------------------------------------------------------
// scanXyzDirectory 有界扫描
// ---------------------------------------------------------------------------

describe('scanXyzDirectory', () => {
  it('空目录 → not-xyz', async () => {
    await assert.rejects((scanXyzDirectory(workRoot)), { code: 'not-xyz' });
  });

  it('顶层无数字层级 → not-xyz', async () => {
    await mkdir(join(workRoot, 'foo', '0', 'bar'), { recursive: true });
    await writeFile(join(workRoot, 'foo', '0', 'bar', '0.jpg'), Buffer.from([0]));
    await assert.rejects((scanXyzDirectory(workRoot)), { code: 'not-xyz' });
  });

  it('正确层级 → 聚合层级 / 主扩展名 / 瓦片数下限 / 采样范围', async () => {
    await seedTiles([
      { z: 0, cols: 1, rows: 1, ext: 'jpg' },
      { z: 1, cols: 2, rows: 2, ext: 'jpg' },
      { z: 2, cols: 4, rows: 4, ext: 'png' }, // png 16 > jpg 5 → 主扩展名应为 png
    ]);
    const scan = await scanXyzDirectory(workRoot);
    assert.strictEqual((scan.kind), 'xyz');
    assert.deepStrictEqual((scan.levels.map((l) => l.z)), [0, 1, 2]);
    assert.strictEqual((scan.levels[0]?.tiles), 1);
    assert.strictEqual((scan.levels[1]?.tiles), 4);
    assert.strictEqual((scan.primaryExt), 'png');
    assert.ok((scan.extensions).includes('jpg'));
    assert.ok((scan.extensions).includes('png'));
    assert.strictEqual((scan.truncated), false);
    assert.strictEqual((scan.tileCount), 1 + 4 + 16);
    assert.notStrictEqual((scan.bounds), undefined);
    assert.strictEqual((scan.bounds?.[0]), -180);
  });

  it('非白名单扩展名 → 计入 0 但 primaryExt 为空（调用方应据此拒绝）', async () => {
    await mkdir(join(workRoot, '0', '0'), { recursive: true });
    await writeFile(join(workRoot, '0', '0', '0.gif'), Buffer.from([0])); // gif 不在白名单
    const scan = await scanXyzDirectory(workRoot);
    assert.strictEqual((scan.tileCount), 0);
    assert.strictEqual((scan.primaryExt), '');
    assert.deepStrictEqual((scan.extensions), []);
  });

  it('有界扫描：单层瓦片达 maxTilesPerLevel → truncated=true', async () => {
    // 单层 1000 张瓦片；maxTilesPerLevel=50 → truncated
    for (let x = 0; x < 20; x += 1) {
      await mkdir(join(workRoot, '5', String(x)), { recursive: true });
      for (let y = 0; y < 50; y += 1) {
        await writeFile(join(workRoot, '5', String(x), `${y}.jpg`), Buffer.from([1]));
      }
    }
    const scan = await scanXyzDirectory(workRoot, {
      limits: { maxTotalEntries: 50_000, maxTilesPerLevel: 50, boundsSampleTiles: 32 },
    });
    assert.strictEqual((scan.truncated), true);
    assert.ok((scan.levels[0]?.tiles) > (0));
    assert.ok((scan.tileCount) > (0));
  });
});

describe('buildDiskImportParams', () => {
  it('由扫描结果推导模板 / 层级 / 基准地址', async () => {
    await seedTiles([{ z: 0, cols: 1, rows: 1 }, { z: 2, cols: 2, rows: 2 }]);
    const scan = await scanXyzDirectory(workRoot);
    const params = buildDiskImportParams(scan);
    // params.dir 应与 workRoot 指向同一目录。Windows 上两者可能一个是长名
    // 一个是 8.3 短名（RUNNER~1 / runneradmin），Node fs.realpathSync 默认不
    // 展开短名，所以字符串字面值仍不同；用 statSync dev+ino 判等最稳。
    const sWork = statSync(workRoot);
    const sDir = statSync(params.dir);
    assert.strictEqual((sDir.dev), sWork.dev);
    assert.strictEqual((sDir.ino), sWork.ino);
    assert.strictEqual((params.ext), 'jpg');
    assert.strictEqual((params.minZoom), 0);
    assert.strictEqual((params.maxZoom), 2);
    assert.strictEqual((params.template.endsWith('/{z}/{x}/{y}.jpg')), true);
    assert.strictEqual((params.baseUrl.startsWith('file://')), true);
    assert.deepStrictEqual((params.levels), [0, 2]);
  });

  it('扫描结果无主扩展名 → not-xyz', async () => {
    await mkdir(join(workRoot, '0', '0'), { recursive: true });
    await writeFile(join(workRoot, '0', '0', '0.unknown'), Buffer.from([0]));
    // 顶层有数字 z=0 目录（满足结构），但瓦片文件不在白名单 → scan 通过但 primaryExt 为空
    const scan = await scanXyzDirectory(workRoot);
    assert.strictEqual((scan.primaryExt), '');
    try {
      buildDiskImportParams(scan);
      throw new Error('should throw');
    } catch (err) {
      assert.ok((err) instanceof XyzDiskError);
      assert.strictEqual((err as XyzDiskError).code, 'not-xyz');
    }
  });
});

// ---------------------------------------------------------------------------
// runDiskTileExport / StreamingZipWriter
// ---------------------------------------------------------------------------

describe('runDiskTileExport (directory)', () => {
  it('瓦片树直拷：按裁剪条件复制 + 进度回调单调', async () => {
    await seedTiles([{ z: 2, cols: 4, rows: 4 }]); // 16 瓦片（z=2 网格 4×4）
    const dest = join(siblingRoot, 'export');
    const progressCalls: number[] = [];
    const result = await runDiskTileExport(
      {
        srcDir: workRoot,
        format: 'directory',
        dest,
        minZoom: 2,
        maxZoom: 2,
        ext: 'jpg',
      } as never,
      16,
      {
        onProgress: (p) => {
          progressCalls.push(p.doneTiles);
        },
      },
    );
    assert.strictEqual((result.status), 'done');
    assert.strictEqual((result.fileCount), 16);
    assert.strictEqual((progressCalls[progressCalls.length - 1]), 16);
    assert.strictEqual((result.skippedTiles), 0);
    const st = await stat(dest);
    assert.strictEqual((st.isDirectory()), true);
  });

  it('目标目录已存在且非空 → 返回 failed（runDiskTileExport 不抛，错误归一到 outcome）', async () => {
    await seedTiles([{ z: 2, cols: 1, rows: 1 }]);
    const dest = join(siblingRoot, 'export');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'pre-existing.txt'), 'x');
    const { spec, totalTiles } = await normalizeDiskExportSpec({
      srcDir: workRoot,
      format: 'directory',
      dest,
      minZoom: 2,
      maxZoom: 2,
    });
    const result = await runDiskTileExport(spec, totalTiles);
    assert.strictEqual((result.status), 'failed');
    assert.match((result.error), /导出目标目录非空/);
  });
});

describe('runDiskTileExport (zip)', () => {
  it('流式 ZIP：中央目录条目名与瓦片路径一致', async () => {
    await seedTiles([{ z: 1, cols: 2, rows: 2 }]); // z=1 网格 2×2 = 4 瓦片
    const zipPath = join(siblingRoot, 'out.zip');
    const result = await runDiskTileExport(
      {
        srcDir: workRoot,
        format: 'zip',
        dest: zipPath,
        minZoom: 1,
        maxZoom: 1,
        ext: 'jpg',
      } as never,
      4,
    );
    assert.strictEqual((result.status), 'done');
    assert.strictEqual((result.fileCount), 4);
    const entries = await unzipList(zipPath);
    assert.deepStrictEqual((entries.sort()), ['1/0/0.jpg', '1/0/1.jpg', '1/1/0.jpg', '1/1/1.jpg']);
  });

  it('取消时半成品 zip 与 .cd 临时文件被清理', async () => {
    await seedTiles([{ z: 1, cols: 2, rows: 2 }]);
    const zipPath = join(siblingRoot, 'out.zip');
    const controller = new AbortController();
    const runPromise = runDiskTileExport(
      {
        srcDir: workRoot,
        format: 'zip',
        dest: zipPath,
        minZoom: 1,
        maxZoom: 1,
      } as never,
      4,
      { signal: controller.signal },
    );
    controller.abort();
    const result = await runPromise;
    assert.strictEqual((result.status), 'cancelled');
    // 半成品 zip 已删除
    await assert.rejects(async () => (stat(zipPath)));
    // .cd 临时文件也清理
    await assert.rejects(async () => (stat(`${zipPath}.cd`)));
  });
});

describe('XyzDiskExportRunner', () => {
  it('start 立即返回 jobId；cancel 命中运行中任务；不存在的 jobId 返回 false', async () => {
    await seedTiles([{ z: 1, cols: 2, rows: 2 }]);
    const runner = new XyzDiskExportRunner();
    const { jobId } = await runner.start({
      srcDir: workRoot,
      format: 'directory',
      dest: join(siblingRoot, 'export'),
      minZoom: 1,
      maxZoom: 1,
    });
    assert.match((jobId), /^xyz-export-/);
    assert.strictEqual((runner.cancel(jobId)), true);
    assert.strictEqual((runner.cancel('no-such-job')), false);
    // 等到 done promise 落定后，再次 cancel 已不在 running 态 → false
    await runner.get(jobId); // ensure registry
    // 触发完成：等待 done promise
    const started = await runner.start({
      srcDir: workRoot,
      format: 'directory',
      dest: join(siblingRoot, 'export2'),
      minZoom: 1,
      maxZoom: 1,
    });
    await started.done;
    assert.strictEqual((runner.cancel(started.jobId)), false); // done 之后不在 running
  });

  it('进度快照由 onSnapshot 推送 + 终态可达', async () => {
    await seedTiles([{ z: 1, cols: 2, rows: 2 }]);
    const runner = new XyzDiskExportRunner();
    const snapshots: string[] = [];
    const { jobId, done } = await runner.start(
      {
        srcDir: workRoot,
        format: 'directory',
        dest: join(siblingRoot, 'export'),
        minZoom: 1,
        maxZoom: 1,
      },
      {
        onSnapshot: (s) => snapshots.push(s.status),
      },
    );
    const final = await done;
    assert.strictEqual((final.status), 'done');
    assert.strictEqual((snapshots[snapshots.length - 1]), 'done');
    const snapshot = runner.get(jobId);
    assert.strictEqual((snapshot?.status), 'done');
    assert.ok((snapshot?.fileCount ?? snapshot?.doneTiles) > (0));
  });
});

// ---------------------------------------------------------------------------
// node unzip 探测（用 python3 / unzip 兜底；缺失时静默跳过 ZIP 内容断言）
// ---------------------------------------------------------------------------

async function unzipList(zipPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('unzip', ['-Z1', zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: string[] = [];
    let resolved = false;
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line) out.push(line);
      }
    });
    child.on('error', () => {
      if (!resolved) {
        resolved = true;
        // 兜底：手工解析 ZIP 中央目录
        unzipFallback(zipPath).then(resolve).catch(() => resolve([]));
      }
    });
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      if (code === 0) resolve(out);
      else {
        // unzip 非 0：尝试手工解析
        unzipFallback(zipPath).then(resolve).catch(() => resolve([]));
      }
    });
  });
}

/** 手工解析 ZIP 中央目录条目名（兼容任何平台，不依赖 unzip CLI） */
async function unzipFallback(zipPath: string): Promise<string[]> {
  const buf = await readFile(zipPath);
  const out: string[] = [];
  const eocdSig = 0x06054b50;
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) return out;
  const total = buf.readUInt16LE(eocdAt + 10);
  const cdStart = buf.readUInt32LE(eocdAt + 16);
  let p = cdStart;
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
