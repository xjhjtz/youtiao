/**
 * wiring.test.mjs —— 静态契约测试。
 *
 * 这类错误浏览器里只在运行到那一行才炸（甚至静默失败），所以在这里一次性查清：
 *   1. JS 里写到的每个 DOM id 都真的存在于 index.html
 *   2. index.html 里没有重复 id
 *   3. 每个相对 import 都能落到真实文件
 *   4. 每个具名 import 都真的被目标模块导出
 *   5. index.html 引用的 css / js 资源文件存在
 *   6. data-copy-target 指向的 id 存在
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = join(ROOT, 'assets', 'js');

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const jsFiles = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
const sources = new Map(jsFiles.map((f) => [f, readFileSync(join(JS_DIR, f), 'utf8')]));

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

/** 脚本里动态创建的元素 id（例如 promptDialog 注入的 #modalInput）。 */
const dynamicIds = new Set(
  jsFiles.flatMap((f) => [...sources.get(f).matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))
);

/** 收集一个 JS 文件里引用到的 DOM id。 */
function referencedIds(source) {
  const ids = new Set();
  const patterns = [
    /\$\('#([A-Za-z0-9_-]+)'/g, // $('#foo')
    /getElementById\('([A-Za-z0-9_-]+)'\)/g,
    /querySelector\('#([A-Za-z0-9_-]+)'\)/g
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) ids.add(match[1]);
  }
  return ids;
}

/** 收集一个模块导出的名字。 */
function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const alias = piece.split(/\s+as\s+/);
      names.add((alias[1] || alias[0]).trim());
      names.add(alias[0].trim());
    }
  }
  return names;
}

/** 解析一个模块的 import 语句。 */
function importsOf(source) {
  const out = [];
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = match[1];
    const specifier = match[2];
    const names = [];
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        names.push(piece.split(/\s+as\s+/)[0].trim());
      }
    }
    out.push({ clause, specifier, names });
  }
  return out;
}

test('index.html 里不存在重复的 id', () => {
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = all.filter((id, i) => all.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], [], '存在重复 id，$() 只会命中第一个');
});

test('JS 中引用的每个 DOM id 都存在于 index.html 或由脚本动态创建', () => {
  const missing = [];
  for (const [file, source] of sources) {
    for (const id of referencedIds(source)) {
      if (!htmlIds.has(id) && !dynamicIds.has(id)) missing.push(`${file} → #${id}`);
    }
  }
  assert.deepEqual(missing, [], '这些 id 既不在 index.html 里，也没有被脚本创建');
});

test('index.html 的 data-copy-target 都指向存在的 id', () => {
  const targets = [...html.matchAll(/data-copy-target="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(targets.length > 0, '至少应该有一个复制按钮');
  for (const target of targets) assert.ok(htmlIds.has(target), `data-copy-target="${target}" 指向不存在的 id`);
});

test('每个相对 import 都指向真实存在的模块', () => {
  for (const [file, source] of sources) {
    for (const { specifier } of importsOf(source)) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(JS_DIR, specifier);
      assert.ok(existsSync(target), `${file} 里的 import "${specifier}" 找不到对应文件`);
    }
  }
});

test('每个具名 import 都真的被目标模块导出', () => {
  const problems = [];
  for (const [file, source] of sources) {
    for (const { names, specifier } of importsOf(source)) {
      if (!specifier.startsWith('.')) continue;
      const targetPath = resolve(JS_DIR, specifier);
      const targetSource = readFileSync(targetPath, 'utf8');
      const available = exportedNames(targetSource);
      for (const name of names) {
        if (!available.has(name)) problems.push(`${file} 从 ${specifier} 导入了不存在的 ${name}`);
      }
    }
  }
  assert.deepEqual(problems, [], '存在无效的具名导入');
});

test('index.html 引用的 css / js 资源文件都存在', () => {
  const refs = [
    ...html.matchAll(/<script[^>]+src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]+href="([^"]+)"/g)
  ]
    .map((m) => m[1])
    .filter((href) => !/^(https?:|data:)/.test(href));
  assert.ok(refs.length >= 2, '至少引用了一个 css 和一个 js');
  for (const ref of refs) assert.ok(existsSync(join(ROOT, ref)), `资源文件不存在：${ref}`);
});

test('app.js 没有残留的未使用导入', () => {
  const source = sources.get('app.js');
  const body = source.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '');
  const unused = [];
  for (const { names } of importsOf(source)) {
    for (const name of names) {
      // 注意：$ 不是单词字符，不能用 \b，必须用「前后不是标识符字符」的断言
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
      if (!re.test(body)) unused.push(name);
    }
  }
  assert.deepEqual(unused, [], '这些导入没有被使用，属于死代码');
});

test('index.html 中出现的每个 id 都能被脚本正常访问（无非法字符）', () => {
  for (const id of htmlIds) {
    assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/, `id "${id}" 不符合规范`);
  }
});
