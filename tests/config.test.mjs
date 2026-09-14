/**
 * config.test.mjs —— 存储键迁移的单元测试。
 *
 * 项目改过名（GitAvatar → 油条），存储键前缀也随之从 `gh-avatar-bed` 换成 `youtiao`。
 * 这段迁移代码很不起眼，但一旦写错，用户浏览器里保存的 GitHub 令牌就会「凭空消失」，
 * 而且不会有任何报错。所以用一个假 Storage 把它钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrateStorageKey, SETTINGS_KEY, TOKEN_KEY, THEME_KEY } from '../assets/js/config.js';

/** 最小可用的假 Storage。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() {
      return map.size;
    },
    dump: () => Object.fromEntries(map)
  };
}

test('旧键里的内容会被搬到新键，并且旧键被清掉', () => {
  const storage = fakeStorage({ 'gh-avatar-bed.token.v1': 'ghp_old_token' });
  migrateStorageKey(storage, TOKEN_KEY, 'token.v1');

  assert.equal(storage.getItem(TOKEN_KEY), 'ghp_old_token', '旧令牌必须被迁移过来');
  assert.equal(storage.getItem('gh-avatar-bed.token.v1'), null, '旧键必须被删除');
});

test('新键已有内容时不覆盖，但仍然清掉旧键', () => {
  const storage = fakeStorage({
    'gh-avatar-bed.token.v1': 'ghp_old',
    [TOKEN_KEY]: 'ghp_new'
  });
  migrateStorageKey(storage, TOKEN_KEY, 'token.v1');

  assert.equal(storage.getItem(TOKEN_KEY), 'ghp_new', '新键优先，不能被旧值覆盖');
  assert.equal(storage.getItem('gh-avatar-bed.token.v1'), null);
});

test('没有旧数据时不会凭空造出一个新键', () => {
  const storage = fakeStorage();
  migrateStorageKey(storage, TOKEN_KEY, 'token.v1');
  assert.deepEqual(storage.dump(), {}, '什么都不该写入');
});

test('设置 / 主题键都按各自的后缀迁移，互不串台', () => {
  const storage = fakeStorage({
    'gh-avatar-bed.settings.v1': '{"owner":"demo-user"}',
    'gh-avatar-bed.theme.v1': 'dark',
    'gh-avatar-bed.history.v1': '[]'
  });
  migrateStorageKey(storage, SETTINGS_KEY, 'settings.v1');
  migrateStorageKey(storage, THEME_KEY, 'theme.v1');

  assert.equal(storage.getItem(SETTINGS_KEY), '{"owner":"demo-user"}');
  assert.equal(storage.getItem(THEME_KEY), 'dark');
  // history 有自己的迁移调用，这里没搬它，就不该被动过
  assert.equal(storage.getItem('gh-avatar-bed.history.v1'), '[]');
});

test('storage 不可用（隐私模式）或参数缺失时静默跳过，不抛错', () => {
  const throwing = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    }
  };
  assert.doesNotThrow(() => migrateStorageKey(throwing, TOKEN_KEY, 'token.v1'));
  assert.doesNotThrow(() => migrateStorageKey(null, TOKEN_KEY, 'token.v1'));
  assert.doesNotThrow(() => migrateStorageKey(undefined, TOKEN_KEY, 'token.v1'));
  assert.doesNotThrow(() => migrateStorageKey(fakeStorage(), TOKEN_KEY, ''));
});
