/**
 * server · 绑定地址加固（t28）单测
 *
 * 覆盖：
 *   1. `resolveBindHost`：默认 127.0.0.1（不再默认 0.0.0.0）、显式 GIS_HOST、空白回落
 *   2. `isLoopbackHost`：127.0.0.0/8、::1、localhost、::ffff:127.x 为回环；0.0.0.0/::/局域网地址非回环
 *   3. `hostExposureWarning`：白名单非空 + 非回环 → 有警告；白名单空 或 回环绑定 → 无警告
 *   4. 端到端：真实启动服务端进程，断言**默认只绑定回环**（日志打印实际绑定地址 +
 *      非回环本机地址无法连接），并在非回环绑定 + 白名单非空时打印安全警告
 *
 * 运行：pnpm --filter server test（node:test + tsx）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { DEFAULT_BIND_HOST, HOST_ENV, bindDescription, hostExposureWarning, isLoopbackHost, resolveBindHost } from '../src/util/bindAddress.js';
import { HOST_DIR_ROOTS_ENV } from '../src/services/hostDirectory.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = path.join(SERVER_ROOT, '.test-data-t28');
const ALLOWED_ROOT = path.join(TEST_ROOT, 'allowed');

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ALLOWED_ROOT, '0', '0'), { recursive: true });
fs.writeFileSync(path.join(ALLOWED_ROOT, '0', '0', '0.jpg'), 'x');

after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** 启动服务端进程，收集 stdout/stderr 直到出现「已启动」，返回日志与关闭函数 */
async function startServer(env: NodeJS.ProcessEnv): Promise<{ log: () => string; port: number; stop: () => Promise<void> }> {
  const port = await freePort();
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(TEST_ROOT, `data-${port}`), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务端启动超时:\n${log}`)), 20_000);
    const onData = (chunk: Buffer): void => {
      log += chunk.toString();
      if (log.includes('已启动')) {
        clearTimeout(timer);
        // 启动日志与安全警告可能落在不同 chunk（stdout/stderr 分开），稍等再断言
        setTimeout(resolve, 300);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!log.includes('已启动')) reject(new Error(`服务端退出 code=${code}:\n${log}`));
    });
  });
  await done;
  return {
    log: () => log,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
      }),
  };
}

/** 是否能连上指定 host:port（用于证明非回环地址不可达） */
function canConnect(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------
describe('t28 · 绑定地址解析与暴露判定（纯函数）', () => {
  it('默认解析为 127.0.0.1（不再默认 0.0.0.0）', () => {
    assert.equal(resolveBindHost({}), DEFAULT_BIND_HOST);
    assert.equal(resolveBindHost({}), '127.0.0.1');
    assert.equal(resolveBindHost({ [HOST_ENV]: '   ' }), '127.0.0.1');
    assert.equal(resolveBindHost({ [HOST_ENV]: '' }), '127.0.0.1');
  });

  it('显式 GIS_HOST 生效（含对外暴露的 0.0.0.0 / ::）', () => {
    assert.equal(resolveBindHost({ [HOST_ENV]: '0.0.0.0' }), '0.0.0.0');
    assert.equal(resolveBindHost({ [HOST_ENV]: '::' }), '::');
    assert.equal(resolveBindHost({ [HOST_ENV]: ' 192.168.1.5 ' }), '192.168.1.5');
    assert.equal(resolveBindHost({ [HOST_ENV]: 'localhost' }), 'localhost');
  });

  it('回环判定：127.0.0.0/8 / ::1 / localhost / ::ffff:127.x 为回环', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1']) {
      assert.equal(isLoopbackHost(host), true, `${host} 应判定为回环`);
    }
    for (const host of ['0.0.0.0', '::', '[::]', '192.168.1.5', '10.0.0.1', 'example.com', '']) {
      assert.equal(isLoopbackHost(host), false, `${host} 应判定为非回环`);
    }
  });

  it('白名单非空 + 非回环绑定 → 产生警告；白名单空 或 回环绑定 → 无警告', () => {
    const roots = [ALLOWED_ROOT];
    const warn = hostExposureWarning({ [HOST_ENV]: '0.0.0.0', [HOST_DIR_ROOTS_ENV]: ALLOWED_ROOT }, roots);
    assert.ok(warn, '应产生警告');
    assert.match(warn!, /安全警告/);
    assert.match(warn!, /0\.0\.0\.0/);
    assert.match(warn!, new RegExp(HOST_DIR_ROOTS_ENV));
    assert.match(warn!, /可见|枚举/);

    // IPv6 通配 :: 也是非回环 → 同样告警
    assert.ok(hostExposureWarning({ [HOST_ENV]: '::', [HOST_DIR_ROOTS_ENV]: ALLOWED_ROOT }, roots));
    assert.equal(hostExposureWarning({ [HOST_ENV]: '0.0.0.0' }, []), null); // 无白名单
    assert.equal(hostExposureWarning({ [HOST_DIR_ROOTS_ENV]: ALLOWED_ROOT }, roots), null); // 默认回环
    assert.equal(hostExposureWarning({}, []), null);
  });

  it('绑定描述包含实际绑定地址', () => {
    assert.equal(bindDescription('127.0.0.1', 8080, '127.0.0.1:8080'), 'http://127.0.0.1:8080（实际绑定 127.0.0.1:8080）');
    assert.match(bindDescription('0.0.0.0', 8080), /实际绑定 0\.0\.0\.0:8080/);
  });
});

// ---------------------------------------------------------------------------
// 2. 端到端：真实进程的默认绑定与警告
// ---------------------------------------------------------------------------
describe('t28 · 端到端：默认只绑回环 + 非回环暴露告警', () => {
  it('默认启动（未设 GIS_HOST）→ 日志显示 127.0.0.1，且非回环本机地址不可达', async () => {
    const srv = await startServer({ GIS_HOST: '', GIS_HOST_DIR_ROOTS: ALLOWED_ROOT });
    try {
      const log = srv.log();
      assert.match(log, new RegExp(`实际绑定 127\\.0\\.0\\.1:${srv.port}`), `日志应打印实际绑定地址:\n${log}`);
      assert.equal(await canConnect('127.0.0.1', srv.port), true, '回环应可达');
      // 局域网/其他网卡地址不可达 → 证明没有监听 0.0.0.0
      const external = Object.values(os.networkInterfaces())
        .flat()
        .filter((i): i is os.NetworkInterfaceInfo => !!i && !i.internal && i.family === 'IPv4')
        .map((i) => i.address);
      for (const ip of external) {
        assert.equal(await canConnect(ip, srv.port), false, `默认不应在非回环地址 ${ip} 上监听`);
      }
      // 白名单非空但绑定回环 → 不应出现安全警告
      assert.doesNotMatch(log, /安全警告/);
    } finally {
      await srv.stop();
    }
  });

  it('显式 GIS_HOST=0.0.0.0 + 白名单非空 → 日志出现醒目安全警告', async () => {
    const srv = await startServer({ GIS_HOST: '0.0.0.0', GIS_HOST_DIR_ROOTS: ALLOWED_ROOT });
    try {
      const log = srv.log();
      assert.match(log, /实际绑定 0\.0\.0\.0:/, `日志应打印实际绑定地址:\n${log}`);
      assert.match(log, /安全警告/);
      assert.match(log, /0\.0\.0\.0/);
      assert.match(log, new RegExp(HOST_DIR_ROOTS_ENV));
      assert.match(log, /可见|枚举/);
    } finally {
      await srv.stop();
    }
  });

  it('显式 GIS_HOST=0.0.0.0 但无白名单 → 不打印目录托管暴露警告', async () => {
    const srv = await startServer({ GIS_HOST: '0.0.0.0', GIS_HOST_DIR_ROOTS: '' });
    try {
      assert.doesNotMatch(srv.log(), /安全警告/);
    } finally {
      await srv.stop();
    }
  });
});
