/**
 * notes-sync.test.mjs —— 备注远程同步的行为测试。
 *
 * 用假客户端模拟 GitHub 仓库，重点验证：
 *   - 第一次同步是「创建文件」而不是报 422
 *   - 推送前会把远程已有的备注合并进来（别的设备写的不能丢）
 *   - 遇到 sha 冲突会合并后重试一次
 *   - 关掉开关后一个请求都不发
 *
 * notes.js 通过 localStorage 存本地文档，所以这里先给它塞一个假的 localStorage。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Node 25 的 globalThis.localStorage 可能是只读的（--experimental-webstorage），必须 defineProperty
const memory = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
    clear: () => memory.clear()
  }
});

const { NotesSync, resolveNotesTarget } = await import('../assets/js/notes-sync.js');
const { loadNotesDoc, saveNotesDoc, upsertEntries, emptyDoc, serializeDoc, NOTES_KEY } = await import('../assets/js/notes.js');
const { GitHubError } = await import('../assets/js/github.js');
const { base64ToText } = await import('../assets/js/hash.js');

const SETTINGS = {
  token: 't0ken',
  owner: 'demo-user',
  repo: 'demo-avatar-bed',
  branch: 'main',
  notesEnabled: true,
  notesPath: '.youtiao/notes.json',
  notesRepo: ''
};

const entry = (hash, email, ts) => ({ hash, email, ts, path: `avatar/${hash}` });

/** 内存里的假 GitHub 仓库。 */
function fakeClient(options = {}) {
  let remote = options.initialRemote || null;
  let seq = 0;
  let failNextPutWith = null;

  return {
    calls: [],
    get remote() {
      return remote;
    },
    get remoteDoc() {
      return remote ? JSON.parse(remote.text) : null;
    },
    seed(text) {
      remote = { text, sha: `sha-${++seq}` };
    },
    failNextPut(error) {
      failNextPutWith = error;
    },
    async getFileText(path) {
      this.calls.push({ op: 'get', path });
      return remote ? { text: remote.text, sha: remote.sha, size: remote.text.length } : null;
    },
    async putFile(path, base64Content, putOptions = {}) {
      this.calls.push({ op: 'put', path, options: putOptions });
      if (failNextPutWith) {
        const error = failNextPutWith;
        failNextPutWith = null;
        throw error;
      }
      // 模拟 GitHub 的 sha 校验
      if (remote && putOptions.sha !== remote.sha) {
        throw new GitHubError('sha 不匹配', { status: 409, body: { message: "sha doesn't match" } });
      }
      if (!remote && putOptions.sha) {
        throw new GitHubError('文件不存在', { status: 404 });
      }
      remote = { text: base64ToText(base64Content), sha: `sha-${++seq}` };
      return { created: !putOptions.sha, updated: Boolean(putOptions.sha), skipped: false, path, sha: remote.sha };
    }
  };
}

function makeSync(client, settings = SETTINGS) {
  const applied = [];
  const statuses = [];
  const sync = new NotesSync({
    getSettings: () => settings,
    createClient: () => client,
    onApplied: (doc, info) => applied.push({ doc, info }),
    onStatus: (s) => statuses.push(s),
    debounceMs: 5
  });
  return { sync, applied, statuses };
}

beforeEach(() => {
  memory.clear();
});

/* ------------------------------- 开关 ------------------------------- */

test('关掉同步后不产生任何请求', async () => {
  const client = fakeClient();
  const { sync } = makeSync(client, { ...SETTINGS, notesEnabled: false });
  assert.equal(sync.enabled, false);

  const pushed = await sync.push();
  const pulled = await sync.pull({ force: true });
  assert.equal(pushed.pushed, false);
  assert.equal(pushed.reason, 'disabled');
  assert.equal(pulled.pulled, false);
  assert.equal(client.calls.length, 0, '关闭状态下不该发任何请求');
});

test('没有令牌或仓库信息时视为不可用', () => {
  const client = fakeClient();
  assert.equal(makeSync(client, { ...SETTINGS, token: '' }).sync.enabled, false);
  assert.equal(makeSync(client, { ...SETTINGS, owner: '' }).sync.enabled, false);
  assert.equal(makeSync(client, { ...SETTINGS, notesRepo: '格式错误' }).sync.enabled, false, '备注仓库格式错时应视为不可用');
});

/* ------------------------------ 第一次推送 ------------------------------ */

test('第一次推送是创建文件：不带 sha，路径与提交信息正确', async () => {
  const client = fakeClient();
  const { sync } = makeSync(client);
  saveNotesDoc(upsertEntries(emptyDoc(), [entry('a', 'a@b.com', 0)], 100));

  const result = await sync.push();
  assert.equal(result.pushed, true);
  assert.equal(result.path, '.youtiao/notes.json');

  const put = client.calls.find((c) => c.op === 'put');
  assert.ok(put, '必须发出 PUT');
  assert.equal(put.options.sha, undefined, '新建文件不能带 sha，否则 GitHub 会 404/422');
  assert.match(put.options.message, /备注/);
  assert.equal(client.remoteDoc.entries.length, 1);
  assert.equal(client.remoteDoc.entries[0].email, 'a@b.com');
});

/* --------------------------- 合并远程已有数据 --------------------------- */

