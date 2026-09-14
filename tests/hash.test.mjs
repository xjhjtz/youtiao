import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  sha256Hex,
  md5Hex,
  sha256Bytes,
  md5Bytes,
  utf8Bytes,
  bytesToHex,
  bytesToBase64,
  stripBase64Whitespace,
  normalizeMail,
  emailToFileName,
  isQQMail
} from '../assets/js/hash.js';

/* ------------------------------------------------------------------ *
 * 与 node:crypto 对拍：任何一位常量写错都会被这里抓住
 * ------------------------------------------------------------------ */

const SAMPLES = [
  '',
  'a',
  'abc',
  'test@example.com',
  '  John.Doe@Example.COM  ',
  '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b',
  '中文邮箱@例子.中国',
  'emoji-😀-🎉-test@example.com',
  'a'.repeat(55), // 恰好差 1 字节到 64 边界
  'a'.repeat(56), // 触发额外分组
  'a'.repeat(63),
  'a'.repeat(64),
  'a'.repeat(65),
  'a'.repeat(1000),
  'x'.repeat(100000)
];

const cryptoHash = (algo, value) => createHash(algo).update(Buffer.from(value, 'utf8')).digest('hex');

test('sha256Hex 与 node:crypto 完全一致', () => {
  for (const s of SAMPLES) {
    assert.equal(sha256Hex(s), cryptoHash('sha256', s), `sha256 不匹配: ${JSON.stringify(s.slice(0, 40))}`);
  }
});

test('md5Hex 与 node:crypto 完全一致', () => {
  for (const s of SAMPLES) {
    assert.equal(md5Hex(s), cryptoHash('md5', s), `md5 不匹配: ${JSON.stringify(s.slice(0, 40))}`);
  }
});

test('sha256Hex 输出恒为 64 位小写十六进制', () => {
  for (const s of SAMPLES) {
    const h = sha256Hex(s);
    assert.match(h, /^[0-9a-f]{64}$/);
  }
});

test('随机字符串对拍（200 组，含多字节字符与各种长度）', () => {
  const alphabet = 'abcXYZ019@.-_ 中文测试😀';
  for (let i = 0; i < 200; i++) {
    const len = Math.floor(Math.random() * 200);
    let s = '';
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    assert.equal(sha256Hex(s), cryptoHash('sha256', s));
    assert.equal(md5Hex(s), cryptoHash('md5', s));
  }
});

test('sha256Bytes / md5Bytes 处理二进制字节', () => {
  const bytes = new Uint8Array([0, 1, 2, 255, 254, 128, 64, 32]);
  assert.equal(
    bytesToHex(sha256Bytes(bytes)),
    createHash('sha256').update(Buffer.from(bytes)).digest('hex')
  );
  assert.equal(
    bytesToHex(md5Bytes(bytes)),
    createHash('md5').update(Buffer.from(bytes)).digest('hex')
  );
});

test('utf8Bytes 与 Buffer 的 utf8 编码一致', () => {
  for (const s of SAMPLES) {
    assert.deepEqual(Array.from(utf8Bytes(s)), Array.from(Buffer.from(s, 'utf8')));
  }
});

/* ------------------------------------------------------------------ *
 * base64：GitHub Contents API 的 content 字段依赖它
 * ------------------------------------------------------------------ */

test('bytesToBase64 与 node 的 base64 编码一致（含三种余数字节）', () => {
  for (let len = 0; len <= 70; len++) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff;
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `长度 ${len} 不匹配`);
  }
});

test('stripBase64Whitespace 去掉 GitHub 返回的折行', () => {
  assert.equal(stripBase64Whitespace('YWJj\nZGVm\r\n'), 'YWJjZGVm');
});

/* ------------------------------------------------------------------ *
 * Twikoo 兼容性：normalizeMail 必须与 Twikoo 源码逐字一致
 * ------------------------------------------------------------------ */

test('normalizeMail 复刻 Twikoo 的 String(e).trim().toLowerCase()', () => {
  assert.equal(normalizeMail('  John.Doe@Example.COM  '), 'john.doe@example.com');
  assert.equal(normalizeMail('TEST@EXAMPLE.COM'), 'test@example.com');
  assert.equal(normalizeMail(''), '');
  assert.equal(normalizeMail(null), '');
  assert.equal(normalizeMail(undefined), '');
  assert.equal(normalizeMail(12345), '12345');
  assert.equal(normalizeMail('\tA@B.COM\n'), 'a@b.com');
});

test('emailToFileName 默认使用 SHA-256，显式 md5 时使用 MD5', () => {
  assert.equal(emailToFileName('test@example.com'), '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b');
  assert.equal(emailToFileName('  Test@Example.com '), '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b');
  assert.equal(emailToFileName('test@example.com', 'md5'), cryptoHash('md5', 'test@example.com'));
});

test('isQQMail 复刻 Twikoo 的 QQ 邮箱识别（这些邮箱不走自定义 CDN）', () => {
  assert.equal(isQQMail('12345@qq.com'), true);
  assert.equal(isQQMail('12345'), true);
  assert.equal(isQQMail('1234'), false);
  assert.equal(isQQMail('test@example.com'), false);
  assert.equal(isQQMail('12345@QQ.COM'), true);
});
