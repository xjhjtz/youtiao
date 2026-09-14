import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  humanSize,
  fmtDateTime,
  escapeHtml,
  truncateMiddle,
  pageSlice,
  pageNumbers,
  toCsv,
  toMarkdown,
  toPlainLinks,
  uniqueBy,
  safeFileName
} from '../assets/js/format.js';

test('humanSize 覆盖各量级与异常输入', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(512), '512 B');
  assert.equal(humanSize(1024), '1.0 KB');
  assert.equal(humanSize(1536), '1.5 KB');
  assert.equal(humanSize(1024 * 1024), '1.0 MB');
  assert.equal(humanSize(5 * 1024 * 1024 * 1024), '5.0 GB');
  assert.equal(humanSize(-1), '—');
  assert.equal(humanSize('abc'), '—');
  assert.equal(humanSize(undefined), '—');
});

test('fmtDateTime 处理合法与非法时间戳', () => {
  const ts = new Date(2026, 0, 2, 3, 4).getTime();
  assert.equal(fmtDateTime(ts), '2026-01-02 03:04');
  assert.equal(fmtDateTime('nope'), '—');
});

test('escapeHtml 阻断标签与属性注入', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
  assert.equal(escapeHtml(null), '');
});

test('truncateMiddle 保留头尾', () => {
  assert.equal(truncateMiddle('abcdefghij', 3, 2), 'abc…ij');
  assert.equal(truncateMiddle('abc', 3, 2), 'abc');
  assert.equal(truncateMiddle(''), '');
});

test('pageSlice 正确分页并夹紧页码', () => {
  const list = Array.from({ length: 25 }, (_, i) => i);
  const p1 = pageSlice(list, 1, 10);
  assert.deepEqual(p1.items, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.start, 0);

  const p3 = pageSlice(list, 3, 10);
  assert.deepEqual(p3.items, [20, 21, 22, 23, 24]);

  assert.equal(pageSlice(list, 99, 10).page, 3, '页码超界要夹到最后一页');
  assert.equal(pageSlice(list, 0, 10).page, 1, '页码小于 1 要夹到第一页');
  assert.equal(pageSlice([], 1, 10).totalPages, 1, '空列表也要有 1 页');
  assert.equal(pageSlice(list, 1, 0).size, 24, '非法每页数量回落到 24');
});

test('pageNumbers 首尾齐全并用省略号压缩中间', () => {
  assert.deepEqual(pageNumbers(1, 1), [1]);
  assert.deepEqual(pageNumbers(1, 3), [1, 2, 3]);
  assert.deepEqual(pageNumbers(1, 10), [1, 2, '…', 10]);
  assert.deepEqual(pageNumbers(5, 10), [1, '…', 4, 5, 6, '…', 10]);
  assert.deepEqual(pageNumbers(10, 10), [1, '…', 9, 10]);
});

test('toCsv 转义引号逗号换行并加 BOM', () => {
  const csv = toCsv([['a,b', 'c"d', 'e\nf'], ['plain', 1, true]], ['x', 'y', 'z']);
  assert.ok(csv.startsWith('\uFEFF'), '必须带 BOM，否则 Excel 打开中文乱码');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'x,y,z');
  assert.equal(lines[1], '"a,b","c""d","e\nf"');
  assert.equal(lines[2], 'plain,1,true');
});

test('toCsv 支持对象数组（按表头取值）', () => {
  const csv = toCsv([{ a: 1, b: 2 }], ['a', 'b']);
  assert.equal(csv.slice(1), 'a,b\r\n1,2');
});

test('toMarkdown / toPlainLinks 生成可直接粘贴的内容', () => {
  const entries = [
    { email: 'a@b.com', url: 'https://cdn/avatar/1' },
    { name: 'deadbeef', url: 'https://cdn/avatar/2' }
  ];
  assert.equal(toMarkdown(entries), '![a@b.com](https://cdn/avatar/1)\n![deadbeef](https://cdn/avatar/2)');
  assert.equal(toPlainLinks(entries), 'https://cdn/avatar/1\nhttps://cdn/avatar/2');
  assert.equal(toMarkdown([]), '');
});

test('uniqueBy 保留首次出现并去重', () => {
  const list = [{ h: 'a', v: 1 }, { h: 'b', v: 2 }, { h: 'a', v: 3 }];
  assert.deepEqual(uniqueBy(list, (x) => x.h), [{ h: 'a', v: 1 }, { h: 'b', v: 2 }]);
});

test('safeFileName 去掉路径非法字符', () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeFileName(''), '');
});