test('推送前会先合并远程，别的设备写的备注不会被覆盖掉', async () => {
  const client = fakeClient();
  client.seed(serializeDoc(upsertEntries(emptyDoc(), [entry('remote', 'other@x.com', 500)], 500)));

  const { sync, applied } = makeSync(client);
  saveNotesDoc(upsertEntries(emptyDoc(), [entry('local', 'me@x.com', 100)], 100));

  await sync.push();

  const hashes = client.remoteDoc.entries.map((e) => e.hash).sort();
  assert.deepEqual(hashes, ['local', 'remote'], '两边的备注都要在文件里');
  assert.ok(applied.length > 0, '合并后应通知界面刷新');
  assert.equal(loadNotesDoc().entries.length, 2, '本地缓存也要更新');
});

test('冲突（sha 不匹配）时合并后重试一次', async () => {
  const client = fakeClient();
  const { sync } = makeSync(client);
  saveNotesDoc(upsertEntries(emptyDoc(), [entry('a', 'a@b.com', 100)], 100));

  // 第一次 PUT 之前远程被别的设备改了 → 模拟成 sha 冲突
  client.failNextPut(new GitHubError('冲突', { status: 409, body: { message: "sha doesn't match" } }));

  const result = await sync.push();
  assert.equal(result.pushed, true);
  assert.equal(result.mergedConflict, true);
  const puts = client.calls.filter((c) => c.op === 'put');
  assert.equal(puts.length, 2, '应当重试一次');
  assert.equal(client.remoteDoc.entries.length, 1);
});

test('冲突重试也失败时给出错误状态，而不是静默丢弃', async () => {
  const client = fakeClient();
  const { sync } = makeSync(client);
  saveNotesDoc(upsertEntries(emptyDoc(), [entry('a', 'a@b.com', 100)], 100));

  client.failNextPut(new GitHubError('冲突', { status: 409 }));
  client.failNextPut(new GitHubError('还是不行', { status: 500 }));

  const result = await sync.push();
  assert.equal(result.pushed, false);
  assert.equal(sync.state, 'error');
  assert.match(sync.error, /还是不行/);
});

/* -------------------------------- 拉取 -------------------------------- */

test('pull 把远程备注合并进本地并回调', async () => {
  const client = fakeClient();
  client.seed(serializeDoc(upsertEntries(emptyDoc(), [entry('r', 'remote@x.com', 900)], 900)));
  const { sync, applied } = makeSync(client);

  const result = await sync.pull({ force: true });
  assert.equal(result.pulled, true);
  assert.equal(result.remoteExists, true);
  assert.equal(loadNotesDoc().entries[0].email, 'remote@x.com');
  assert.equal(applied[0].info.source, 'remote');
});

test('远程文件不存在时 pull 不算失败', async () => {
  const client = fakeClient();
  const { sync } = makeSync(client);
  const result = await sync.pull({ force: true });
  assert.equal(result.pulled, true);
  assert.equal(result.remoteExists, false);
  assert.equal(sync.state, 'idle');
});

test('短时间内的重复 pull 会复用结果，避免每次刷新都打 API', async () => {
  const client = fakeClient();
  const { sync } = makeSync(client);
  await sync.pull({ force: true });
  const callsAfterFirst = client.calls.length;

  const second = await sync.pull();
  assert.equal(second.reason, 'fresh');
  assert.equal(client.calls.length, callsAfterFirst, '不该再发请求');

  await sync.pull({ force: true });
  assert.ok(client.calls.length > callsAfterFirst, 'force 时应强制请求');
});

/* ------------------------------- 防抖与重置 ------------------------------- */

test('schedule 是防抖的：连续多次改动只推一次', async () => {
  const client = fakeClient();
  const { sync } = makeSync(client);
  saveNotesDoc(upsertEntries(emptyDoc(), [entry('a', 'a@b.com', 1)], 1));

  sync.schedule();
  sync.schedule();
  sync.schedule();
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(client.calls.filter((c) => c.op === 'put').length, 1);
});

test('reset 清掉缓存的 sha，下次推送会重新读远程', async () => {
  const client = fakeClient();
  const { sync } = makeSync(client);
  saveNotesDoc(upsertEntries(emptyDoc(), [entry('a', 'a@b.com', 1)], 1));
  await sync.push();
  const getsBefore = client.calls.filter((c) => c.op === 'get').length;

  sync.reset();
  await sync.push();
  assert.ok(client.calls.filter((c) => c.op === 'get').length > getsBefore, 'reset 后应重新读远程 sha');
});

/* ---------------------------- 目标解析（回归） ---------------------------- */

test('默认写入图床仓库的 .youtiao/notes.json', () => {
  const target = resolveNotesTarget(SETTINGS);
  assert.equal(target.path, '.youtiao/notes.json');
  assert.equal(target.repo, 'demo-avatar-bed');
  assert.equal(target.separate, false);
});

test('指定独立仓库时写到那个仓库，路径不变', async () => {
  const client = fakeClient();
  const settings = { ...SETTINGS, notesRepo: 'demo-user/youtiao-notes' };
  const { sync } = makeSync(client, settings);
  saveNotesDoc(upsertEntries(emptyDoc(), [entry('a', 'a@b.com', 1)], 1));
  await sync.push();

  const put = client.calls.find((c) => c.op === 'put');
  assert.equal(put.path, '.youtiao/notes.json');
  assert.equal(resolveNotesTarget(settings).repo, 'youtiao-notes');
});

test('本地文档的存储键仍是 youtiao.notes.v1（改名迁移后的键）', () => {
  saveNotesDoc(upsertEntries(emptyDoc(), [entry('a', 'a@b.com', 1)], 1));
  assert.ok(memory.has(NOTES_KEY), `应当写入 ${NOTES_KEY}`);
});
