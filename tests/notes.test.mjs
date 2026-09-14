/**
 * notes.test.mjs —— 备注文档模型的单元测试。
 *
 * 这块逻辑的价值全在「合并」上：本地和远程各有一份文档，谁新听谁的，删除不能复活。
 * 写错了不会报错，只会静默丢备注或把删掉的备注变回来 —— 所以必须钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyDoc,
  normalizeDoc,
  mergeDocs,
  upsertEntries,
  tombstoneEntries,
  entriesOf,
  notesIndex,
  annotateFiles,
  serializeDoc,
  DEFAULT_NOTES_PATH,
  NOTES_VERSION
} from '../assets/js/notes.js';

import { resolveNotesTarget, isNotesPublicInBedRepo } from '../assets/js/notes-sync.js';

const entry = (hash, email, ts, extra = {}) => ({ hash, email, ts, path: `avatar/${hash}`, ...extra });

/* ---------------------------- 文档归一化 ---------------------------- */

test('normalizeDoc 接受文档 / 数组（旧版形态）/ JSON 字符串 / 空值', () => {
  const doc = { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', entries: [entry('a', 'a@b.com', 1)], removed: {} };
  assert.equal(normalizeDoc(doc).entries.length, 1);
  assert.equal(normalizeDoc([entry('a', 'a@b.com', 1)]).entries.length, 1, '旧版数组形态要能读');
  assert.equal(normalizeDoc(JSON.stringify([entry('a', 'a@b.com', 1)])).entries.length, 1);
  assert.equal(normalizeDoc(null).entries.length, 0);
  assert.equal(normalizeDoc('不是 JSON{{{').entries.length, 0, '坏 JSON 不能抛错');
  assert.equal(normalizeDoc(undefined).version, NOTES_VERSION);
});

test('normalizeDoc 丢弃缺字段的脏数据，并规整墓碑时间', () => {
  const doc = normalizeDoc({
    entries: [entry('a', 'a@b.com', 1), { hash: 'b' }, { email: 'x@y.com' }, null, 'string'],
    removed: { good: '123', bad: 'abc', '': 5 }
  });
  assert.equal(doc.entries.length, 1);
  assert.deepEqual(doc.removed, { good: 123 });
});

/* ------------------------------ 增删改 ------------------------------ */

test('upsertEntries 按哈希去重、更新 ts、保留 firstTs', () => {
  let doc = emptyDoc();
  doc = upsertEntries(doc, [entry('a', 'a@b.com', 0)], 100);
  assert.equal(doc.entries[0].ts, 100);
  assert.equal(doc.entries[0].firstTs, 100);

  doc = upsertEntries(doc, [entry('a', 'a@b.com', 0, { note: '第二次' })], 200);
  assert.equal(doc.entries.length, 1, '同一邮箱重复上传只应有一条备注');
  assert.equal(doc.entries[0].ts, 200);
  assert.equal(doc.entries[0].firstTs, 100, 'firstTs 不该被后续更新覆盖');
  assert.equal(doc.entries[0].note, '第二次');
});

test('upsertEntries 会撤销同名墓碑（删了又加回来）', () => {
  let doc = emptyDoc();
  doc = tombstoneEntries(doc, ['a'], 100);
  assert.equal(doc.removed.a, 100);
  doc = upsertEntries(doc, [entry('a', 'a@b.com', 0)], 200);
  assert.equal(doc.removed.a, undefined, '重新添加应清掉墓碑');
  assert.equal(doc.entries.length, 1);
});

test('tombstoneEntries 删除记录并留下删除时间', () => {
  let doc = upsertEntries(emptyDoc(), [entry('a', 'a@b.com', 0), entry('b', 'b@c.com', 0)], 50);
  doc = tombstoneEntries(doc, ['a'], 99);
  assert.deepEqual(doc.entries.map((e) => e.hash), ['b']);
  assert.equal(doc.removed.a, 99);
});

/* ------------------------------- 合并 ------------------------------- */

test('mergeDocs 取时间更新的那条记录', () => {
  const local = { entries: [entry('a', 'old@b.com', 100)] };
  const remote = { entries: [entry('a', 'new@b.com', 200)] };
  const merged = mergeDocs(local, remote);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].email, 'new@b.com');

  const reversed = mergeDocs(remote, local);
  assert.equal(reversed.entries[0].email, 'new@b.com', '合并结果不应依赖参数顺序');
});

test('mergeDocs 是并集：两边的独有记录都保留', () => {
  const merged = mergeDocs({ entries: [entry('a', 'a@b.com', 1)] }, { entries: [entry('b', 'b@c.com', 2)] });
  assert.deepEqual(merged.entries.map((e) => e.hash).sort(), ['a', 'b']);
});

