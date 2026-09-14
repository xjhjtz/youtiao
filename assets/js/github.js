/**
 * github.js —— GitHub REST API v3 客户端。
 *
 * 只用浏览器可直接调用的 REST 接口（GitHub API 支持 CORS，无需任何后端）：
 *   - 仓库信息 / 建库
 *   - Git Trees API 拉全量文件列表（比 Contents API 更适合「一次列出全部头像」）
 *   - Contents API 上传 / 更新 / 删除
 *   - Git Blobs API 取回内容（用于重命名）
 *
 * 全程携带用户自己的 PAT，不经过任何第三方服务器。
 */

import { base64ToText } from './hash.js';

const API_BASE = 'https://api.github.com';

/** 带状态码与原始响应体的错误，便于 UI 给出可操作的提示。 */
export class GitHubError extends Error {
  constructor(message, { status = 0, method = '', endpoint = '', body = null, rateLimit = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.method = method;
    this.endpoint = endpoint;
    this.body = body;
    this.rateLimit = rateLimit;
  }
}

/** 把 GitHub 的错误响应翻译成人话。 */
function humanize(status, payload, { method, endpoint }) {
  const raw = payload && payload.message ? payload.message : '';
  if (status === 401) return '令牌无效或已过期（401）。请重新生成一个有 repo 权限的 GitHub Token。';
  if (status === 403) {
    if (/rate limit/i.test(raw)) return '触发了 GitHub 速率限制（403）。请稍后重试，或检查令牌额度。';
    if (/Resource not accessible|not accessible by personal access token/i.test(raw)) {
      return '令牌权限不足（403）。细粒度令牌需要该仓库的 Contents: Read and write 权限。';
    }
    return `GitHub 拒绝访问（403）：${raw || '权限不足'}`;
  }
  if (status === 404) {
    if (/\/git\/trees|Git Repository is empty/i.test(raw)) return '仓库为空：还没有任何提交，请先创建一次初始提交（例如添加 README）。';
    return `未找到资源（404）：${method} ${endpoint}。常见原因：仓库名/分支名拼错、令牌无权访问该私有仓库。`;
  }
  if (status === 409) {
    // 空仓库（没有任何提交）在 git/trees 接口上返回的是 409 而不是 404
    if (/Git Repository is empty/i.test(raw)) {
      return '仓库是空的（还没有任何提交）。请先在 GitHub 上给仓库创建一次初始提交（例如添加 README），或在本工具的设置页点「创建仓库」。';
    }
    return `冲突（409）：${raw || '远端已被修改，请刷新后重试'}`;
  }
  if (status === 422) return `请求被拒绝（422）：${raw || '参数校验失败'}`;
  if (status >= 500) return `GitHub 服务器错误（${status}），请稍后重试。`;
  return `请求失败（${status}）：${raw || '未知错误'}`;
}

/** 并发受限的 map，避免一次性打爆 GitHub 速率限制。 */
export async function mapLimit(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));

  const runners = new Array(size).fill(0).map(async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = { ok: true, value: await worker(list[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

export class GitHubClient {
  /**
   * @param {{token:string, owner:string, repo:string, branch?:string}} options
   */
  constructor(options = {}) {
    this.token = String(options.token || '').trim();
    this.owner = String(options.owner || '').trim();
    this.repo = String(options.repo || '').trim();
    this.branch = String(options.branch || 'main').trim() || 'main';
    this.lastRateLimit = null;
  }

  get configured() {
    return Boolean(this.token && this.owner && this.repo);
  }

  get repoFullName() {
    return `${this.owner}/${this.repo}`;
  }

  async request(method, endpoint, { body } = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new GitHubError(`网络请求失败：${error && error.message ? error.message : error}`, {
        status: 0,
        method,
        endpoint
      });
    }

    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null) {
      this.lastRateLimit = {
        remaining: Number(remaining),
        limit: Number(response.headers.get('x-ratelimit-limit') || 0),
        reset: Number(response.headers.get('x-ratelimit-reset') || 0) * 1000
      };
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text.slice(0, 500) };
      }
    }

    if (!response.ok) {
      throw new GitHubError(humanize(response.status, payload, { method, endpoint }), {
        status: response.status,
        method,
        endpoint,
        body: payload,
        rateLimit: this.lastRateLimit
      });
    }
    return { data: payload, response };
  }

  /* --------------------------- 账号 / 仓库 --------------------------- */

  /** 取当前令牌对应的用户。 */
  async getUser() {
    const { data } = await this.request('GET', '/user');
    return data;
  }

  /** 取仓库信息（同时充当连通性测试）。 */
  async getRepo(owner = this.owner, repo = this.repo) {
    const { data } = await this.request('GET', `/repos/${owner}/${repo}`);
    return data;
  }

  /** 仓库是否存在（不存在返回 null，而不是抛错）。 */
  async tryGetRepo() {
    try {
      return await this.getRepo();
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /** 一键创建图床仓库。 */
  async createRepo({ name = this.repo, isPrivate = false, description = '', autoInit = true } = {}) {
    const { data } = await this.request('POST', '/user/repos', {
      body: {
        name,
        private: Boolean(isPrivate),
        description,
        auto_init: Boolean(autoInit),
        has_issues: false,
        has_wiki: false,
        has_projects: false
      }
    });
    return data;
  }

  /** 列分支（用于设置里的分支下拉）。 */
  async listBranches() {
    const { data } = await this.request('GET', `/repos/${this.owner}/${this.repo}/branches?per_page=100`);
    return Array.isArray(data) ? data.map((b) => b.name) : [];
  }

  /* ----------------------------- 文件树 ----------------------------- */

  /**
   * 拉取分支全量文件树。
   * @param {string} [prefix] 只保留该前缀下的 blob；留空则返回全部。
   * @param {{exclude?: string[]}} [options] exclude 里的路径会被剔除（例如备注文件）
   * @returns {Promise<{files:Array<{path:string,name:string,sha:string,size:number}>, truncated:boolean, total:number}>}
   */
  async listTree(prefix = '', options = {}) {
    const ref = encodeURIComponent(this.branch);
    const { data } = await this.request('GET', `/repos/${this.owner}/${this.repo}/git/trees/${ref}?recursive=1`);
    const tree = Array.isArray(data && data.tree) ? data.tree : [];

    const normalized = String(prefix || '').replace(/^\/+|\/+$/g, '');
    const exclude = new Set((options.exclude || []).map((p) => String(p).replace(/^\/+/, '')).filter(Boolean));
    const files = tree
      .filter((entry) => entry.type === 'blob')
      .filter((entry) => (normalized ? entry.path.startsWith(normalized + '/') : true))
      .filter((entry) => !exclude.has(entry.path))
      .map((entry) => {
        const idx = entry.path.lastIndexOf('/');
        return {
          path: entry.path,
          name: idx === -1 ? entry.path : entry.path.slice(idx + 1),
          sha: entry.sha,
          size: Number(entry.size || 0)
        };
      });

    return { files, truncated: Boolean(data && data.truncated), total: tree.length };
  }

  /** 取单个文件的元信息（含 sha），不存在返回 null。 */
  async getFileMeta(path) {
    const ref = encodeURIComponent(this.branch);
    try {
      const { data } = await this.request(
        'GET',
        `/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}?ref=${ref}`
      );
      if (!data || Array.isArray(data)) return null;
      return { path: data.path, sha: data.sha, size: data.size, downloadUrl: data.download_url };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /** 用 blob sha 取回文件内容（base64，已去掉折行）。 */
  async getBlobBase64(sha) {
    const { data } = await this.request('GET', `/repos/${this.owner}/${this.repo}/git/blobs/${sha}`);
    if (!data || typeof data.content !== 'string') throw new GitHubError('无法读取文件内容', { status: 0 });
    return data.content.replace(/[\r\n\s]/g, '');
  }

  /**
   * 读取仓库里的一个文本文件（内容 + sha）。不存在时返回 null 而不是抛错。
   * 备注文件就是靠它读出来的。
   * @returns {Promise<{text:string, sha:string, size:number}|null>}
   */
  async getFileText(path) {
    const ref = encodeURIComponent(this.branch);
    try {
      const { data } = await this.request(
        'GET',
        `/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}?ref=${ref}`
      );
      if (!data || Array.isArray(data) || typeof data.content !== 'string') return null;
      return { text: base64ToText(data.content), sha: data.sha, size: Number(data.size || 0) };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /* --------------------------- 写入 / 删除 --------------------------- */

  /**
   * 上传或更新一个文件。
   * @param {string} path 仓库内路径
   * @param {string} base64Content 文件内容的 base64（不带 data: 前缀）
   * @param {{message?:string, sha?:string, overwrite?:boolean, author?:{name:string,email:string}}} [options]
   * @returns {Promise<{created:boolean, updated:boolean, skipped:boolean, commit:string, path:string, sha:string}>}
   */
  async putFile(path, base64Content, options = {}) {
    const message = options.message || `avatar: update ${path}`;
    const author = options.author && options.author.name ? options.author : undefined;

    const send = async (sha) => {
      const body = { message, content: base64Content, branch: this.branch };
      if (sha) body.sha = sha;
      if (author) {
        body.committer = author;
        body.author = author;
      }
      const { data } = await this.request(
        'PUT',
        `/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}`,
        { body }
      );
      return data;
    };

    try {
      const data = await send(options.sha);
      return {
        created: !options.sha,
        updated: Boolean(options.sha),
        skipped: false,
        commit: data && data.commit ? data.commit.sha : '',
        path,
        sha: data && data.content ? data.content.sha : ''
      };
    } catch (error) {
      const existsWithoutSha =
        error instanceof GitHubError &&
        error.status === 422 &&
        !options.sha &&
        /sha/i.test(String((error.body && error.body.message) || ''));

      if (!existsWithoutSha) throw error;

      // 文件已存在：按配置决定覆盖还是跳过
      const existing = await this.getFileMeta(path);
      if (!existing) throw error;
      if (!options.overwrite) {
        return { created: false, updated: false, skipped: true, commit: '', path, sha: existing.sha };
      }
      const data = await send(existing.sha);
      return {
        created: false,
        updated: true,
        skipped: false,
        commit: data && data.commit ? data.commit.sha : '',
        path,
        sha: data && data.content ? data.content.sha : ''
      };
    }
  }

  /** 删除文件（需要 sha）。 */
  async deleteFile(path, sha, options = {}) {
    const message = options.message || `avatar: delete ${path}`;
    const { data } = await this.request(
      'DELETE',
      `/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}`,
      { body: { message, sha, branch: this.branch } }
    );
    return { commit: data && data.commit ? data.commit.sha : '', path };
  }

  /**
   * 重命名 / 移动文件：先在新路径写入同样内容，再删掉旧路径。
   * @returns {Promise<{from:string,to:string}>}
   */
  async moveFile(fromPath, toPath, oldSha, options = {}) {
    const content = await this.getBlobBase64(oldSha);
    await this.putFile(toPath, content, {
      message: options.message || `avatar: rename ${fromPath} -> ${toPath}`,
      overwrite: Boolean(options.overwrite),
      author: options.author
    });
    await this.deleteFile(fromPath, oldSha, {
      message: options.message || `avatar: rename ${fromPath} -> ${toPath}`
    });
    return { from: fromPath, to: toPath };
  }
}

/** 对路径逐段做 URL 编码（保留 `/`）。 */
function encodePath(path) {
  return String(path || '')
    .split('/')
    .filter((s) => s !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export { encodePath, API_BASE };
