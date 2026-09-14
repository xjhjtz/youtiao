/**
 * serve.test.mjs —— 本地静态服务的真实 HTTP 测试。
 *
 * 这个服务是用户日常入口（cd 到目录 → 起服务 → 浏览器打开），所以它必须：
 *   - 给出正确的 MIME（.js 若不是 JS 类型，浏览器会拒绝执行 ES 模块，页面直接白给）
 *   - 不缓存（改完代码刷新就能看到）
 *   - 不允许越界读取站点目录之外的文件
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStaticServer, contentTypeOf, listenWithFallback } from '../serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 用原生 http 发请求，避免 fetch 把 `..` 之类的路径提前规范化掉。 */
function rawRequest(port, path, method = 'GET') {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolvePromise({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer(root) {
  const server = createStaticServer(root);
  const port = await listenWithFallback(server, { host: '127.0.0.1', port: 0 });
  return { server, port, close: () => new Promise((r) => server.close(r)) };
}

test('MIME 映射：.js 必须是 JS 类型，否则 ES 模块会被浏览器拒绝', () => {
  assert.match(contentTypeOf('/x/app.js'), /text\/javascript/);
  assert.match(contentTypeOf('/x/app.mjs'), /text\/javascript/);
  assert.match(contentTypeOf('/x/index.HTML'), /text\/html/);
  assert.match(contentTypeOf('/x/style.css'), /text\/css/);
  assert.match(contentTypeOf('/x/data.json'), /application\/json/);
  assert.match(contentTypeOf('/x/a.webp'), /image\/webp/);
  assert.equal(contentTypeOf('/x/unknown.bin'), 'application/octet-stream');
});

test('真实 HTTP：首页、JS、CSS 都能正确返回且不缓存', async (t) => {
  const { port, close } = await startServer(ROOT);
  t.after(close);

  const home = await rawRequest(port, '/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /text\/html/);
  assert.match(home.body, /油条/);
  assert.match(home.headers['cache-control'], /no-store/);

  const js = await rawRequest(port, '/assets/js/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /text\/javascript/, '.js 的 Content-Type 必须是 JS 类型');

  const css = await rawRequest(port, '/assets/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const worker = await rawRequest(port, '/extras/cloudflare-worker.js');
  assert.equal(worker.status, 200);
});

test('HEAD 无响应体，POST 被拒绝', async (t) => {
  const { port, close } = await startServer(ROOT);
  t.after(close);

  const head = await rawRequest(port, '/index.html', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.ok(Number(head.headers['content-length']) > 0, 'HEAD 仍应给出 Content-Length');

  const post = await rawRequest(port, '/index.html', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('不存在路径返回 404，目录下没有 index.html 也返回 404', async (t) => {
  const { port, close } = await startServer(ROOT);
  t.after(close);

  assert.equal((await rawRequest(port, '/nope-does-not-exist.js')).status, 404);
  // /assets 是目录，没有 index.html
  assert.equal((await rawRequest(port, '/assets')).status, 404);
});

test('目录穿越：不能读到站点目录之外的文件', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'youtiao-serve-'));
  const site = join(base, 'site');
  await mkdir(join(site, 'assets'), { recursive: true });
  await writeFile(join(site, 'index.html'), '<h1>site</h1>');
  await writeFile(join(site, 'assets', 'a.js'), 'console.log(1)');
  // 放在站点目录「外面」的敏感文件
  await writeFile(join(base, 'secret.txt'), 'TOP-SECRET');

  const { port, close } = await startServer(site);
  t.after(async () => {
    await close();
    await rm(base, { recursive: true, force: true });
  });

  const inside = await rawRequest(port, '/assets/a.js');
  assert.equal(inside.status, 200, '站点内的文件要能读到');

  const attacks = [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/....//secret.txt'
  ];
  for (const path of attacks) {
    const res = await rawRequest(port, path);
    assert.notEqual(res.status, 200, `穿越路径 ${path} 竟然返回了 200`);
    assert.ok(!res.body.includes('TOP-SECRET'), `穿越路径 ${path} 泄漏了站点外的文件内容`);
  }
});

test('URL 编码损坏时返回 400 而不是崩溃', async (t) => {
  const { port, close } = await startServer(ROOT);
  t.after(close);

  const res = await rawRequest(port, '/%E0%A4%A');
  assert.equal(res.status, 400);
});

test('端口被占用时自动顺延到下一个可用端口', async (t) => {
  const first = await startServer(ROOT);
  t.after(first.close);

  const second = createStaticServer(ROOT);
  const secondPort = await listenWithFallback(second, { host: '127.0.0.1', port: first.port });
  t.after(() => new Promise((r) => second.close(r)));

  assert.equal(secondPort, first.port + 1, '应当顺延而不是直接失败');
  assert.equal((await rawRequest(secondPort, '/index.html')).status, 200);
});
