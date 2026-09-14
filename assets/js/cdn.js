/**
 * cdn.js —— CDN 基址生成 + 头像直链构建（纯函数，无 DOM，可单元测试）。
 *
 * 名词约定
 *   base   ：CDN 基址，形如 `https://cdn.jsdmirror.com/gh/user/repo@main`
 *   value  ：填进 Twikoo 的 GRAVATAR_CDN 的值，是 base **去掉协议头、去掉结尾斜杠、且不含 /avatar**
 *   path   ：仓库内路径，形如 `avatar/973dfe46...813b`
 */

import { normalizePrefix } from './paths.js';
import { normalizeMail, emailToFileName, sha256Hex } from './hash.js';

/** 去掉协议头与结尾斜杠，得到可直接填进 Twikoo 的 CDN 值。 */
export function toTwikooValue(url) {
  return String(url == null ? '' : url)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .replace(/\/avatar$/i, ''); // 防止用户误把 /avatar 也填进去（Twikoo 会再加一次）
}

/** 拼接 URL，避免出现重复斜杠。 */
export function joinUrl(base, ...segments) {
  let out = String(base == null ? '' : base).trim().replace(/\/+$/, '');
  for (const seg of segments) {
    const s = String(seg == null ? '' : seg).replace(/^\/+|\/+$/g, '');
    if (s) out += '/' + s;
  }
  return out;
}

/**
 * 内置 CDN 预设。
 * build(ctx) 接收 { owner, repo, branch }，返回不带结尾斜杠的基址。
 */
export const CDN_PRESETS = [
  {
    id: 'jsdelivr',
    label: 'jsDelivr 官方（推荐）',
    build: ({ owner, repo, branch }) => `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}`,
    note: '全球节点，自动压缩与缓存；国内部分网络偶发不稳定。'
  },
  {
    id: 'jsdmirror',
    label: 'jsDelivr 国内镜像 cdn.jsdmirror.com',
    build: ({ owner, repo, branch }) => `https://cdn.jsdmirror.com/gh/${owner}/${repo}@${branch}`,
    note: 'jsDelivr 的国内反代镜像，国内访问通常更快，路径规则与官方一致。'
  },
  {
    id: 'gcore',
    label: 'jsDelivr Gcore 节点',
    build: ({ owner, repo, branch }) => `https://gcore.jsdelivr.net/gh/${owner}/${repo}@${branch}`,
    note: 'jsDelivr 的 Gcore 线路，国内部分地区比官方节点快。'
  },
  {
    id: 'statically',
    label: 'Statically',
    build: ({ owner, repo, branch }) => `https://cdn.statically.io/gh/${owner}/${repo}/${branch}`,
    note: '第三方 GitHub CDN，注意 /gh/user/repo/branch 的层级与 jsDelivr 不同。'
  },
  {
    id: 'raw',
    label: 'GitHub Raw（无 CDN 加速）',
    build: ({ owner, repo, branch }) => `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`,
    note: '直连 GitHub，国内访问慢，且响应头带 nosniff，可作排障对照。'
  },
  {
    id: 'pages',
    label: 'GitHub Pages（需开启 Pages）',
    build: ({ owner, repo }) => `https://${owner}.github.io/${repo}`,
    note: '需在仓库 Settings → Pages 中开启；默认分支根目录发布。'
  },
  {
    id: 'ghproxy',
    label: 'ghproxy 加速 Raw',
    build: ({ owner, repo, branch }) =>
      `https://ghproxy.net/https://raw.githubusercontent.com/${owner}/${repo}/${branch}`,
    note: '公共反代，稳定性不保证，仅作备选。'
  },
  {
    id: 'custom',
    label: '自定义模板',
    build: null,
    note: '支持占位符 {owner} {repo} {branch} {prefix} {path} {hash}，例如 https://img.example.com/{path}'
  }
];

/** 按 id 取预设。 */
export function getPreset(id) {
  return CDN_PRESETS.find((p) => p.id === id) || CDN_PRESETS[0];
}

/** 应用自定义模板中的占位符。 */
export function applyTemplate(template, ctx) {
  return String(template == null ? '' : template).replace(
    /\{(owner|repo|branch|prefix|path|hash)\}/g,
    (_, key) => {
      const v = ctx[key];
      return v == null ? '' : String(v);
    }
  );
}

