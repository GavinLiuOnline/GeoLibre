#!/usr/bin/env node
/**
 * vitest → node:test 扫描器版 codemod（Phase 1 测试移植）
 * 用平衡括号扫描处理 expect(EXPR).method(args)，避免正则嵌套括号误配。
 * 未识别的链式方法原样保留 → 跑测试时显式失败，人工修复。
 * 用法: node tmp-vitest-to-node.mjs <file.test.ts>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
let src = readFileSync(file, 'utf8');

/** 跳过字符串/模板/注释，返回从 start 起 depth 归零时的下标（指向匹配的 ')'） */
function matchParen(s, start) {
  let depth = 0, i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) break;
        i++;
      }
      i++; continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

let usedAssert = false;
const out = [];
let pos = 0;
while (true) {
  const idx = src.indexOf('expect(', pos);
  if (idx === -1) { out.push(src.slice(pos)); break; }
  // 词边界：前面不能是标识符字符
  const prev = idx > 0 ? src[idx - 1] : '';
  if (/[A-Za-z0-9_$.]/.test(prev)) { out.push(src.slice(pos, idx + 7)); pos = idx + 7; continue; }
  const openIdx = idx + 'expect'.length; // 指向 '('
  const closeIdx = matchParen(src, openIdx);
  if (closeIdx === -1) { out.push(src.slice(pos, idx + 7)); pos = idx + 7; continue; }
  const expr = src.slice(openIdx + 1, closeIdx).trim();
  // 解析链式方法
  let p = closeIdx + 1;
  let not = false, method = '', argsStart = -1, argsEnd = -1, after = p;
  let m = /^\.not\b/.exec(src.slice(p));
  if (m) { not = true; p += m[0].length; }
  m = /^\.([A-Za-z]+)/.exec(src.slice(p));
  if (m) {
    method = m[1];
    p += m[0].length;
    if (src[p] === '(') {
      argsStart = p;
      argsEnd = matchParen(src, p);
      if (argsEnd === -1) { method = ''; p = closeIdx + 1; }
      else { after = argsEnd + 1; }
    } else { after = p; }
  }

  const args = method && argsStart !== -1 && argsEnd !== -1
    ? src.slice(argsStart + 1, argsEnd).trim() : null;

  const E = `(${expr})`; // 加括号保安全
  let replacement = null;
  switch (method) {
    case 'toBe':            replacement = `${not ? 'assert.notStrict' : 'assert.strict'}Equal(${E}, ${args ?? 'undefined'})`; break;
    case 'toEqual':
    case 'toStrictEqual':   replacement = `${not ? 'assert.notDeep' : 'assert.deep'}StrictEqual(${E}, ${args ?? 'undefined'})`; break;
    case 'toBeTruthy':      replacement = `assert.ok(${not ? '!' : ''}${E})`; break;
    case 'toBeFalsy':       replacement = `assert.ok(${not ? '' : '!'}${not ? '(' + E + ')' : E})`; break;
    case 'toBeNull':        replacement = `assert.strictEqual(${E}, null)`; if (not) replacement = `assert.notStrictEqual(${E}, null)`; break;
    case 'toBeUndefined':   replacement = not ? `assert.notStrictEqual(${E}, undefined)` : `assert.strictEqual(${E}, undefined)`; break;
    case 'toBeDefined':    replacement = not ? `assert.strictEqual(${E}, undefined)` : `assert.notStrictEqual(${E}, undefined)`; break;
    case 'toBeNaN':         replacement = `assert.ok(Number.isNaN(${E}))`; break;
    case 'toBeGreaterThan': replacement = `assert.ok(${E} > (${args}))`; break;
    case 'toBeGreaterThanOrEqual': replacement = `assert.ok(${E} >= (${args}))`; break;
    case 'toBeLessThan':    replacement = `assert.ok(${E} < (${args}))`; break;
    case 'toBeLessThanOrEqual': replacement = `assert.ok(${E} <= (${args}))`; break;
    case 'toHaveLength':    replacement = `assert.strictEqual(${E}.length, (${args}))`; break;
    case 'toContain':       replacement = not ? `assert.ok(!${E}.includes(${args}))` : `assert.ok(${E}.includes(${args}))`; break;
    case 'toMatch':         replacement = not ? `assert.doesNotMatch(${E}, ${args})` : `assert.match(${E}, ${args})`; break;
    case 'toBeCloseTo': {
      const parts = args ? args.split(',').map((x) => x.trim()) : [];
      const d = parts[1] ?? '2';
      replacement = `assert.ok(Math.abs(${E} - (${parts[0]})) < Math.pow(10, -(${d})) / 2)`; break;
    }
    case 'toHaveProperty': {
      if (not) replacement = `assert.ok(!(${args} in Object(${E})))`;
      else replacement = `assert.ok((${args}) in Object(${E}))`;
      break;
    }
    case 'toThrow':
    case 'toThrowError':
      replacement = args ? `assert.throws(${E}, ${args})` : `assert.throws(${E})`; break;
    case 'toMatchObject':
    case 'toHaveBeenCalled':
    case 'toHaveBeenCalledWith':
    default:
      // 未识别：原样保留 expect 调用，跑测试时显式暴露
      replacement = src.slice(idx, after);
      break;
  }

  out.push(src.slice(pos, idx));
  out.push(replacement);
  pos = after;
  if (method && usedAssert === false && replacement.startsWith('assert.')) usedAssert = true;
}
src = out.join('');

// vitest import 头重写
const vitestImport = /^[ \t]*import\s*\{([^}]+)\}\s*from\s*['"]vitest['"]\s*;?\n/m;
const m2 = src.match(vitestImport);
if (m2) {
  const names = m2[1].split(',').map((n) => n.trim()).filter((n) => n && n !== 'expect' && !n.startsWith('vi'));
  const lines = [];
  if (usedAssert) lines.push('import assert from "node:assert/strict";');
  lines.push(names.length ? `import { ${names.join(', ')} } from "node:test";` : 'import { describe, it } from "node:test";');
  src = src.replace(vitestImport, lines.join('\n') + '\n');
}
// 兜底：没有 vitest import 但用了 assert
if (usedAssert && !/import assert from ["']node:assert\/strict["'];/.test(src)) {
  src = 'import assert from "node:assert/strict";\n' + src;
}

writeFileSync(file, src);
const leftover = (src.match(/expect\(/g) ?? []).length;
console.log(`converted ${file}${leftover ? ` — 残留 expect(${leftover}) 需手修` : ' — 全部转换'}`);
