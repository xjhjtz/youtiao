/**
 * config.js —— 设置的读写与默认值。
 *
 * 令牌可以只放在 sessionStorage（关掉标签页即失效），也可以放 localStorage（图省事）。
 * 两种情况下都只存在用户自己的浏览器里，绝不会发往 GitHub 以外的任何地方。
 */

export const SETTINGS_KEY = 'youtiao.settings.v1';
export const TOKEN_KEY = 'youtiao.token.v1';
export const THEME_KEY = 'youtiao.theme.v1';

/**
 * 项目曾经叫 GitAvatar，那时的存储键前缀是 `gh-avatar-bed`。
 * 改名之后如果直接换键，用户浏览器里已经保存的令牌、设置、备注会「凭空消失」，
 * 所以在读取之前先把旧键里的内容搬到新键（只搬一次，搬完删掉旧键）。
 */
const LEGACY_PREFIX = 'gh-avatar-bed';

/**
 * 把旧存储键的内容迁移到新键。
 * @param {Storage|null} storage
 * @param {string} newKey 新键（完整键名）
 * @param {string} legacySuffix 旧键去掉前缀后的部分，例如 'settings.v1'
 */
export function migrateStorageKey(storage, newKey, legacySuffix) {
  if (!storage || !legacySuffix) return;
  const legacyKey = `${LEGACY_PREFIX}.${legacySuffix}`;
  try {
    // 新键已有内容时以新键为准，但仍然清掉旧键，避免下次又被翻出来
    if (storage.getItem(newKey) === null) {
      const legacyValue = storage.getItem(legacyKey);
      if (legacyValue !== null) storage.setItem(newKey, legacyValue);
    }
    storage.removeItem(legacyKey);
  } catch {
    /* 隐私模式下 storage 可能不可写，忽略即可 */
  }
}

/**
 * 预填默认值（开源版本留空，第一次打开时由用户自己填）。
 *
 * 只影响「浏览器里还没有保存过设置」时的初始值——保存过一次之后，以浏览器里的设置为准，
 * 页面上随时可以改。如果你想自建一个「打开即用」的私有版本，把下面填成自己的仓库即可，
 * 例如 { owner: 'your-name', repo: 'your-avatar-bed' }。
 */
export const PREFILL = {
  owner: '',
  repo: '',
  branch: 'main',
  prefix: 'avatar',
  preset: 'jsdmirror'
};

export const DEFAULT_SETTINGS = {
  owner: PREFILL.owner || '',
  repo: PREFILL.repo || '',
  branch: PREFILL.branch || 'main',
  /** 仓库内目录，必须是 avatar 才兼容 Twikoo */
  prefix: PREFILL.prefix || 'avatar',
  /** sha256 与 Twikoo 自定义 CDN 一致；md5 仅用于 cravatar.cn */
  algorithm: 'sha256',
  /** CDN 预设 id，默认走国内镜像 */
  preset: PREFILL.preset || 'jsdmirror',
  customTemplate: '',
  keepExtension: false,
  overwrite: true,
  compress: false,
  /** 覆盖/删除后自动刷新 jsDelivr 缓存，否则 CDN 会继续返回旧头像 */
  autoPurge: true,
  /** 备注是否同步到 GitHub 仓库（只存本地的话，清浏览器缓存或换设备就全没了） */
  notesEnabled: true,
  /** 备注文件在仓库里的路径。必须放在 avatar/ 之外，否则会被图库当成头像 */
  notesPath: '.youtiao/notes.json',
  /** 备注放哪个仓库：留空 = 与图床同仓库（公开，邮箱会公开）；填 owner/repo 可指向私有仓库 */
  notesRepo: '',
  /** 用户是否已确认过「写进公开仓库 = 邮箱公开」 */
  notesPublicAck: false,
  concurrency: 3,
  maxEdge: 512,
  commitTemplate: 'avatar: {action} {hash}',
  defaultGravatar: 'mp',
  tokenStorage: 'local',
  /** 本工具的已知备注映射上限 */
  historyLimit: 20000
};

const readStorage = (storage) => {
  try {
    return storage;
  } catch {
    return null;
  }
};

/** 读取设置（含令牌）。 */
export function loadSettings() {
  // 先把旧版（GitAvatar 时期）的键搬过来，再读取
  for (const storage of [readStorage(localStorage), readStorage(sessionStorage)]) {
    migrateStorageKey(storage, SETTINGS_KEY, 'settings.v1');
    migrateStorageKey(storage, TOKEN_KEY, 'token.v1');
  }

  const base = { ...DEFAULT_SETTINGS };
  let stored = null;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch {
    stored = null;
  }
  const settings = stored && typeof stored === 'object' ? { ...base, ...stored } : base;

  // 令牌可能在任何一种 storage 里，优先 localStorage
  let token = '';
  try {
    token = localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    token = '';
  }
  if (!token) {
    try {
      token = sessionStorage.getItem(TOKEN_KEY) || '';
    } catch {
      token = '';
    }
  }
  settings.token = token;
  return settings;
}

/** 保存设置（令牌按 tokenStorage 落到对应 storage）。 */
export function saveSettings(settings) {
  const { token, ...rest } = settings || {};
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
  } catch (error) {
    throw new Error('设置写入浏览器存储失败：' + (error && error.message ? error.message : error));
  }

  const mode = rest.tokenStorage === 'session' ? 'session' : 'local';
  const target = readStorage(mode === 'session' ? sessionStorage : localStorage);
  const other = readStorage(mode === 'session' ? localStorage : sessionStorage);
  try {
    if (other) other.removeItem(TOKEN_KEY);
    if (target) {
      if (token) target.setItem(TOKEN_KEY, token);
      else target.removeItem(TOKEN_KEY);
    }
  } catch (error) {
    throw new Error('令牌写入浏览器存储失败：' + (error && error.message ? error.message : error));
  }
  return rest;
}

/** 清空本工具写入的全部设置（不含备注历史）。 */
export function clearSettings() {
  for (const storage of [readStorage(localStorage), readStorage(sessionStorage)]) {
    if (!storage) continue;
    try {
      storage.removeItem(SETTINGS_KEY);
      storage.removeItem(TOKEN_KEY);
    } catch {
      /* 忽略 */
    }
  }
}

/** 主题：返回 'light' | 'dark'。未设置时跟随系统。 */
export function loadTheme() {
  migrateStorageKey(readStorage(localStorage), THEME_KEY, 'theme.v1');
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* 忽略 */
  }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 忽略 */
  }
}