/**
 * 计算 CDN 基址。
 * @param {{preset?:string, customTemplate?:string, owner:string, repo:string, branch:string, prefix?:string}} cfg
 */
export function buildCdnBase(cfg) {
  const owner = String(cfg.owner || '').trim();
  const repo = String(cfg.repo || '').trim();
  const branch = String(cfg.branch || 'main').trim() || 'main';
  const preset = getPreset(cfg.preset);

  if (preset.id === 'custom') {
    const tpl = String(cfg.customTemplate || '').trim();
    if (!tpl) return '';
    return applyTemplate(tpl, {
      owner,
      repo,
      branch,
      prefix: normalizePrefix(cfg.prefix),
      path: '',
      hash: ''
    }).replace(/\/+$/, '');
  }

  if (!owner || !repo) return '';
  return preset.build({ owner, repo, branch });
}

/** 仓库内路径 → 完整直链。 */
export function buildFileUrl(cfg, repoPath) {
  const base = buildCdnBase(cfg);
  if (!base) return '';
  return joinUrl(base, repoPath);
}

/** 由文件名（哈希）构建直链。 */
export function buildAvatarUrl(cfg, fileName) {
  const prefix = normalizePrefix(cfg.prefix);
  return buildFileUrl(cfg, prefix ? `${prefix}/${fileName}` : fileName);
}

/**
 * 复刻 Twikoo 的请求地址，用于「预览 Twikoo 到底会请求什么」。
 * Twikoo 源码：`https://${gravatarCdn}/avatar/${sha256(normalizeMail(mail))}?d=${defaultGravatar}`
 * 注意这里无论本地 prefix 配成什么，Twikoo 用的都是硬编码的 /avatar。
 */
export function buildTwikooRequestUrl(cfg, email, defaults = {}) {
  const value = toTwikooValue(buildCdnBase(cfg));
  if (!value) return '';
  const hash = sha256Hex(normalizeMail(email));
  const d = defaults.d || 'mp';
  return `https://${value}/avatar/${hash}?d=${d}`;
}

/** 一次性给出某个邮箱在本项目下的全部关键信息（上传预览、批量生成器都用它）。 */
export function describeEmail(cfg, email, options = {}) {
  const algorithm = options.algorithm === 'md5' ? 'md5' : 'sha256';
  const normalized = normalizeMail(email);
  const hash = emailToFileName(email, algorithm);
  const prefix = normalizePrefix(cfg.prefix);
  const repoPath = prefix ? `${prefix}/${hash}` : hash;
  const base = buildCdnBase(cfg);
  return {
    email: String(email == null ? '' : email).trim(),
    normalized,
    algorithm,
    hash,
    repoPath,
    base,
    url: base ? joinUrl(base, repoPath) : '',
    twikooValue: toTwikooValue(base),
    twikooUrl: base ? buildTwikooRequestUrl(cfg, email, options) : '',
    twikooCompatible: normalizePrefix(cfg.prefix) === 'avatar' && algorithm === 'sha256'
  };
}

