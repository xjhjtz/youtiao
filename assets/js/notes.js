/**
 * notes.js —— 「邮箱 ↔ 哈希」备注的文档模型与本地持久化。
 *
 * ## 为什么要有这个文件
 * SHA-256 不可逆，只看仓库里的文件名谁也不知道那是谁的邮箱。
 * 所以上传时把对应关系记下来，图库才能显示邮箱、才能按邮箱搜索。
 *
 * ## 存储策略
 * 备注被当成一个「文档」而不是一串记录，因为它需要支持两处存储之间的合并：
 *   - 本地缓存（localStorage，离线可用、打开即显示）
 *   - 远程文件（放在 GitHub 仓库里，换设备/清浏览器都不丢）
 *
 * 合并时最大的坑是「删除」：如果只做并集，本地删掉的备注会被远程的旧数据复活。
 * 所以文档里除了 entries 还带一张 removed 墓碑表：
 *   某个哈希的墓碑时间只要不早于它的记录时间，这条记录就算已删除。
 *
 * 本文件只做「模型 + 本地存储」，网络同步在 notes-sync.js。
 */

import { DEFAULT_SETTINGS } from './config.js';

export const NOTES_KEY = 'youtiao.notes.v1';
/** 改名前的本地备注键（那时只存了一个数组） */
const LEGACY_HISTORY_KEY = 'youtiao.history.v1';
/** 改名前的旧前缀键 */
const LEGACY_HISTORY_KEY_OLD = 'gh-avatar-bed.history.v1';

/** 远程备注文件在仓库里的默认位置。放在 avatar/ 之外，避免被图库当成头像。 */
export const DEFAULT_NOTES_PATH = '.youtiao/notes.json';
export const NOTES_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 文档模型（纯函数，已被单元测试覆盖）
 * ------------------------------------------------------------------ */

export function emptyDoc(now = Date.now()) {
  return { version: NOTES_VERSION, updatedAt: new Date(now).toISOString(), entries: [], removed: {} };
}

/**
 * 把各种可能的历史形态归一化成文档。
 * 接受：文档对象 / 记录数组（旧版 localStorage 形态）/ JSON 字符串 / null。
 */
export function normalizeDoc(input, now = Date.now()) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return emptyDoc(now);
    }
  }
  if (!raw) return emptyDoc(now);

  const entries = Array.isArray(raw) ? raw : Array.isArray(raw.entries) ? raw.entries : [];
  const removed = !Array.isArray(raw) && raw.removed && typeof raw.removed === 'object' ? raw.removed : {};

  return {
    version: NOTES_VERSION,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(now).toISOString(),
    entries: entries.filter(isValidEntry).map((e) => ({ ...e })),
    removed: Object.fromEntries(
      Object.entries(removed)
        .filter(([hash, ts]) => typeof hash === 'string' && hash.length > 0 && Number.isFinite(Number(ts)))
        .map(([hash, ts]) => [hash, Number(ts)])
    )
  };
}

function isValidEntry(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.hash && entry.email);
}

/** 墓碑：把某个哈希标记为「已删除」，时间用于和远程旧数据比新旧。 */
export function tombstoneEntries(doc, hashes, ts = Date.now()) {
  const base = normalizeDoc(doc);
  const removed = { ...base.removed };
  const set = new Set(hashes || []);
  for (const hash of set) if (hash) removed[hash] = Math.max(removed[hash] || 0, ts);
  return {
    ...base,
    removed,
    entries: base.entries.filter((e) => !set.has(e.hash)),
    updatedAt: new Date(ts).toISOString()
  };
}

/** 新增或更新若干条备注（按哈希去重，新的 ts 覆盖旧的）。 */
export function upsertEntries(doc, entries, ts = Date.now(), limit = DEFAULT_SETTINGS.historyLimit) {
  const base = normalizeDoc(doc);
  const map = new Map(base.entries.map((e) => [e.hash, e]));
  const removed = { ...base.removed };

  for (const entry of entries || []) {
    if (!isValidEntry(entry)) continue;
    const prev = map.get(entry.hash) || {};
    map.set(entry.hash, { ...prev, ...entry, ts, firstTs: prev.firstTs || ts });
    // 重新添加等于撤销墓碑
    delete removed[entry.hash];
  }

  const list = [...map.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, Math.max(1, limit));
  return { version: NOTES_VERSION, updatedAt: new Date(ts).toISOString(), entries: list, removed };
}

/**
 * 合并两份文档（本地 vs 远程）。
 * 规则：按哈希取「时间更新」的那条记录；墓碑同理；墓碑不早于记录则记录作废。
 */
