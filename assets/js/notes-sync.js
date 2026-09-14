/**
 * notes-sync.js —— 把备注文档同步到 GitHub 仓库。
 *
 * ## 为什么要同步
 * 备注只放 localStorage 的话，清一次浏览器缓存、换一台设备就全没了，
 * 而 SHA-256 不可逆 —— 这意味着那些头像是谁的，永远查不回来了。
 *
 * ## 但它默认不该直接写进图床仓库
 * 图床仓库必须是公开的（jsDelivr 只能读公开仓库），
 * 所以备注文件一旦放在那里，**所有评论者的邮箱就是公开可读的**。
 * 因此备注支持两种落点：
 *   - 同图床仓库（方便，但邮箱会公开）
 *   - 独立的私有仓库（推荐，邮箱不外泄）
 * 界面会在第一次写入前把这件事讲清楚，让用户自己选。
 *
 * ## 同步策略
 *   - 拉取：远程文档与本地文档合并（按时间取新，墓碑优先），再写回本地
 *   - 推送：本地文档整体写入远程；带 sha 更新，冲突时先合并再重试一次
 *   - 时机：打开页面时拉一次；本地有改动时防抖推送
 */

import { GitHubClient, GitHubError } from './github.js';
import {
  DEFAULT_NOTES_PATH,
  loadNotesDoc,
  mergeDocs,
  normalizeDoc,
  saveNotesDoc,
  serializeDoc
} from './notes.js';
import { textToBase64 } from './hash.js';

/**
 * 解析备注文件应该落在哪个仓库/哪个路径。
 * @param {object} settings
 * @returns {{owner:string,repo:string,branch:string,path:string,separate:boolean,error?:string}}
 */
export function resolveNotesTarget(settings = {}) {
  const path = String(settings.notesPath || '').trim().replace(/^\/+/, '') || DEFAULT_NOTES_PATH;
  const raw = String(settings.notesRepo || '').trim();
  const bedBranch = String(settings.branch || 'main').trim() || 'main';

  if (!raw) {
    return {
      owner: String(settings.owner || '').trim(),
      repo: String(settings.repo || '').trim(),
      branch: bedBranch,
      path,
      separate: false
    };
  }

  // 支持 owner/repo 与 owner/repo@branch
  const [repoPart, branchPart] = raw.split('@');
  const pieces = String(repoPart).split('/').filter(Boolean);
  if (pieces.length !== 2) {
    return { owner: '', repo: '', branch: bedBranch, path, separate: true, error: '备注仓库格式应为 owner/repo 或 owner/repo@branch' };
  }
  return {
    owner: pieces[0],
    repo: pieces[1],
    branch: String(branchPart || '').trim() || bedBranch,
    path,
    separate: true
  };
}

/** 备注文件是否与图床仓库同一个（用于判断「邮箱是否会公开」）。 */
export function isNotesPublicInBedRepo(settings = {}) {
  const target = resolveNotesTarget(settings);
  return !target.separate;
}

const NOTES_COMMIT_MESSAGE = 'chore(notes): 更新头像邮箱备注';

export class NotesSync {
  /**
   * @param {{
   *   getSettings: () => object,
   *   createClient?: (target:object, settings:object) => object,
   *   onApplied?: (doc:object, info:object) => void,
   *   onStatus?: (status:object) => void,
   *   debounceMs?: number
   * }} options
   */
  constructor(options = {}) {
    this.getSettings = options.getSettings || (() => ({}));
    this.createClient =
      options.createClient ||
      ((target, settings) =>
        new GitHubClient({
          token: settings.token,
          owner: target.owner,
          repo: target.repo,
          branch: target.branch
        }));
    this.onApplied = options.onApplied || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 2500;

    this.state = 'idle';
    this.error = '';
    this.lastSyncAt = 0;
    this.count = 0;
    this.pulledAt = 0;

    this._sha = null;
    this._timer = null;
    this._inflight = null;
  }

  get enabled() {
    const settings = this.getSettings();
    if (settings.notesEnabled === false) return false;
    const target = resolveNotesTarget(settings);
    return Boolean(settings.token && target.owner && target.repo && !target.error);
  }

  _setState(state, error = '') {
    this.state = state;
    this.error = error;
    try {
      this.onStatus({ state, error, lastSyncAt: this.lastSyncAt, count: this.count });
    } catch {
      /* 状态回调里的异常不该影响同步 */
    }
  }