/** 批量：多行邮箱 → 信息数组。 */
export function describeEmails(cfg, rawText, options = {}) {
  return String(rawText == null ? '' : rawText)
    .split(/[\r\n,;，；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => describeEmail(cfg, email, options));
}

/* ------------------------------------------------------------------ *
 * 缓存刷新（purge）
 *
 * jsDelivr 会把文件缓存很久（最长 7 天）。覆盖头像后如果不刷新缓存，
 * 评论者看到的还是旧头像——对头像图床来说这是必须处理的问题。
 * jsDelivr 提供了公开的 purge 端点，且响应头带 Access-Control-Allow-Origin: *
 * （已实测：GET https://purge.jsdelivr.net/gh/user/repo@main/path → 200 + JSON），
 * 所以浏览器可以直接调用。
 * ------------------------------------------------------------------ */

export const PURGE_ENDPOINT = 'https://purge.jsdelivr.net';

/**
 * 哪些线路真的能被 purge.jsdelivr.net 刷新？
 *
 * purge 接口的响应里会列出它刷了哪些供应商，实测是 `{ CF: true, FY: true }`，
 * 也就是只覆盖 jsDelivr 自家跑在 Cloudflare 与 Fastly 上的节点：
 *   - cdn.jsdelivr.net   → 实测 X-Served-By 是 Fastly 节点（cache-fra-…、cache-nrt-…）✓
 *   - gcore.jsdelivr.net → 实测 Server: cloudflare 且带 CF-Cache-Status ✓
 *
 * ⚠️ cdn.jsdmirror.com **不在其中**。实测证据：
 *   - 响应头 `Server: ayao`、`X-Served-By: ayao`、`EO-Cache-Status: HIT`、`EO-LOG-UUID`
 *     → 它是跑在腾讯 EdgeOne 上的第三方镜像，有自己独立的多级缓存；
 *   - 它的 `Cache-Control: public, max-age=300, stale-while-revalidate=86400`
 *     → 浏览器缓存 5 分钟，边缘最长可以继续用旧副本约 24 小时；
 *   - `purge.jsdmirror.com` 这个域名不存在（TLS 层就连不上），
 *     `cdn.jsdmirror.com/purge/…` 返回 401（需要授权，外部用不了）。
 *   所以「刷新 jsDelivr 缓存」对它无效，UI 必须如实告知，不能让人以为刷过了。
 */
const PURGEABLE_PRESETS = new Set(['jsdelivr', 'gcore']);

export function isPurgeable(cfg) {
  // 注意不能只写 getPreset(cfg.preset)：getPreset 对未知输入会回退到第一个预设（jsdelivr），
  // 那样 cfg 为空时会被误判成「可刷新」。
  if (!cfg || typeof cfg !== 'object') return false;
  return PURGEABLE_PRESETS.has(getPreset(cfg.preset).id);
}

/**
 * 描述当前线路的缓存刷新能力，用于给出「为什么不行 + 那怎么办」，而不是一句冷冰冰的不支持。
 * @returns {{supported:boolean, reason:string, workaround:string}}
 */
export function purgeSupport(cfg) {
  // 这里必须自己先挡住空值：getPreset(undefined) 会回退到第一个预设（jsdelivr），
  // 于是「什么都没配」会被误判成「可刷新」。
  if (!cfg || typeof cfg !== 'object') {
    return {
      supported: false,
      reason: '还没有配置 CDN 线路。',
      workaround: '先在设置页填好仓库信息并选择一条 CDN 线路。'
    };
  }

  const preset = getPreset(cfg.preset);
  if (PURGEABLE_PRESETS.has(preset.id)) {
    return { supported: true, reason: '', workaround: '' };
  }

  if (preset.id === 'jsdmirror') {
    return {
      supported: false,
      reason:
        'cdn.jsdmirror.com 是第三方镜像（跑在腾讯 EdgeOne 上，响应头里的 EO-Cache-Status 可以看出来），' +
        '它有自己独立的多级缓存，jsDelivr 的 purge 接口管不到它。实测它也没有公开的刷新接口。',
      workaround:
        '想立刻让新头像生效，三条路：\n' +
        '① 在 Twikoo 设置里把 DEFAULT_GRAVATAR 从 mp 改成别的值（比如 mp2）——Twikoo 拼出的头像 URL 会整体变化，等于绕过旧缓存，代价是所有头像一起重新拉取；\n' +
        '② 把 CDN 线路换成 cdn.jsdelivr.net 或 gcore.jsdelivr.net，这两条能被 purge 立即刷新；\n' +
        '③ 用项目里 extras/cloudflare-worker.js 自建反代，缓存时长由你自己控制。'
    };
  }

  return {
    supported: false,
    reason: `${preset.label} 不是 jsDelivr 自家的 CDN，purge 接口对它无效。`,
    workaround: '想能立即刷新，请把 CDN 线路改成 cdn.jsdelivr.net 或 gcore.jsdelivr.net。'
  };
}

/** 生成某个仓库路径的缓存刷新地址。 */
export function buildPurgeUrl(cfg, repoPath) {
  const owner = String((cfg && cfg.owner) || '').trim();
  const repo = String((cfg && cfg.repo) || '').trim();
  const branch = String((cfg && cfg.branch) || 'main').trim() || 'main';
  const path = String(repoPath == null ? '' : repoPath).replace(/^\/+/, '');
  if (!owner || !repo || !path) return '';
  return `${PURGE_ENDPOINT}/gh/${owner}/${repo}@${branch}/${path}`;
}
