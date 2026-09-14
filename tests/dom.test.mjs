/**
 * dom.test.mjs —— 真实启动冒烟测试（可选，需要 jsdom）。
 *
 * 前面的测试都在验证纯函数与请求逻辑，但「页面能不能真的跑起来」只有把
 * index.html + app.js 放进一个真实 DOM 里执行才能确认。
 *
 * jsdom 不是本项目的运行依赖（项目本身零依赖），未安装时这个用例会自动跳过：
 *     npm i -D jsdom
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SETTINGS = {
  owner: 'demo-user',
  repo: 'demo-avatar-bed',
  branch: 'main',
  prefix: 'avatar',
  algorithm: 'sha256',
  preset: 'jsdmirror',
  customTemplate: '',
  keepExtension: false,
  overwrite: true,
  compress: false,
  autoPurge: true,
  concurrency: 3,
  maxEdge: 512,
  commitTemplate: 'avatar: {action} {hash}',
  defaultGravatar: 'mp',
  tokenStorage: 'local'
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('把 index.html 装进 jsdom 真实加载 app.js，并模拟用户操作', async (t) => {
  let JSDOM;
  try {
    ({ JSDOM } = await import('jsdom'));
  } catch {
    t.skip('未安装 jsdom（可选依赖）：执行 npm i -D jsdom 后即可运行本用例');
    return;
  }

  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // 把 jsdom 的全局对象接到 Node 全局上，app.js 才能像在浏览器里一样运行
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  window.scrollTo = () => {}; // jsdom 未实现

  window.localStorage.setItem('youtiao.settings.v1', JSON.stringify(SETTINGS));

  const $ = (sel) => window.document.querySelector(sel);

  await import(`${pathToFileURL(join(ROOT, 'assets/js/app.js')).href}?domtest=${Date.now()}`);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await wait(60);

  // ---- 启动渲染 ----
  assert.equal($('#cdnPreset').options.length, 8, 'init 应填充 CDN 预设下拉');
  assert.equal($('#connChip').textContent, '未配置仓库', '没有令牌时应显示未配置');
  assert.equal($('#cdnBase').textContent, 'https://cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main');
  assert.equal($('#twikooValue').textContent, 'cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main');

  // ---- 输入邮箱 → 实时预览 ----
  const hash = createHash('sha256').update('test@example.com').digest('hex');
  const emailInput = $('#emailInput');
  emailInput.value = '  Test@Example.com  ';
  emailInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(250); // renderEmailPreview 有 120ms 防抖
  const preview = $('#emailPreview').textContent;
  assert.ok(preview.includes(hash), '预览应显示规范化邮箱的 SHA-256');
  assert.ok(preview.includes(`avatar/${hash}`), '预览应显示仓库内路径');
  assert.match(preview, /新头像/);

  // ---- 批量生成器 ----
  $('#bulkEmails').value = 'alice@example.com\n12345@qq.com\n';
  $('#genLinks').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(60);
  assert.equal($('#linkResult').querySelectorAll('.link-row').length, 2);
  assert.match($('#linkResult').textContent, /QQ 邮箱：Twikoo 不请求图床/);
  assert.ok($('#linkResult').textContent.includes(`/avatar/${createHash('sha256').update('alice@example.com').digest('hex')}`));

  // ---- 不兼容配置的警告 ----
  $('#prefixInput').value = 'img';
  $('#prefixInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal($('#prefixWarn').hidden, false, '目录前缀不是 avatar 时必须警告');

  $('#algorithmSelect').value = 'md5';
  $('#algorithmSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal($('#algoWarn').hidden, false, '切到 MD5 时必须警告与 Twikoo 不兼容');

  // ---- 标签页切换 ----
  $('#tabs').querySelector('[data-tab="gallery"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok($('#tab-gallery').classList.contains('active'));
  assert.ok(!$('#tab-upload').classList.contains('active'));

  dom.window.close();
});
