import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  normalizePrefix,
  buildRepoPath,
  fileNameOf,
  prefixOf,
  isUnderPrefix,
  extensionOf,
  stripExtension,
  emailFromFileName,
  looksLikeEmail,
  looksLikeHashName,
  TWIKOO_DIR
} from '../assets/js/paths.js';

import {
  CDN_PRESETS,
  buildCdnBase,
  buildFileUrl,
  buildAvatarUrl,
  buildTwikooRequestUrl,
  buildPurgeUrl,
  isPurgeable,
  purgeSupport,
  toTwikooValue,
  joinUrl,
  applyTemplate,
  describeEmail,
  describeEmails,
  getPreset,
  PURGE_ENDPOINT
} from '../assets/js/cdn.js';

const CFG = {
  owner: 'demo-user',
  repo: 'demo-avatar-bed',
  branch: 'main',
  prefix: 'avatar',
  preset: 'jsdmirror'
};

/* ---------------------------- 路径规则 ---------------------------- */

test('normalizePrefix 去掉首尾斜杠、归一化重复斜杠，默认 avatar', () => {
  assert.equal(normalizePrefix(undefined), TWIKOO_DIR);
  assert.equal(normalizePrefix(null), TWIKOO_DIR);
  assert.equal(normalizePrefix(''), '');
  assert.equal(normalizePrefix('  /avatar/  '), 'avatar');
  assert.equal(normalizePrefix('//a//b//'), 'a/b');
  assert.equal(normalizePrefix('\\avatar\\'), 'avatar');
});

test('buildRepoPath 生成 avatar/<hash>，且默认不带扩展名', () => {
  const hash = 'a'.repeat(64);
  assert.equal(buildRepoPath(hash, { prefix: 'avatar' }), `avatar/${hash}`);
  assert.equal(buildRepoPath(hash, { prefix: '' }), hash);
  assert.equal(buildRepoPath(hash, { prefix: '/avatar/' }), `avatar/${hash}`);
  assert.equal(buildRepoPath(hash, { prefix: 'avatar', keepExtension: true, extension: 'PNG' }), `avatar/${hash}.png`);
  assert.equal(buildRepoPath(hash, { prefix: 'avatar', keepExtension: false, extension: 'png' }), `avatar/${hash}`);
});

test('路径拆分与判断工具', () => {
  assert.equal(fileNameOf('avatar/abc'), 'abc');
  assert.equal(fileNameOf('abc'), 'abc');
  assert.equal(prefixOf('avatar/abc'), 'avatar');
  assert.equal(prefixOf('abc'), '');
  assert.equal(isUnderPrefix('avatar/abc', 'avatar'), true);
  assert.equal(isUnderPrefix('avatar', 'avatar'), false);
  assert.equal(isUnderPrefix('other/abc', 'avatar'), false);
  assert.equal(isUnderPrefix('anything', ''), true);
  assert.equal(extensionOf('a.png'), 'png');
  assert.equal(extensionOf('a'), '');
  assert.equal(extensionOf('.gitignore'), '');
  assert.equal(stripExtension('a.png'), 'a');
  assert.equal(stripExtension('a@b.com.png'), 'a@b.com');
  // 通用工具会剥掉最后一个点后的内容，所以 `a@b.com` → `a@b` 是预期行为；
  // 真正用于「文件名即邮箱」的 emailFromFileName 只剥图片扩展名，不会踩这个坑。
  assert.equal(stripExtension('a@b.com'), 'a@b');
  assert.equal(stripExtension('noext'), 'noext');
  assert.equal(emailFromFileName(' a@b.com .PNG '), 'a@b.com');
  assert.equal(emailFromFileName('a@b.com'), 'a@b.com', '没有图片扩展名时不能把 .com 当扩展名剥掉');
  assert.equal(emailFromFileName('user@mail.example.co.uk.jpeg'), 'user@mail.example.co.uk');
  assert.equal(emailFromFileName('12345@qq.com'), '12345@qq.com');
  assert.equal(looksLikeEmail('a@b.com'), true);
  assert.equal(looksLikeEmail('nope'), false);
  assert.equal(looksLikeHashName('a'.repeat(64)), true);
  assert.equal(looksLikeHashName('a'.repeat(32)), true);
  assert.equal(looksLikeHashName('a'.repeat(63)), false);
});

/* ---------------------------- CDN 构建 ---------------------------- */

test('joinUrl 不产生重复斜杠', () => {
  assert.equal(joinUrl('https://a.com/', '/gh/x/', 'avatar/', 'h'), 'https://a.com/gh/x/avatar/h');
  assert.equal(joinUrl('https://a.com'), 'https://a.com');
});

