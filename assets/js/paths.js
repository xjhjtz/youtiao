/**
 * paths.js —— 仓库内路径构建规则（纯函数，无 DOM，可单元测试）。
 *
 * 命名规则（来自需求）：
 *   邮箱 → normalizeMail（trim + 小写）→ SHA-256 → 64 位十六进制字符串 → 作为文件名，去掉扩展名。
 *
 * 目录规则（兼容 Twikoo）：
 *   Twikoo 渲染头像时写死了 URL 模板 `https://{GRAVATAR_CDN}/avatar/{sha256}?d={默认头像}`，
 *   中间的 `/avatar/` 由 Twikoo 追加，无法配置。因此图片必须存放在仓库的 `avatar/` 目录下，
 *   用户在 Twikoo 里填的 GRAVATAR_CDN 则是不带 `/avatar` 的基址。
 *
 *   本文件把目录前缀做成了可配置项（默认 `avatar`），一旦改掉就不再兼容 Twikoo，
 *   UI 会就此给出明确警告。
 */

/** Twikoo 硬编码追加的目录名。 */
export const TWIKOO_DIR = 'avatar';

/** 默认的仓库内目录前缀。 */
export const DEFAULT_PREFIX = TWIKOO_DIR;

/** 归一化目录前缀：去掉首尾斜杠与空白；空串表示直接放在仓库根目录。 */
export function normalizePrefix(prefix) {
  if (prefix == null) return DEFAULT_PREFIX;
  return String(prefix)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

/**
 * 构建仓库内文件路径。
 * @param {string} fileName 形如 `973dfe46...813b`
 * @param {{prefix?: string, keepExtension?: boolean, extension?: string}} [options]
 */
export function buildRepoPath(fileName, options = {}) {
  const prefix = normalizePrefix(options.prefix);
  let name = String(fileName == null ? '' : fileName).replace(/^\/+/, '');
  if (options.keepExtension && options.extension) {
    const ext = String(options.extension).replace(/^\.+/, '').toLowerCase();
    if (ext && !name.toLowerCase().endsWith('.' + ext)) name += '.' + ext;
  }
  return prefix ? `${prefix}/${name}` : name;
}

/** 从仓库路径反推文件名（末段）。 */
export function fileNameOf(repoPath) {
  const p = String(repoPath == null ? '' : repoPath);
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

/** 从仓库路径反推目录前缀（无目录时为空串）。 */
export function prefixOf(repoPath) {
  const p = String(repoPath == null ? '' : repoPath);
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

/** 判断某个仓库路径是否位于给定前缀之下。 */
export function isUnderPrefix(repoPath, prefix) {
  const p = normalizePrefix(prefix);
  const path = String(repoPath == null ? '' : repoPath);
  if (!p) return true;
  return path === p ? false : path.startsWith(p + '/');
}

/** 取文件扩展名（小写，不含点）；没有则返回空串。 */
export function extensionOf(fileName) {
  const name = String(fileName == null ? '' : fileName);
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

/** 去掉扩展名。 */
export function stripExtension(fileName) {
  const name = String(fileName == null ? '' : fileName);
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return name;
  return name.slice(0, idx);
}

/** 常见图片扩展名 —— 只有这些才会被「文件名即邮箱」模式剥掉。 */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'jpe', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff', 'heic', 'heif'
]);

/**
 * 由「文件名即邮箱」的批量模式推断邮箱：`a@b.com.png` → `a@b.com`。
 * 注意只剥图片扩展名，否则 `a@b.com` 会被错误地剥成 `a@b`（`.com` 长得就像扩展名）。
 */
export function emailFromFileName(fileName) {
  const name = String(fileName == null ? '' : fileName).trim();
  const ext = extensionOf(name);
  const base = IMAGE_EXTENSIONS.has(ext) ? name.slice(0, name.length - ext.length - 1) : name;
  return base.trim().replace(/\s+/g, '');
}

/** 粗略校验邮箱格式，仅用于 UI 提示，不阻断上传（Twikoo 也可能存非邮箱标识）。 */
export function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value == null ? '' : value).trim());
}

/** 判断一个字符串是否是本系统生成的文件名（32 位 md5 或 64 位 sha256）。 */
export function looksLikeHashName(name) {
  return /^[0-9a-f]{32}$/.test(name) || /^[0-9a-f]{64}$/.test(name);
}