test('mergeDocs：删除不会被远程旧数据复活（墓碑机制）', () => {
  // 本地在 ts=300 删掉了 a，远程还有一条 ts=100 的 a
  const local = tombstoneEntries(upsertEntries(emptyDoc(), [entry('a', 'a@b.com', 0)], 100), ['a'], 300);
  const remote = { entries: [entry('a', 'a@b.com', 100)] };
  const merged = mergeDocs(local, remote);
  assert.deepEqual(merged.entries, [], '已删除的备注不能因为远程还有就复活');
  assert.equal(merged.removed.a, 300);
});

test('mergeDocs：删除后又被重新添加（时间更新）则应当保留', () => {
  const local = tombstoneEntries(upsertEntries(emptyDoc(), [entry('a', 'a@b.com', 0)], 100), ['a'], 300);
  const remote = { entries: [entry('a', 'a@b.com', 400)] };
  const merged = mergeDocs(local, remote);
  assert.equal(merged.entries.length, 1, 'ts=400 的新记录晚于 ts=300 的删除，属于重新添加');
  assert.equal(merged.entries[0].hash, 'a');
});

test('mergeDocs 对空文档 / 脏文档都安全', () => {
  assert.deepEqual(mergeDocs(null, null).entries, []);
  assert.equal(mergeDocs(emptyDoc(), { entries: [entry('a', 'a@b.com', 1)] }).entries.length, 1);
});

/* --------------------------- 序列化与索引 --------------------------- */

test('serializeDoc 输出稳定、可解析、带结尾换行', () => {
  const doc = upsertEntries(emptyDoc(), [entry('b', 'b@c.com', 0), entry('a', 'a@b.com', 0)], 10);
  const text = serializeDoc(doc);
  assert.ok(text.endsWith('\n'), '文件末尾应有换行，便于 Git diff');
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, NOTES_VERSION);
  assert.equal(parsed.entries.length, 2);
  assert.equal(text, serializeDoc(normalizeDoc(text)), '序列化应当是幂等的');
});

test('notesIndex / annotateFiles 用哈希与路径都能命中', () => {
  const entries = [entry('a', 'a@b.com', 1)];
  const index = notesIndex(entries);
  const files = [
    { name: 'a', path: 'avatar/a', sha: 'x', size: 1 },
    { name: 'zzz', path: 'avatar/zzz', sha: 'y', size: 2 }
  ];
  const annotated = annotateFiles(files, index);
  assert.equal(annotated[0].email, 'a@b.com');
  assert.equal(annotated[1].email, '');
});

test('entriesOf 只返回记录数组', () => {
  assert.deepEqual(entriesOf({ entries: [entry('a', 'a@b.com', 1)], removed: { b: 1 } }).length, 1);
  assert.deepEqual(entriesOf(null), []);
});

/* ------------------------- 备注文件放哪里 ------------------------- */

test('resolveNotesTarget：默认与图床同仓库，路径放在 avatar/ 之外', () => {
  const target = resolveNotesTarget({ owner: 'demo-user', repo: 'bed', branch: 'main' });
  assert.equal(target.owner, 'demo-user');
  assert.equal(target.repo, 'bed');
  assert.equal(target.branch, 'main');
  assert.equal(target.path, DEFAULT_NOTES_PATH);
  assert.equal(target.separate, false);
  assert.ok(!target.path.startsWith('avatar/'), '备注文件不能落在图库目录里，否则会被当成头像');
});

test('resolveNotesTarget 支持 owner/repo 与 owner/repo@branch', () => {
  const a = resolveNotesTarget({ owner: 'me', repo: 'bed', branch: 'main', notesRepo: 'me/private-notes' });
  assert.deepEqual([a.owner, a.repo, a.branch, a.separate], ['me', 'private-notes', 'main', true]);

  const b = resolveNotesTarget({ owner: 'me', repo: 'bed', branch: 'main', notesRepo: 'me/private-notes@dev' });
  assert.deepEqual([b.owner, b.repo, b.branch], ['me', 'private-notes', 'dev']);
});

test('resolveNotesTarget 对格式错误给出可读报错，而不是静默乱写', () => {
  const bad = resolveNotesTarget({ owner: 'me', repo: 'bed', notesRepo: '只有一段没有斜杠' });
  assert.match(bad.error, /owner\/repo/);
});

test('自定义备注路径会被去掉首部斜杠', () => {
  assert.equal(resolveNotesTarget({ owner: 'a', repo: 'b', notesPath: '/notes/x.json' }).path, 'notes/x.json');
  assert.equal(resolveNotesTarget({ owner: 'a', repo: 'b', notesPath: '' }).path, DEFAULT_NOTES_PATH);
});

test('isNotesPublicInBedRepo 用于判断邮箱是否会公开在图床仓库里', () => {
  assert.equal(isNotesPublicInBedRepo({ owner: 'a', repo: 'b' }), true, '同仓库 = 公开仓库 = 邮箱会公开');
  assert.equal(isNotesPublicInBedRepo({ owner: 'a', repo: 'b', notesRepo: 'a/private' }), false, '独立仓库（可以是私有的）');
});