test('每个内置预设都能生成正确的基址', () => {
  assert.equal(buildCdnBase({ ...CFG, preset: 'jsdelivr' }), 'https://cdn.jsdelivr.net/gh/demo-user/demo-avatar-bed@main');
  assert.equal(buildCdnBase({ ...CFG, preset: 'jsdmirror' }), 'https://cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main');
  assert.equal(buildCdnBase({ ...CFG, preset: 'gcore' }), 'https://gcore.jsdelivr.net/gh/demo-user/demo-avatar-bed@main');
  assert.equal(buildCdnBase({ ...CFG, preset: 'statically' }), 'https://cdn.statically.io/gh/demo-user/demo-avatar-bed/main');
  assert.equal(buildCdnBase({ ...CFG, preset: 'raw' }), 'https://raw.githubusercontent.com/demo-user/demo-avatar-bed/main');
  assert.equal(buildCdnBase({ ...CFG, preset: 'pages' }), 'https://demo-user.github.io/demo-avatar-bed');
  assert.equal(
    buildCdnBase({ ...CFG, preset: 'ghproxy' }),
    'https://ghproxy.net/https://raw.githubusercontent.com/demo-user/demo-avatar-bed/main'
  );
});

test('分支缺省时回落 main，信息不全时返回空串', () => {
  assert.equal(buildCdnBase({ owner: 'a', repo: 'b', branch: '', preset: 'jsdelivr' }), 'https://cdn.jsdelivr.net/gh/a/b@main');
  assert.equal(buildCdnBase({ owner: '', repo: 'b', preset: 'jsdelivr' }), '');
  assert.equal(buildCdnBase({ owner: 'a', repo: '', preset: 'jsdelivr' }), '');
  assert.equal(buildCdnBase({ ...CFG, preset: 'custom', customTemplate: '' }), '');
});

test('自定义模板替换占位符', () => {
  const tpl = 'https://img.example.com/{owner}/{repo}@{branch}/{path}';
  // {path} 为空时，替换后残留的结尾斜杠会被去掉，得到干净的基址
  const built = buildCdnBase({ ...CFG, preset: 'custom', customTemplate: tpl });
  assert.equal(built, 'https://img.example.com/demo-user/demo-avatar-bed@main');
  assert.equal(applyTemplate(tpl, { owner: 'o', repo: 'r', branch: 'b', path: 'avatar/x' }), 'https://img.example.com/o/r@b/avatar/x');

  // 模板里直接带 {path} 时也能拼出完整直链
  const cfgPathTpl = { ...CFG, preset: 'custom', customTemplate: 'https://img.example.com/{owner}/{repo}@{branch}/{path}' };
  assert.equal(
    buildFileUrl(cfgPathTpl, 'avatar/abc'),
    'https://img.example.com/demo-user/demo-avatar-bed@main/avatar/abc'
  );
});

test('toTwikooValue 去掉协议头、结尾斜杠，并防止重复 /avatar', () => {
  assert.equal(toTwikooValue('https://cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main'), 'cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main');
  assert.equal(toTwikooValue('http://a.com/b/'), 'a.com/b');
  assert.equal(toTwikooValue('https://a.com/b/avatar'), 'a.com/b');
  assert.equal(toTwikooValue(''), '');
});

test('getPreset 未知 id 回落第一个预设', () => {
  assert.equal(getPreset('nope').id, CDN_PRESETS[0].id);
  assert.equal(getPreset('jsdmirror').id, 'jsdmirror');
});

/* ---------------------- 直链与 Twikoo 兼容性 ---------------------- */

test('头像直链格式与需求示例一致', () => {
  const hash = 'a'.repeat(64);
  assert.equal(
    buildAvatarUrl(CFG, hash),
    `https://cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main/avatar/${hash}`
  );
  assert.equal(
    buildFileUrl(CFG, `avatar/${hash}`),
    `https://cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main/avatar/${hash}`
  );
  assert.equal(buildAvatarUrl({ ...CFG, prefix: '' }, hash), `https://cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main/${hash}`);
});

test('buildTwikooRequestUrl 复刻 Twikoo 源码模板（含硬编码的 /avatar 与 ?d=）', () => {
  const expected =
    'https://cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main/avatar/' +
    createHash('sha256').update('test@example.com', 'utf8').digest('hex') +
    '?d=mp';
  assert.equal(buildTwikooRequestUrl(CFG, 'test@example.com'), expected);
  assert.equal(
    buildTwikooRequestUrl(CFG, '  Test@Example.com ', { d: 'identicon' }),
    expected.replace('?d=mp', '?d=identicon')
  );
});