  /** 读取备注文件（不存在返回 null）。 */
  async pull({ force = false } = {}) {
    if (!this.enabled) {
      this._setState('off');
      return { pulled: false, reason: 'disabled' };
    }
    // 短时间内重复调用直接复用上一次结果，避免每次刷新列表都打一次 API
    if (!force && this.pulledAt && Date.now() - this.pulledAt < 30000) {
      return { pulled: false, reason: 'fresh' };
    }

    const target = resolveNotesTarget(this.getSettings());
    const client = this.createClient(target, this.getSettings());
    this._setState('pulling');

    try {
      const remote = await client.getFileText(target.path);
      if (!remote) {
        this.pulledAt = Date.now();
        this._setState('idle');
        return { pulled: true, remoteExists: false, entries: 0 };
      }

      const local = loadNotesDoc();
      const merged = mergeDocs(local, normalizeDoc(remote.text));
      const changed = JSON.stringify(normalizeDoc(local).entries) !== JSON.stringify(merged.entries);

      saveNotesDoc(merged);
      this._sha = remote.sha;
      this.pulledAt = Date.now();
      this.count = merged.entries.length;
      this._setState('idle');
      this.onApplied(merged, { source: 'remote', changed, remoteEntries: normalizeDoc(remote.text).entries.length });
      return { pulled: true, remoteExists: true, entries: merged.entries.length, changed };
    } catch (error) {
      this._setState('error', error.message);
      return { pulled: false, error };
    }
  }

  /** 把本地文档推到远程。 */
  async push({ force = false } = {}) {
    if (!this.enabled) {
      this._setState('off');
      return { pushed: false, reason: 'disabled' };
    }
    if (this._inflight) return this._inflight;

    this._inflight = (async () => {
      const settings = this.getSettings();
      const target = resolveNotesTarget(settings);
      const client = this.createClient(target, settings);
      this._setState('pushing');

      const write = async (doc, sha) => {
        const message = `${NOTES_COMMIT_MESSAGE}（${doc.entries.length} 条）`;
        const result = await client.putFile(target.path, textToBase64(serializeDoc(doc)), {
          message,
          sha,
          overwrite: true
        });
        return result;
      };

      try {
        // 还不知道远程 sha 时先看一眼：既避免 422，也顺手合并别的设备的改动
        if (this._sha === null) {
          const remote = await client.getFileText(target.path);
          if (remote) {
            this._sha = remote.sha;
            if (!force) {
              const merged = mergeDocs(loadNotesDoc(), normalizeDoc(remote.text));
              saveNotesDoc(merged);
              this.onApplied(merged, { source: 'remote', changed: true });
            }
          }
        }

        const doc = loadNotesDoc();
        const result = await write(doc, this._sha || undefined);
        this._sha = result.sha || this._sha;
        this.lastSyncAt = Date.now();
        this.count = doc.entries.length;
        this._setState('idle');
        return { pushed: true, skipped: Boolean(result.skipped), path: target.path, entries: doc.entries.length };
      } catch (error) {
        // 冲突：多半是别的设备刚改过。合并一次再重试。
        const conflict =
          error instanceof GitHubError &&
          (error.status === 409 || (error.status === 422 && /sha/i.test(String((error.body && error.body.message) || ''))));
        if (conflict) {
          try {
            const remote = await client.getFileText(target.path);
            this._sha = remote ? remote.sha : null;
            const merged = remote ? mergeDocs(loadNotesDoc(), normalizeDoc(remote.text)) : loadNotesDoc();
            saveNotesDoc(merged);
            this.onApplied(merged, { source: 'remote', changed: true });

            const retryDoc = loadNotesDoc();
            const retry = await write(retryDoc, this._sha || undefined);
            this._sha = retry.sha || this._sha;
            this.lastSyncAt = Date.now();
            this.count = retryDoc.entries.length;
            this._setState('idle');
            return { pushed: true, mergedConflict: true, entries: retryDoc.entries.length };
          } catch (retryError) {
            this._setState('error', retryError.message);
            return { pushed: false, error: retryError };
          }
        }
        this._setState('error', error.message);
        return { pushed: false, error };
      } finally {
        this._inflight = null;
      }
    })();

    return this._inflight;
  }

  /** 本地改动后调用：防抖推送。 */
  schedule() {
    if (!this.enabled) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.push().catch(() => {});
    }, this.debounceMs);
  }

  /** 立即推送（用于「立即同步」按钮或页面关闭前）。 */
  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    return this.push();
  }

  /** 拉取并合并（用于「立即拉取」按钮）。 */
  async refresh() {
    return this.pull({ force: true });
  }

  /** 换仓库/换路径后调用：清掉缓存的 sha，避免用错的 sha 去写。 */
  reset() {
    this._sha = null;
    this.pulledAt = 0;
    this._setState('idle');
  }

  cancel() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