export function mergeDocs(a, b) {
  const left = normalizeDoc(a);
  const right = normalizeDoc(b);
  const entries = new Map();
  const removed = {};

  for (const doc of [left, right]) {
    for (const entry of doc.entries) {
      const prev = entries.get(entry.hash);
      if (!prev || (entry.ts || 0) >= (prev.ts || 0)) entries.set(entry.hash, { ...prev, ...entry });
    }
    for (const [hash, ts] of Object.entries(doc.removed)) {
      removed[hash] = Math.max(removed[hash] || 0, ts);
    }
  }

  // 墓碑时间不早于记录时间 → 这条记录已被删除
  const alive = [...entries.values()].filter((entry) => (removed[entry.hash] || 0) < (entry.ts || 0));

  const updatedAt = [left.updatedAt, right.updatedAt].filter(Boolean).sort().pop() || new Date().toISOString();
  return {
    version: NOTES_VERSION,
    updatedAt,
    entries: alive.sort((x, y) => (y.ts || 0) - (x.ts || 0)),
    removed
  };
}

/** 稳定序列化：条目按 ts 倒序，便于在 GitHub 上看 diff。 */
export function serializeDoc(doc) {
  const base = normalizeDoc(doc);
  const removed = Object.fromEntries(Object.entries(base.removed).sort(([x], [y]) => (x < y ? -1 : 1)));
  return (
    JSON.stringify(
      {
        version: NOTES_VERSION,
        updatedAt: base.updatedAt,
        // 说明：这个文件由「油条」自动维护，记录了邮箱与头像文件名的对应关系
        entries: base.entries,
        removed
      },
      null,
      2
    ) + '\n'
  );
}

export function entriesOf(doc) {
  return normalizeDoc(doc).entries;
}

/** 哈希/路径 → 记录 的索引，供图库标注邮箱。 */
export function notesIndex(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    if (!entry || !entry.hash) continue;
    map.set(entry.hash, entry);
    if (entry.path) map.set(entry.path, entry);
  }
  return map;
}

/** 用备注给图库条目补上 email 字段（哈希命中或完整路径命中都算）。 */
export function annotateFiles(files, index) {
  return (files || []).map((file) => {
    const hit = index.get(file.name) || index.get(file.path);
    return hit ? { ...file, email: hit.email, note: hit.note || '' } : { ...file, email: '', note: '' };
  });
}

/* ------------------------------------------------------------------ *
 * 本地持久化
 * ------------------------------------------------------------------ */

function notesStorage() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** 从旧版本（只存数组的 history 键）迁移一次。 */
function migrateLegacyHistory(storage) {
  if (!storage) return null;
  for (const key of [LEGACY_HISTORY_KEY, LEGACY_HISTORY_KEY_OLD]) {
    try {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const doc = normalizeDoc(raw);
      storage.removeItem(key);
      if (doc.entries.length) return doc;
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/** 读取本地备注文档。 */
export function loadNotesDoc() {
  const storage = notesStorage();
  if (!storage) return emptyDoc();
  try {
    const raw = storage.getItem(NOTES_KEY);
    if (raw !== null) return normalizeDoc(raw);
  } catch {
    /* 落回下面的迁移/空文档 */
  }
  const migrated = migrateLegacyHistory(storage);
  if (migrated) {
    saveNotesDoc(migrated);
    return migrated;
  }
  return emptyDoc();
}

/** 写入本地备注文档；配额不足时砍掉一半再试一次。 */
export function saveNotesDoc(doc, limit = DEFAULT_SETTINGS.historyLimit) {
  const storage = notesStorage();
  if (!storage) return doc;
  const trimmed = {
    ...normalizeDoc(doc),
    entries: normalizeDoc(doc).entries.slice(0, Math.max(1, limit))
  };
  const text = serializeDoc(trimmed);
  try {
    storage.setItem(NOTES_KEY, text);
    return trimmed;
  } catch {
    const half = { ...trimmed, entries: trimmed.entries.slice(0, Math.max(1, Math.floor(trimmed.entries.length / 2))) };
    try {
      storage.setItem(NOTES_KEY, serializeDoc(half));
      return half;
    } catch {
      throw new Error('本地备注写入失败：浏览器存储已满');
    }
  }
}

/** 清空本地备注（含墓碑）。 */
export function clearNotes() {
  const storage = notesStorage();
  try {
    storage && storage.removeItem(NOTES_KEY);
  } catch {
    /* 忽略 */
  }
  return emptyDoc();
}

/* ------------------------------------------------------------------ *
 * 导入 / 导出
 * ------------------------------------------------------------------ */

export function exportNotes() {
  return { ...loadNotesDoc(), exportedAt: new Date().toISOString(), exportedBy: 'youtiao' };
}

export function importNotes(payload, limit = DEFAULT_SETTINGS.historyLimit) {
  const incoming = normalizeDoc(payload);
  const before = loadNotesDoc();
  const merged = mergeDocs(before, incoming);
  const saved = saveNotesDoc(merged, limit);
  return { imported: incoming.entries.length, total: saved.entries.length, doc: saved };
}