test('describeEmail 一次性给出全部上传所需信息', () => {
  const info = describeEmail(CFG, '  Test@Example.com ');
  assert.equal(info.normalized, 'test@example.com');
  assert.equal(info.hash, createHash('sha256').update('test@example.com').digest('hex'));
  assert.equal(info.repoPath, `avatar/${info.hash}`);
  assert.equal(info.url, `https://cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main/avatar/${info.hash}`);
  assert.equal(info.twikooValue, 'cdn.jsdmirror.com/gh/demo-user/demo-avatar-bed@main');
  assert.equal(info.twikooUrl, `${info.url}?d=mp`);
  assert.equal(info.twikooCompatible, true);

  const md5info = describeEmail(CFG, 'test@example.com', { algorithm: 'md5' });
  assert.equal(md5info.twikooCompatible, false, 'MD5 与 Twikoo 自定义 CDN 不兼容，必须被标记出来');

  const otherPrefix = describeEmail({ ...CFG, prefix: 'img' }, 'test@example.com');
  assert.equal(otherPrefix.twikooCompatible, false, '改了目录前缀就不再兼容 Twikoo');
});

test('describeEmails 支持多行/逗号/分号分隔并去重前后的空项', () => {
  const list = describeEmails(CFG, 'a@b.com\n c@d.com ,; e@f.com\n\n');
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((x) => x.email), ['a@b.com', 'c@d.com', 'e@f.com']);
  assert.equal(new Set(list.map((x) => x.hash)).size, 3);
});

test('相同邮箱的哈希稳定，不同大小写/空白得到同一结果（Twikoo 也是这么做的）', () => {
  const a = describeEmail(CFG, 'User@Example.com');
  const b = describeEmail(CFG, '  user@example.com  ');
  assert.equal(a.hash, b.hash);
});

/* ---------------------------- 缓存刷新 ---------------------------- */

test('buildPurgeUrl 生成 jsDelivr 的 purge 地址', () => {
  assert.equal(
    buildPurgeUrl(CFG, `avatar/${'a'.repeat(64)}`),
    `${PURGE_ENDPOINT}/gh/demo-user/demo-avatar-bed@main/avatar/${'a'.repeat(64)}`
  );
  assert.equal(buildPurgeUrl(CFG, '/avatar/x'), `${PURGE_ENDPOINT}/gh/demo-user/demo-avatar-bed@main/avatar/x`);
  assert.equal(buildPurgeUrl({ ...CFG, branch: '' }, 'avatar/x'), `${PURGE_ENDPOINT}/gh/demo-user/demo-avatar-bed@main/avatar/x`);
  assert.equal(buildPurgeUrl({ ...CFG, owner: '' }, 'avatar/x'), '', '信息不全时返回空串，避免发出无效请求');
  assert.equal(buildPurgeUrl(CFG, ''), '');
});

test('isPurgeable 只对真正跑在 jsDelivr 自家 CDN 上的线路返回 true', () => {
  assert.equal(isPurgeable({ preset: 'jsdelivr' }), true);
  assert.equal(isPurgeable({ preset: 'gcore' }), true, 'gcore 是 jsDelivr 的 Cloudflare 节点，实测 purge 覆盖它');
  assert.equal(
    isPurgeable({ preset: 'jsdmirror' }),
    false,
    'jsdmirror 是第三方镜像（腾讯 EdgeOne），purge.jsdelivr.net 管不到它 —— 这里曾经误判为可刷新'
  );
  assert.equal(isPurgeable({ preset: 'raw' }), false);
  assert.equal(isPurgeable({ preset: 'pages' }), false);
  assert.equal(isPurgeable({ preset: 'custom' }), false);
  assert.equal(isPurgeable(null), false, '不能因为配置为空就抛错');
});

test('purgeSupport 对 jsdmirror 给出「为什么不行 + 那怎么办」，而不是一句冷冰冰的不支持', () => {
  const okCase = purgeSupport({ preset: 'jsdelivr' });
  assert.equal(okCase.supported, true);
  assert.equal(okCase.reason, '');

  const mirror = purgeSupport({ preset: 'jsdmirror' });
  assert.equal(mirror.supported, false);
  assert.match(mirror.reason, /第三方镜像/);
  assert.match(mirror.reason, /EdgeOne/);
  // 必须给出可执行的替代方案，否则用户只能干等缓存过期
  assert.match(mirror.workaround, /DEFAULT_GRAVATAR/);
  assert.match(mirror.workaround, /jsdelivr\.net/);

  const other = purgeSupport({ preset: 'raw' });
  assert.equal(other.supported, false);
  assert.ok(other.workaround.length > 0, '任何不支持的线路都应给出替代方案');
  assert.equal(purgeSupport(null).supported, false);
});
