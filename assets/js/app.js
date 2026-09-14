/**
 * app.js —— 油条 主应用。
 *
 * 架构：完全静态的零后端单页应用。
 *   - 逻辑层：hash / paths / cdn / github / format（纯函数，已被 node --test 覆盖）
 *   - 状态层：config（设置）、history（邮箱↔哈希本地备注）
 *   - 视图层：本文件 + ui.js
 *
 * 所有网络请求都从用户自己的浏览器直连 api.github.com 与 jsDelivr，不经过任何中间服务器。
 */

import {
  normalizeMail,
  emailToFileName,
  isQQMail
} from './hash.js';
import {
  normalizePrefix,
  buildRepoPath,
  fileNameOf,
  extensionOf,
  emailFromFileName,
  looksLikeEmail
} from './paths.js';
import {
  CDN_PRESETS,
  getPreset,
  buildCdnBase,
  buildFileUrl,
  buildTwikooRequestUrl,
  buildPurgeUrl,
  purgeSupport,
  toTwikooValue,
  describeEmail,
  describeEmails
} from './cdn.js';
import { GitHubClient, GitHubError, mapLimit } from './github.js';
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
  uniqueBy
} from './format.js';
import {
  loadSettings,
  saveSettings,
  clearSettings,
  loadTheme,
  saveTheme,
  DEFAULT_SETTINGS
} from './config.js';
import {
  loadNotesDoc,
  saveNotesDoc,
  upsertEntries,
  tombstoneEntries,
  entriesOf,
  notesIndex,
  annotateFiles,
  exportNotes,
  importNotes,
  clearNotes,
  DEFAULT_NOTES_PATH
} from './notes.js';
import { NotesSync, resolveNotesTarget, isNotesPublicInBedRepo } from './notes-sync.js';
import {
  isImageFile,
  fileToBase64,
  compressImage,
  blobToBase64,
  base64ToBlob,
  sniffImageType,
  triggerDownload
} from './image.js';
import {
  $,
  toast,
  confirmDialog,
  promptDialog,
  choiceDialog,
  noticeDialog,
  copyWithToast,
  openLightbox,
  applyTheme,
  toggleTheme,
  debounce,
  setBusy,
  activateTab
} from './ui.js';

/* ==================================================================== *
 * 状态
 * ==================================================================== */

const state = {
  settings: loadSettings(),
  client: null,
  repo: null,
  /** 仓库中本目录下的全部文件（带 email 备注） */
  files: [],
  /** 过滤 + 排序后的结果 */
  view: [],
  selection: new Set(),
  page: 1,
  pageSize: 60,
  search: '',
  sort: 'name',
  queue: [],
  links: [],
  busy: false,
  logLines: []
};

const MAX_LOG_LINES = 600;

/* ==================================================================== *
 * 小工具
 * ==================================================================== */

const cdnConfig = () => ({
  owner: state.settings.owner,
  repo: state.settings.repo,
  branch: state.settings.branch,
  prefix: state.settings.prefix,
  preset: state.settings.preset,
  customTemplate: state.settings.customTemplate
});

function commitMessage(action, ctx = {}) {
  const tpl = state.settings.commitTemplate || 'avatar: {action} {hash}';
  return tpl
    .replace(/\{action\}/g, action)
    .replace(/\{hash\}/g, ctx.hash || '')
    .replace(/\{path\}/g, ctx.path || '')
    .replace(/\{email\}/g, ctx.email || '');
}

/** 把 base64 内容按魔数还原成 Blob（下载仓库原图时用）。 */
function blobFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const { mime, ext } = sniffImageType(bytes);
  return { blob: base64ToBlob(base64, mime), mime, ext };
}

function pushLog(line) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  state.logLines.push(`[${stamp}] ${line}`);
  if (state.logLines.length > MAX_LOG_LINES) state.logLines.splice(0, state.logLines.length - MAX_LOG_LINES);

  const box = $('#uploadLog');
  if (box) {
    box.hidden = false;
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.textContent = state.logLines.join('\n');
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}

function existingFileByPath(path) {
  return state.files.find((f) => f.path === path) || null;
}

function setConnectionChip(text, kind = '') {
  const chip = $('#connChip');
  chip.textContent = text;
  chip.className = `chip chip-btn ${kind}`;
}

function renderRateChip() {
  const chip = $('#rateChip');
  const rl = state.client && state.client.lastRateLimit;
  if (!rl || !Number.isFinite(rl.remaining)) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const limit = rl.limit || '?';
  chip.textContent = `API 余量 ${rl.remaining}/${limit}`;
  chip.className = `chip ${rl.remaining < 50 ? 'chip-warn' : ''}`;
  // 悬停时把「这是什么、什么时候恢复」讲清楚，避免只看到一个孤立数字
  const resetText = rl.reset ? `，额度将在 ${new Date(rl.reset).toLocaleString('zh-CN')} 重置` : '';
  chip.title =
    `GitHub API 每小时调用额度，剩余 ${rl.remaining}/${limit}${resetText}。\n` +
    '列文件、上传、删除、同步备注都会消耗它；访客加载头像是走 jsDelivr，不消耗这个额度。';
}

function settingsReady() {
  const s = state.settings;
  return Boolean(s.token && s.owner && s.repo);
}

/* ------------------------------------------------------------------ *
 * CDN 缓存刷新
 *
 * jsDelivr 会长时间缓存文件（最长 7 天）。头像被覆盖后如果不清缓存，
 * 评论者看到的仍是旧头像——这是头像图床最容易踩的坑，所以覆盖/删除后默认自动 purge。
 * ------------------------------------------------------------------ */

async function purgePaths(paths, { silent = false } = {}) {
  const list = [...new Set((paths || []).filter(Boolean))];
  if (!list.length) return { ok: 0, fail: 0 };

  const cfg = cdnConfig();
  const support = purgeSupport(cfg);
  if (!support.supported) {
    if (!silent) {
      await noticeDialog({
        title: '这条线路刷新不了缓存',
        html:
          `<p>${escapeHtml(support.reason)}</p>` +
          `<p><strong>那怎么办：</strong></p>` +
          `<p>${escapeHtml(support.workaround).replace(/\n/g, '<br>')}</p>`
      });
    }
    return { ok: 0, fail: 0, unsupported: true };
  }

  const urls = list.map((p) => buildPurgeUrl(cfg, p)).filter(Boolean);
  const results = await mapLimit(urls, 2, async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json().catch(() => ({}));
  });

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  pushLog(`[缓存] 刷新 ${ok} 个文件${fail ? `，失败 ${fail} 个` : ''}`);
  if (!silent) {
    if (!fail) toast(`已刷新 ${ok} 个文件的 CDN 缓存`, 'ok');
    else toast(`缓存刷新：成功 ${ok} · 失败 ${fail}`, 'warn', 6000);
  }
  return { ok, fail };
}

/** 每个会话只提醒一次「当前线路刷新不了缓存」，避免每次上传都弹。 */
let purgeUnsupportedWarned = false;

/** 覆盖或删除后静默刷新缓存（按设置项决定是否执行）。 */
function autoPurge(paths) {
  if (state.settings.autoPurge === false) return;

  const support = purgeSupport(cdnConfig());
  if (!support.supported) {
    if (!purgeUnsupportedWarned) {
      purgeUnsupportedWarned = true;
      const label = getPreset(state.settings.preset).label;
      pushLog(`[缓存] 当前线路（${label}）不支持 purge，覆盖后要等缓存过期才会更新`);
      toast(
        `注意：${label} 刷新不了缓存，覆盖头像后不会立即生效（最长约 24 小时）。点图库里的「刷缓存」可以看到替代方案。`,
        'warn',
        9000
      );
    }
    return;
  }

  purgePaths(paths, { silent: true }).catch(() => {
    /* 缓存刷新失败不该影响主流程 */
  });
}

/* ------------------------------------------------------------------ *
 * 备注同步（本地缓存 + GitHub 仓库）
 *
 * 备注就是「邮箱 ↔ 哈希」的对应关系。SHA-256 不可逆，备注一丢，
 * 那些头像是谁的邮箱就永远查不回来了 —— 所以不该只存在浏览器里。
 *
 * 但这里有一个隐私上的反转必须讲清楚：图床仓库必须是公开的（jsDelivr 只能读公开仓库），
 * 备注一旦写进同一个仓库，所有评论者的邮箱就是公开可读的。
 * 因此第一次写入前会让用户明确选一次，并推荐放进一个独立的私有仓库。
 * ------------------------------------------------------------------ */

let notesSync = null;

function initNotesSync() {
  notesSync = new NotesSync({
    getSettings: () => state.settings,
    onApplied: (doc, info) => {
      if (info && info.changed) {
        // 远程带来的新备注：重新标注图库里的邮箱
        const index = notesIndex(entriesOf(doc));
        state.files = annotateFiles(state.files, index);
        applyFilters({ keepPage: true });
        renderGallery();
      }
      renderNotesStatus();
    },
    onStatus: () => renderNotesStatus()
  });
  return notesSync;
}

function syncNotesSoon() {
  if (!notesSync || !notesSync.enabled) {
    renderNotesStatus();
    return;
  }
  ensureNotesConsent()
    .then((allowed) => {
      if (allowed) notesSync.schedule();
    })
    .catch(() => {});
}

/**
 * 第一次写备注前，把「邮箱会不会公开」这件事讲清楚。
 * @returns {Promise<boolean>} 是否允许写入远程
 */
async function ensureNotesConsent() {
  const settings = state.settings;
  if (settings.notesEnabled === false) return false;
  if (settings.notesPublicAck) return true;

  // 已经单独指定了备注仓库（通常是私有仓库）→ 用户显然清楚自己在做什么
  if (String(settings.notesRepo || '').trim()) {
    persist({ notesPublicAck: true });
    return true;
  }

  const choice = await choiceDialog({
    title: '备注要存到哪里？',
    html: `
      <p>备注是「邮箱 ↔ 哈希」的对应关系。<strong>SHA-256 不可逆</strong>，备注一丢，就再也没法知道某个头像是谁的邮箱了，
         所以不建议只放在浏览器里。</p>
      <p>但要注意：图床仓库<strong>必须是公开的</strong>（jsDelivr 只能读公开仓库），
         备注写进那里 = <strong>所有评论者的邮箱都会公开可读</strong>。</p>`,
    options: [
      {
        label: '放进一个独立的私有仓库（推荐）',
        value: 'private',
        primary: true,
        description: '备注能跨设备保留，邮箱又不外泄。可以直接帮你创建一个私有仓库。'
      },
      {
        label: '就写进图床仓库，我知道邮箱会公开',
        value: 'public',
        description: '最省事，但仓库是公开的，任何人都能下载这个文件看到邮箱。'
      },
      {
        label: '只存本地，不同步',
        value: 'local',
        description: '邮箱不外泄，但清一次浏览器缓存或换台设备，备注就没了。'
      }
    ]
  });

  if (choice === 'private') {
    const name = await promptDialog({
      title: '新建私有备注仓库',
      label: '仓库名',
      value: 'youtiao-notes',
      help: '会在你的账号下创建一个私有仓库，备注只写在那里。',
      confirmText: '创建并使用'
    });
    if (name === null) return false;
    const repoName = name.trim() || 'youtiao-notes';
    try {
      rebuildClient();
      const user = await state.client.getUser();
      await state.client.createRepo({
        name: repoName,
        isPrivate: true,
        description: '油条 · 头像邮箱备注（私有）',
        autoInit: true
      });
      persist({ notesRepo: `${user.login}/${repoName}`, notesPublicAck: true });
      fillSettingsForm();
      notesSync.reset();
      toast(`私有备注仓库 ${user.login}/${repoName} 已创建，备注将同步到那里`, 'ok', 6000);
      return true;
    } catch (error) {
      toast(`创建私有仓库失败：${error.message}`, 'err', 8000);
      return false;
    }
  }

  if (choice === 'public') {
    persist({ notesPublicAck: true, notesEnabled: true });
    renderNotesStatus();
    return true;
  }

  // 选择「只存本地」或直接关掉对话框
  persist({ notesEnabled: false });
  fillSettingsForm();
  renderNotesStatus();
  toast('备注将只保存在本浏览器里', 'warn', 5000);
  return false;
}

function renderNotesStatus() {
  const box = $('#notesStatus');
  if (!box) return;

  const count = entriesOf(loadNotesDoc()).length;
  const target = resolveNotesTarget(state.settings);
  const set = (cls, text) => {
    box.className = `notes-status ${cls}`;
    box.innerHTML = `<span class="dot"></span><span>${escapeHtml(text)}</span>`;
  };

  if (state.settings.notesEnabled === false) {
    set('', `仅本地：${count} 条备注（未同步；清缓存或换设备会丢失）`);
    return;
  }
  if (!settingsReady()) {
    set('', `本地 ${count} 条备注；配置好令牌与仓库后即可同步`);
    return;
  }
  if (target.error) {
    set('err', `备注仓库配置有误：${target.error}`);
    return;
  }

  // 备注与图床同仓库 = 写进一个必须公开的仓库 = 邮箱会公开
  const exposed = isNotesPublicInBedRepo(state.settings);
  const where = target.separate
    ? `独立仓库 ${target.owner}/${target.repo}@${target.branch}`
    : `图床仓库 ${target.owner}/${target.repo}${exposed ? '（公开，邮箱会公开）' : ''}`;

  if (notesSync && notesSync.state === 'error') {
    set('err', `同步失败：${notesSync.error}`);
    return;
  }
  if (notesSync && (notesSync.state === 'pushing' || notesSync.state === 'pulling')) {
    set('busy', notesSync.state === 'pushing' ? '正在同步备注…' : '正在拉取备注…');
    return;
  }
  if (notesSync && notesSync.lastSyncAt) {
    set('ok', `已同步 ${count} 条备注到 ${where} · ${fmtDateTime(notesSync.lastSyncAt)}`);
    return;
  }
  set('', `本地 ${count} 条备注；尚未同步到 ${where}`);
}

/* ==================================================================== *
 * 启动
 * ==================================================================== */

function init() {
  applyTheme(loadTheme());
  state.settings = loadSettings();
  initNotesSync();

  bindTabs();
  bindSettings();
  bindUpload();
  bindGallery();
  bindCdn();
  fillPresetSelects();
  fillSettingsForm();
  renderEmailPreview();
  renderCdnPanel();
  renderNotesStatus();
  renderGallery();

  if (settingsReady()) {
    connect({ silent: true });
  } else {
    setConnectionChip('未配置仓库');
  }
}

function bindTabs() {
  $('#tabs').addEventListener('click', (event) => {
    const btn = event.target.closest('.tab');
    if (btn) activateTab(btn.dataset.tab);
  });

  $('#themeToggle').addEventListener('click', () => {
    const next = toggleTheme(loadTheme());
    applyTheme(next);
    saveTheme(next);
  });

  $('#connChip').addEventListener('click', () => {
    if (!settingsReady()) {
      activateTab('settings');
      toast('先在设置页填写令牌与仓库信息', 'warn');
      return;
    }
    connect({ silent: false });
  });

  // 弹窗里的输入框：回车直接确认
  $('#modalBody').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.id === 'modalInput') {
      event.preventDefault();
      $('#modalConfirm').click();
    }
  });

  // 复制按钮（静态声明式）
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-copy-target]');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.copyTarget);
    if (target) copyWithToast(target.textContent.trim());
  });
}

/* ==================================================================== *
 * 连接
 * ==================================================================== */

function rebuildClient() {
  state.client = new GitHubClient({
    token: state.settings.token,
    owner: state.settings.owner,
    repo: state.settings.repo,
    branch: state.settings.branch
  });
  return state.client;
}

async function connect({ silent = false } = {}) {
  if (!settingsReady()) {
    toast('请先填写令牌、仓库所有者与仓库名', 'warn');
    setConnectionChip('未配置仓库');
    return null;
  }
  rebuildClient();
  setConnectionChip('连接中…');
  try {
    const repo = await state.client.getRepo();
    state.repo = repo;
    setConnectionChip(`已连接 ${repo.full_name}`, 'chip-ok');
    renderRateChip();
    renderRepoInfo(repo);
    if (!silent) toast(`连接成功：${repo.full_name}（${repo.private ? '私有' : '公开'}）`, 'ok');
    if (repo.private) toast('该仓库是私有的，jsDelivr 无法读取，请改为公开仓库', 'warn', 6000);
    await loadGallery({ silent: true });
    return repo;
  } catch (error) {
    setConnectionChip('连接失败', 'chip-err');
    if (!silent) toast(error.message, 'err', 7000);
    renderRepoInfoError(error);
    return null;
  }
}

function renderRepoInfo(repo) {
  const box = $('#repoInfo');
  box.hidden = false;
  box.className = 'info-box';
  const push = repo.permissions ? repo.permissions.push : undefined;
  box.innerHTML = `
    <div><strong>${escapeHtml(repo.full_name)}</strong> ${repo.private ? '<span class="warn">（私有仓库，jsDelivr 不可用）</span>' : '<span class="ok">（公开，CDN 可用）</span>'}</div>
    <div class="small">默认分支：<code>${escapeHtml(repo.default_branch || '—')}</code> · 仓库体积：${humanSize((repo.size || 0) * 1024)} · 写入权限：${
      push === true ? '<span class="ok">有</span>' : push === false ? '<span class="err">无</span>' : '<span class="muted">未知</span>'
    }</div>`;
}

function renderRepoInfoError(error) {
  const box = $('#repoInfo');
  box.hidden = false;
  box.className = 'info-box error';
  box.textContent = error && error.message ? error.message : String(error);
}

/* ==================================================================== *
 * 设置面板
 * ==================================================================== */

function fillPresetSelects() {
  const options = CDN_PRESETS.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
  $('#cdnPreset').innerHTML = options;
  $('#settingsPreset').innerHTML = options;
}

function fillSettingsForm() {
  const s = state.settings;
  $('#tokenInput').value = s.token || '';
  $('#tokenStorage').value = s.tokenStorage || 'local';
  $('#ownerInput').value = s.owner || '';
  $('#repoInput').value = s.repo || '';
  $('#branchInput').value = s.branch || 'main';
  $('#prefixInput').value = s.prefix || 'avatar';
  $('#algorithmSelect').value = s.algorithm || 'sha256';
  $('#settingsPreset').value = s.preset || 'jsdmirror';
  $('#cdnPreset').value = s.preset || 'jsdmirror';
  $('#customTemplate').value = s.customTemplate || '';
  $('#keepExtChk').checked = Boolean(s.keepExtension);
  $('#autoPurgeChk').checked = s.autoPurge !== false;
  $('#defaultGravatar').value = s.defaultGravatar || 'mp';
  $('#concurrencyInput').value = s.concurrency || 3;
  $('#maxEdgeInput').value = s.maxEdge || 512;
  $('#commitTemplateInput').value = s.commitTemplate || 'avatar: {action} {hash}';
  $('#overwriteChk').checked = s.overwrite !== false;
  $('#compressChk').checked = Boolean(s.compress);
  $('#notesEnabledChk').checked = s.notesEnabled !== false;
  $('#notesPathInput').value = s.notesPath || DEFAULT_NOTES_PATH;
  $('#notesRepoInput').value = s.notesRepo || '';
  updatePrefixWarning();
}

function collectSettingsForm() {
  return {
    ...state.settings,
    token: $('#tokenInput').value.trim(),
    tokenStorage: $('#tokenStorage').value,
    owner: $('#ownerInput').value.trim(),
    repo: $('#repoInput').value.trim(),
    branch: $('#branchInput').value.trim() || 'main',
    prefix: normalizePrefix($('#prefixInput').value),
    algorithm: $('#algorithmSelect').value,
    preset: $('#settingsPreset').value,
    customTemplate: $('#customTemplate').value.trim(),
    keepExtension: $('#keepExtChk').checked,
    autoPurge: $('#autoPurgeChk').checked,
    defaultGravatar: $('#defaultGravatar').value,
    concurrency: Math.min(10, Math.max(1, Number($('#concurrencyInput').value) || 3)),
    maxEdge: Math.min(4096, Math.max(16, Number($('#maxEdgeInput').value) || 512)),
    commitTemplate: $('#commitTemplateInput').value.trim() || DEFAULT_SETTINGS.commitTemplate,
    overwrite: $('#overwriteChk').checked,
    compress: $('#compressChk').checked,
    notesEnabled: $('#notesEnabledChk').checked,
    notesPath: $('#notesPathInput').value.trim() || DEFAULT_NOTES_PATH,
    notesRepo: $('#notesRepoInput').value.trim()
  };
}

/** 保存设置并刷新所有依赖视图。 */
function persist(patch = {}, { announce = false } = {}) {
  state.settings = { ...state.settings, ...patch };
  try {
    saveSettings(state.settings);
  } catch (error) {
    toast(error.message, 'err', 6000);
    return false;
  }
  updatePrefixWarning();
  renderEmailPreview();
  renderCdnPanel();
  if (state.view.length || state.files.length) renderGallery();
  if (announce) toast('设置已保存', 'ok');
  return true;
}

function updatePrefixWarning() {
  const prefix = normalizePrefix($('#prefixInput').value);
  const algo = $('#algorithmSelect').value;
  $('#prefixWarn').hidden = prefix === 'avatar';
  $('#algoWarn').hidden = algo !== 'md5';
}

function bindSettings() {
  $('#saveSettings').addEventListener('click', () => {
    const next = collectSettingsForm();
    const before = { ...state.settings };
    state.settings = next;
    if (!persist({}, { announce: false })) {
      state.settings = before;
      return;
    }
    $('#settingsPreset').value = next.preset;
    $('#cdnPreset').value = next.preset;
    toast('设置已保存', 'ok');
    if (settingsReady()) connect({ silent: true });
  });

  $('#testConn').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const next = collectSettingsForm();
    state.settings = next;
    saveSettings(state.settings);
    setBusy(btn, true, '测试中…');
    try {
      await connect({ silent: false });
    } finally {
      setBusy(btn, false);
    }
  });

  $('#loadBranches').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    if (!settingsReady()) {
      toast('先填写令牌与仓库信息', 'warn');
      return;
    }
    setBusy(btn, true, '读取中…');
    try {
      rebuildClient();
      const branches = await state.client.listBranches();
      $('#branchList').innerHTML = branches.map((b) => `<option value="${escapeHtml(b)}"></option>`).join('');
      toast(branches.length ? `共 ${branches.length} 个分支：${branches.slice(0, 6).join(', ')}` : '该仓库还没有任何分支', 'ok');
    } catch (error) {
      toast(error.message, 'err', 7000);
    } finally {
      setBusy(btn, false);
    }
  });

  $('#createRepo').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const name = $('#repoInput').value.trim();
    if (!state.settings.token) {
      toast('先填写令牌', 'warn');
      return;
    }
    if (!name) {
      toast('先填写仓库名', 'warn');
      return;
    }
    const ok = await confirmDialog({
      title: '创建图床仓库',
      html: `<p>将创建一个名为 <code>${escapeHtml(name)}</code> 的<strong>公开</strong>仓库，并自动生成初始提交。</p>
             <p class="muted small">jsDelivr 只能读取公开仓库，所以这里固定创建公开仓库。</p>`,
      confirmText: '创建'
    });
    if (!ok) return;

    setBusy(btn, true, '创建中…');
    try {
      rebuildClient();
      await state.client.createRepo({ name, isPrivate: false, description: '油条 头像图床', autoInit: true });
      toast('仓库创建成功', 'ok');
      await connect({ silent: true });
      activateTab('settings');
    } catch (error) {
      toast(error.message, 'err', 7000);
    } finally {
      setBusy(btn, false);
    }
  });

  $('#toggleToken').addEventListener('click', (event) => {
    const input = $('#tokenInput');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    event.currentTarget.textContent = show ? '隐藏' : '显示';
  });

  ['#prefixInput', '#algorithmSelect'].forEach((sel) =>
    $(sel).addEventListener('input', updatePrefixWarning)
  );
  $('#algorithmSelect').addEventListener('change', updatePrefixWarning);

  // 设置页里的预设下拉与 CDN 页联动
  $('#settingsPreset').addEventListener('change', (event) => {
    $('#cdnPreset').value = event.target.value;
    persist({ preset: event.target.value });
  });

  $('#keepExtChk').addEventListener('change', () => renderEmailPreview());
  $('#autoPurgeChk').addEventListener('change', () => persist({ autoPurge: $('#autoPurgeChk').checked }));
  $('#defaultGravatar').addEventListener('change', () => persist({ defaultGravatar: $('#defaultGravatar').value }));

  /* --------------------------- 备注同步 --------------------------- */

  $('#notesEnabledChk').addEventListener('change', () => {
    const enabled = $('#notesEnabledChk').checked;
    persist({ notesEnabled: enabled });
    renderNotesStatus();
    if (enabled) {
      ensureNotesConsent().then((ok) => ok && notesSync.flush());
    }
  });

  $('#notesPathInput').addEventListener(
    'change',
    () => {
      persist({ notesPath: $('#notesPathInput').value.trim() || DEFAULT_NOTES_PATH });
      notesSync.reset();
      renderNotesStatus();
    }
  );

  $('#notesRepoInput').addEventListener(
    'change',
    () => {
      persist({ notesRepo: $('#notesRepoInput').value.trim(), notesPublicAck: true });
      notesSync.reset();
      renderNotesStatus();
    }
  );

  $('#notesSyncNow').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    if (!notesSync.enabled) {
      toast('备注同步未开启，或还没配置好令牌与仓库', 'warn');
      return;
    }
    setBusy(btn, true, '同步中…');
    try {
      const result = await notesSync.flush();
      if (result.pushed) toast(`已同步 ${result.entries} 条备注到仓库`, 'ok');
      else toast(`同步失败：${(result.error && result.error.message) || '未知原因'}`, 'err', 7000);
    } finally {
      setBusy(btn, false);
      renderNotesStatus();
    }
  });

  $('#notesPullNow').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    setBusy(btn, true, '拉取中…');
    try {
      const result = await notesSync.refresh();
      renderNotesStatus();
      if (result.pulled) {
        toast(result.remoteExists ? `已从仓库拉取并合并备注（共 ${result.entries} 条）` : '仓库里还没有备注文件', 'ok');
        renderGallery();
      } else {
        toast(`拉取失败：${(result.error && result.error.message) || '未知原因'}`, 'err', 7000);
      }
    } finally {
      setBusy(btn, false);
    }
  });

  $('#notesCreateRepo').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    if (!state.settings.token) {
      toast('先填写并保存 GitHub 令牌', 'warn');
      return;
    }
    const name = await promptDialog({
      title: '新建私有备注仓库',
      label: '仓库名',
      value: 'youtiao-notes',
      help: '会在你的账号下创建一个私有仓库，专门用来存备注文件（邮箱不会公开）。',
      confirmText: '创建并使用'
    });
    if (!name) return;
    setBusy(btn, true, '创建中…');
    try {
      rebuildClient();
      const user = await state.client.getUser();
      await state.client.createRepo({
        name: name.trim(),
        isPrivate: true,
        description: '油条 · 头像邮箱备注（私有）',
        autoInit: true
      });
      persist({ notesRepo: `${user.login}/${name.trim()}`, notesPublicAck: true, notesEnabled: true }, { announce: false });
      fillSettingsForm();
      notesSync.reset();
      toast(`私有备注仓库 ${user.login}/${name.trim()} 已创建，备注将同步到那里`, 'ok', 6000);
      renderNotesStatus();
      notesSync.schedule();
    } catch (error) {
      toast(`创建失败：${error.message}`, 'err', 8000);
    } finally {
      setBusy(btn, false);
    }
  });

  /* --------------------------- 备份 / 恢复 --------------------------- */

  $('#exportAll').addEventListener('click', async () => {
    const payload = {
      ...exportNotes(),
      settings: { ...state.settings, token: $('#tokenInput').value.trim() },
      exportedFrom: 'youtiao'
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `youtiao-backup-${new Date().toISOString().slice(0, 10)}.json`);
    toast('已导出（含令牌，请妥善保管）', 'warn');
  });

  $('#importAll').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const result = importNotes(payload);
      if (payload.settings) {
        state.settings = { ...state.settings, ...payload.settings };
        saveSettings(state.settings);
        fillSettingsForm();
        renderCdnPanel();
        renderEmailPreview();
      }
      toast(`导入成功：备注 ${result.imported} 条（本地共 ${result.total} 条）`, 'ok');
      renderNotesStatus();
      renderGallery();
      notesSync.schedule();
    } catch (error) {
      toast(`导入失败：${error.message}`, 'err', 6000);
    }
  });

  $('#clearHistory').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '清空备注',
      text: '将删除「邮箱 ↔ 哈希」的全部记录（本地和仓库里的备注文件都会清空）。仓库里的图片不受影响，但这些邮箱备注将无法恢复。',
      confirmText: '清空',
      danger: true
    });
    if (!ok) return;
    clearNotes();
    toast('备注已清空', 'ok');
    renderNotesStatus();
    renderGallery();
    notesSync.schedule();
  });

  $('#resetSettings').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '重置全部设置',
      text: '将清除令牌与所有配置（不会删除仓库里的图片，也不会清除邮箱备注）。',
      confirmText: '重置',
      danger: true
    });
    if (!ok) return;
    clearSettings();
    state.settings = { ...DEFAULT_SETTINGS, token: '' };
    fillSettingsForm();
    renderCdnPanel();
    renderEmailPreview();
    setConnectionChip('未配置仓库');
    state.files = [];
    state.view = [];
    renderGallery();
    toast('已重置，请重新填写令牌', 'ok');
  });
}

/* ==================================================================== *
 * 上传
 * ==================================================================== */

function bindUpload() {
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragover');
    })
  );
  dropzone.addEventListener('drop', (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) addFiles(files);
  });

  fileInput.addEventListener('change', (event) => {
    if (event.target.files && event.target.files.length) addFiles(event.target.files);
    event.target.value = '';
  });

  // 剪贴板粘贴图片
  document.addEventListener('paste', (event) => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file && isImageFile(file)) files.push(file);
      }
    }
    if (!files.length) return;
    event.preventDefault();
    if (!document.querySelector('#tab-upload').classList.contains('active')) activateTab('upload');
    addFiles(files);
  });

  $('#emailInput').addEventListener('input', debounce(renderEmailPreview, 120));
  $('#batchByFilename').addEventListener('change', renderEmailPreview);
  $('#overwriteChk').addEventListener('change', () => persist({ overwrite: $('#overwriteChk').checked }));
  $('#compressChk').addEventListener('change', () => persist({ compress: $('#compressChk').checked }));

  $('#uploadBtn').addEventListener('click', startUpload);
  $('#clearQueue').addEventListener('click', () => {
    state.queue.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    state.queue = [];
    renderQueue();
  });
}

function renderEmailPreview() {
  const box = $('#emailPreview');
  const email = $('#emailInput').value.trim();
  const batch = $('#batchByFilename').checked;

  if (!email && !batch) {
    box.className = 'preview-box muted';
    box.textContent = '填入邮箱后这里会实时显示哈希、仓库路径与最终 URL';
    return;
  }

  if (batch) {
    box.className = 'preview-box';
    box.innerHTML =
      '<div class="label">批量模式已开启：</div>' +
      '<div class="val">每个图片的<strong>文件名</strong>会被当作邮箱（自动剥掉图片扩展名）。例如 <code>alice@example.com.png</code> → <code>alice@example.com</code>。</div>' +
      '<div class="label" style="margin-top:6px">这里的邮箱输入框将被忽略（文件名不是邮箱的图片会被跳过）。</div>';
    return;
  }

  const info = describeEmail(state.settings, email);
  const path = buildRepoPath(info.hash, {
    prefix: state.settings.prefix,
    keepExtension: state.settings.keepExtension,
    extension: ''
  });
  const url = buildFileUrl(state.settings, path);
  const existing = existingFileByPath(path);
  const qq = isQQMail(email);
  const prefixOk = normalizePrefix(state.settings.prefix) === 'avatar';

  const warnings = [];
  if (qq) warnings.push('这是 QQ 邮箱：Twikoo 会直接使用 QQ 头像接口，不会请求本图床。');
  if (!prefixOk) warnings.push('目录不是 <code>avatar</code>，Twikoo 将取不到图片。');
  if (state.settings.algorithm === 'md5') warnings.push('当前用 MD5，与 Twikoo 自定义 CDN（SHA-256）不匹配。');
  if (state.settings.keepExtension) warnings.push('已开启「保留扩展名」，Twikoo 会 404。');
  if (!url) warnings.push('还没有配置仓库，URL 无法生成。');

  box.className = 'preview-box';
  box.innerHTML = `
    <div><span class="label">规范化邮箱：</span><span class="val">${escapeHtml(info.normalized)}</span></div>
    <div><span class="label">${state.settings.algorithm === 'md5' ? 'MD5' : 'SHA-256'}：</span><span class="val">${escapeHtml(info.hash)}</span></div>
    <div><span class="label">仓库路径：</span><span class="val">${escapeHtml(path)}</span></div>
    <div><span class="label">图片直链：</span><span class="val">${url ? escapeHtml(url) : '—'}</span></div>
    <div><span class="label">Twikoo 请求：</span><span class="val">${escapeHtml(buildTwikooRequestUrl(state.settings, email, { d: state.settings.defaultGravatar })) || '—'}</span></div>
    <div style="margin-top:6px">${existing ? '<span class="warn">该邮箱已有头像（上传将按「覆盖同名文件」设置处理）</span>' : '<span class="ok">这是一个新头像</span>'}</div>
    ${warnings.length ? `<div class="warn" style="margin-top:6px">⚠️ ${warnings.join('<br>⚠️ ')}</div>` : ''}`;
}

/** 把一个 File 变成队列项。 */
function makeQueueItem(file, email) {
  const hash = emailToFileName(email, state.settings.algorithm);
  const ext = extensionOf(file.name);
  const repoPath = buildRepoPath(hash, {
    prefix: state.settings.prefix,
    keepExtension: state.settings.keepExtension,
    extension: ext
  });
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    email: normalizeMail(email),
    hash,
    repoPath,
    url: buildFileUrl(state.settings, repoPath),
    previewUrl: URL.createObjectURL(file),
    size: file.size,
    status: 'pending',
    message: ''
  };
}

function addFiles(fileList) {
  const batch = $('#batchByFilename').checked;
  const fallbackEmail = $('#emailInput').value.trim();
  const added = [];
  const skipped = [];

  for (const file of Array.from(fileList)) {
    if (!isImageFile(file)) {
      skipped.push(`${file.name}（不是图片）`);
      continue;
    }
    const email = batch ? emailFromFileName(file.name) : fallbackEmail;
    if (!email) {
      skipped.push(`${file.name}（缺少邮箱）`);
      continue;
    }
    if (batch && !looksLikeEmail(email)) {
      skipped.push(`${file.name}（文件名不是邮箱：${email}）`);
      continue;
    }
    const item = makeQueueItem(file, email);
    const dupIndex = state.queue.findIndex((q) => q.repoPath === item.repoPath);
    if (dupIndex >= 0) {
      URL.revokeObjectURL(state.queue[dupIndex].previewUrl);
      state.queue[dupIndex] = item;
    } else {
      state.queue.push(item);
    }
    added.push(item);
  }

  renderQueue();
  if (added.length) toast(`已加入 ${added.length} 张图片`, 'ok');
  if (skipped.length) toast(`跳过 ${skipped.length} 个：${skipped.slice(0, 3).join('；')}`, 'warn', 6000);
}

function renderQueue() {
  const box = $('#queue');
  const count = $('#queueCount');
  count.textContent = String(state.queue.length);
  $('#uploadBtn').disabled = state.queue.length === 0 || state.busy;
  $('#clearQueue').disabled = state.queue.length === 0 || state.busy;

  if (!state.queue.length) {
    box.innerHTML = '<p class="muted">队列为空。</p>';
    return;
  }

  const statusText = {
    pending: '待上传',
    uploading: '上传中…',
    done: '✅ 完成',
    skip: '⏭ 已跳过',
    error: '⛔ 失败'
  };

  box.innerHTML = state.queue
    .map(
      (item) => `
    <div class="queue-item">
      <img src="${item.previewUrl}" alt="">
      <div class="meta">
        <div class="title">${escapeHtml(item.email)}</div>
        <div class="path" title="${escapeHtml(item.repoPath)}">${escapeHtml(item.repoPath)}</div>
        <div class="path">${humanSize(item.size)}${item.message ? ` · ${escapeHtml(item.message)}` : ''}</div>
      </div>
      <div class="status status-${item.status}">${statusText[item.status] || item.status}</div>
    </div>`
    )
    .join('');
}

async function startUpload() {
  if (!settingsReady()) {
    toast('先在设置页配置令牌与仓库', 'warn');
    activateTab('settings');
    return;
  }
  const pending = state.queue.filter((item) => item.status === 'pending' || item.status === 'error');
  if (!pending.length) {
    toast('没有待上传的图片', 'warn');
    return;
  }

  rebuildClient();
  state.busy = true;
  renderQueue();
  const btn = $('#uploadBtn');
  setBusy(btn, true, '上传中…');
  pushLog(`=== 开始上传 ${pending.length} 张 ===`);

  const overwrite = $('#overwriteChk').checked;
  const compressWanted = $('#compressChk').checked;
  // 「保留扩展名」时压缩会让扩展名与真实内容不符（比如转成 WebP 却还叫 .png），
  // 这种情况下宁可保留原图，也不要写出一个名不副实的文件。
  const compress = compressWanted && !state.settings.keepExtension;
  if (compressWanted && state.settings.keepExtension) {
    toast('已同时开启「保留扩展名」与压缩，为避免扩展名与内容不符，本次跳过压缩', 'warn', 6000);
  }
  const concurrency = Math.min(10, Math.max(1, Number(state.settings.concurrency) || 3));
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  const newHistory = [];
  const updatedPaths = [];

  const results = await mapLimit(pending, concurrency, async (item) => {
    item.status = 'uploading';
    renderQueue();
    try {
      let base64;
      let note = '';

      if (compress) {
        const result = await compressImage(item.file, {
          maxEdge: state.settings.maxEdge,
          format: 'webp',
          quality: 0.9
        });
        base64 = await blobToBase64(result.blob);
        note = result.passthrough
          ? '原样上传'
          : `已压缩为 ${result.width}×${result.height} ${result.type.replace('image/', '')}`;
      } else {
        base64 = await fileToBase64(item.file);
      }

      const existing = existingFileByPath(item.repoPath);
      const response = await state.client.putFile(item.repoPath, base64, {
        message: commitMessage(existing ? 'update' : 'add', { hash: item.hash, path: item.repoPath, email: item.email }),
        sha: existing && overwrite ? existing.sha : undefined,
        overwrite
      });

      if (response.skipped) {
        item.status = 'skip';
        item.message = '已存在，未覆盖';
        skipCount++;
        pushLog(`[跳过] ${item.repoPath} 已存在`);
      } else {
        item.status = 'done';
        item.message = note || (response.updated ? '已更新' : '已新增');
        okCount++;
        if (response.updated) updatedPaths.push(item.repoPath);
        pushLog(`[成功] ${item.email} → ${item.repoPath}\n        ${item.url}`);
        newHistory.push({
          email: item.email,
          hash: item.hash,
          path: item.repoPath,
          url: item.url,
          size: item.file.size
        });
        if (!existing) {
          state.files.push({ path: item.repoPath, name: fileNameOf(item.repoPath), sha: response.sha, size: item.file.size, email: item.email, note: '' });
        } else {
          existing.sha = response.sha || existing.sha;
          existing.email = item.email;
        }
      }
    } catch (error) {
      item.status = 'error';
      item.message = error instanceof GitHubError ? error.message : String(error.message || error);
      failCount++;
      pushLog(`[失败] ${item.repoPath}：${item.message}`);
    }
    renderQueue();
    return item;
  });

  state.busy = false;
  setBusy(btn, false);
  renderRateChip();

  if (newHistory.length) {
    try {
      saveNotesDoc(upsertEntries(loadNotesDoc(), newHistory, Date.now(), state.settings.historyLimit));
      renderNotesStatus();
      // 备注有变化：异步同步到仓库（第一次会先征求用户对「公开 / 私有」的意见）
      syncNotesSoon('上传后同步备注');
    } catch (error) {
      toast(error.message, 'warn', 6000);
    }
  }

  const failed = results.filter((r) => r.ok && r.value.status === 'error').length;
  pushLog(`=== 结束：成功 ${okCount} · 跳过 ${skipCount} · 失败 ${failCount} ===`);

  // 覆盖过的文件要清 CDN 缓存，否则评论里还是旧头像
  if (updatedPaths.length) autoPurge(updatedPaths);

  if (failCount === 0 && skipCount === 0) toast(`全部成功：${okCount} 张`, 'ok');
  else if (failCount === 0) toast(`成功 ${okCount} 张，跳过 ${skipCount} 张`, 'warn', 5000);
  else toast(`成功 ${okCount} · 跳过 ${skipCount} · 失败 ${failCount}`, 'err', 8000);

  // 上传完成的条目移出队列，失败/跳过的留在队列里便于重试（它们的预览 URL 不能回收）
  state.queue.filter((item) => item.status !== 'error').forEach((item) => URL.revokeObjectURL(item.previewUrl));
  state.queue = state.queue.filter((item) => item.status === 'error');
  renderQueue();

  applyFilters({ keepPage: true });
  renderGallery();
  if (settingsReady() && failed === 0) loadGallery({ silent: true });
}

/* ==================================================================== *
 * 图库
 * ==================================================================== */

async function loadGallery({ silent = false } = {}) {
  if (!settingsReady()) {
    if (!silent) toast('先在设置页配置令牌与仓库', 'warn');
    return;
  }
  rebuildClient();
  const box = $('#gallery');
  if (!silent) box.innerHTML = '<div class="empty">正在读取仓库文件…</div>';
  try {
    // 先把远程备注拉下来合并，否则图库会显示不出邮箱（备注在另一台设备上加过）
    if (notesSync.enabled) await notesSync.pull();
    // 备注文件永远不能出现在图库里（万一被配置到了 avatar/ 目录下）
    const { files, truncated, total } = await state.client.listTree(state.settings.prefix, {
      exclude: [resolveNotesTarget(state.settings).path]
    });
    const index = notesIndex(entriesOf(loadNotesDoc()));
    state.files = annotateFiles(files, index);
    renderRateChip();
    renderNotesStatus();
    applyFilters({ keepPage: false });
    renderGallery();
    const bytes = state.files.reduce((sum, f) => sum + (f.size || 0), 0);
    $('#galleryStats').textContent = `${state.files.length} 个头像 · ${humanSize(bytes)} · 仓库共 ${total} 个文件`;
    if (truncated) toast('仓库文件过多，GitHub 返回的列表被截断，部分文件未显示', 'warn', 7000);
    if (!silent) toast(`已加载 ${state.files.length} 个头像`, 'ok');
  } catch (error) {
    state.files = [];
    state.view = [];
    box.innerHTML = `<div class="empty err">读取失败：${escapeHtml(error.message)}</div>`;
    if (!silent) toast(error.message, 'err', 7000);
  }
}

function applyFilters({ keepPage = false } = {}) {
  const keyword = state.search.trim().toLowerCase();
  let list = state.files;

  if (keyword) {
    list = list.filter((file) => {
      const haystack = `${file.name} ${file.path} ${file.email || ''} ${file.note || ''}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }

  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    'name-desc': (a, b) => b.name.localeCompare(a.name),
    'size-desc': (a, b) => (b.size || 0) - (a.size || 0),
    'size-asc': (a, b) => (a.size || 0) - (b.size || 0)
  };
  state.view = [...list].sort(sorters[state.sort] || sorters.name);
  if (!keepPage) state.page = 1;

  // 只清理「已经不在仓库里」的选择（比如刚被删掉的）。
  // 注意不能用过滤后的 state.view：否则用户一搜索就会静默丢失已勾选项。
  const known = new Set(state.files.map((f) => f.path));
  for (const path of [...state.selection]) if (!known.has(path)) state.selection.delete(path);
}

function renderGallery() {
  const box = $('#gallery');
  const cfg = cdnConfig();

  if (!settingsReady()) {
    box.innerHTML = '<div class="empty">还没有配置仓库。请到「设置」页填写令牌与仓库信息。</div>';
    $('#galleryActions').hidden = true;
    $('#pager').innerHTML = '';
    $('#galleryStats').textContent = '';
    return;
  }

  if (!state.view.length) {
    box.innerHTML = state.files.length
      ? '<div class="empty">没有匹配的头像，换个关键词试试。</div>'
      : `<div class="empty">仓库的 <code>${escapeHtml(normalizePrefix(state.settings.prefix) || '(根目录)')}</code> 目录下还没有图片。<br>回到「上传」页添加第一个头像，或点右上角「刷新列表」。</div>`;
    $('#galleryActions').hidden = true;
    $('#pager').innerHTML = '';
    return;
  }

  const slice = pageSlice(state.view, state.page, state.pageSize);
  state.page = slice.page;

  box.innerHTML = slice.items
    .map((file) => {
      const url = buildFileUrl(cfg, file.path);
      const selected = state.selection.has(file.path);
      const label = file.email || '';
      return `
      <div class="tile ${selected ? 'selected' : ''}" data-path="${escapeHtml(file.path)}">
        <input class="pick" type="checkbox" data-pick="${escapeHtml(file.path)}" ${selected ? 'checked' : ''} aria-label="选择">
        <span class="badge">${humanSize(file.size)}</span>
        <img class="thumb" src="${escapeHtml(url)}" alt="" loading="lazy"
             data-zoom="${escapeHtml(url)}" data-caption="${escapeHtml(file.path)}">
        <div class="tile-body">
          <div class="tile-name" title="${escapeHtml(file.path)}">${escapeHtml(truncateMiddle(file.name, 12, 6))}</div>
          <div class="tile-email" title="${escapeHtml(label)}">${label ? escapeHtml(label) : '<span class="muted">无备注邮箱</span>'}</div>
          <div class="tile-sub"><span>${escapeHtml(file.sha.slice(0, 7))}</span></div>
          <div class="tile-actions">
            <button type="button" data-act="copy" title="复制直链">链接</button>
            <button type="button" data-act="md" title="复制 Markdown">MD</button>
            <button type="button" data-act="preview" title="预览">预览</button>
            <button type="button" data-act="note" title="给这个头像补一个邮箱备注（只存本地）">备注</button>
            <button type="button" data-act="rename" title="改绑邮箱（会移动仓库里的文件）">改邮箱</button>
            <button type="button" data-act="download" title="下载原图">下载</button>
            <button type="button" data-act="purge" title="刷新 jsDelivr 缓存">刷缓存</button>
            <button type="button" data-act="open" title="在 GitHub 打开">GH</button>
            <button type="button" class="danger" data-act="delete" title="删除">删除</button>
          </div>
        </div>
      </div>`;
    })
    .join('');

  $('#galleryActions').hidden = false;
  renderPager(slice);
  renderSelectionInfo();
}

function renderPager(slice) {
  const pager = $('#pager');
  if (!slice || slice.totalPages <= 1) {
    pager.innerHTML = '';
    return;
  }
  const buttons = pageNumbers(slice.page, slice.totalPages)
    .map((p) =>
      p === '…'
        ? '<span class="muted">…</span>'
        : `<button type="button" class="${p === slice.page ? 'current' : ''}" data-page="${p}">${p}</button>`
    )
    .join('');
  pager.innerHTML = `
    <button type="button" data-page="${slice.page - 1}" ${slice.page === 1 ? 'disabled' : ''}>上一页</button>
    ${buttons}
    <button type="button" data-page="${slice.page + 1}" ${slice.page === slice.totalPages ? 'disabled' : ''}>下一页</button>
    <span class="muted small">共 ${state.view.length} 项</span>`;
}

function renderSelectionInfo() {
  $('#selCount').textContent = `已选 ${state.selection.size} 项`;
  const has = state.selection.size > 0;
  ['#copySelectedLinks', '#copySelectedMd', '#exportSelected', '#deleteSelected', '#purgeSelected'].forEach((sel) => {
    $(sel).disabled = !has;
  });
}

function selectedFiles() {
  return state.files.filter((f) => state.selection.has(f.path));
}

function bindGallery() {
  $('#refreshGallery').addEventListener('click', (event) => {
    const btn = event.currentTarget;
    setBusy(btn, true, '读取中…');
    loadGallery().finally(() => setBusy(btn, false));
  });

  $('#gallerySearch').addEventListener(
    'input',
    debounce((event) => {
      state.search = event.target.value;
      applyFilters();
      renderGallery();
    }, 160)
  );

  $('#gallerySort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    applyFilters();
    renderGallery();
  });

  $('#galleryPageSize').addEventListener('change', (event) => {
    state.pageSize = Number(event.target.value) || 60;
    state.page = 1;
    renderGallery();
  });

  $('#pager').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-page]');
    if (!btn || btn.disabled) return;
    state.page = Number(btn.dataset.page) || 1;
    renderGallery();
    document.querySelector('#tab-gallery .card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#selectPage').addEventListener('click', () => {
    const slice = pageSlice(state.view, state.page, state.pageSize);
    slice.items.forEach((f) => state.selection.add(f.path));
    renderGallery();
  });

  $('#clearSelection').addEventListener('click', () => {
    state.selection.clear();
    renderGallery();
  });

  $('#copySelectedLinks').addEventListener('click', () => {
    const entries = selectedFiles().map((f) => ({ ...f, url: buildFileUrl(cdnConfig(), f.path) }));
    copyWithToast(toPlainLinks(entries), `已复制 ${entries.length} 条链接`);
  });

  $('#copySelectedMd').addEventListener('click', () => {
    const entries = selectedFiles().map((f) => ({ ...f, url: buildFileUrl(cdnConfig(), f.path) }));
    copyWithToast(toMarkdown(entries), `已复制 ${entries.length} 条 Markdown`);
  });

  $('#exportSelected').addEventListener('click', () => {
    const cfg = cdnConfig();
    const rows = selectedFiles().map((f) => ({
      email: f.email || '',
      hash: f.name,
      path: f.path,
      size: f.size,
      url: buildFileUrl(cfg, f.path),
      twikooUrl: f.email ? buildTwikooRequestUrl(cfg, f.email, { d: state.settings.defaultGravatar }) : ''
    }));
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: rows }, null, 2)], {
      type: 'application/json'
    });
    triggerDownload(blob, `youtiao-links-${new Date().toISOString().slice(0, 10)}.json`);
  });

  $('#deleteSelected').addEventListener('click', deleteSelected);

  $('#purgeSelected').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const paths = selectedFiles().map((f) => f.path);
    if (!paths.length) return;
    setBusy(btn, true, '刷新中…');
    try {
      await purgePaths(paths);
    } catch (error) {
      toast(`刷新缓存失败：${error.message}`, 'err', 6000);
    } finally {
      setBusy(btn, false);
    }
  });

  // 事件委托：勾选、缩放、各种操作
  $('#gallery').addEventListener('change', (event) => {
    const pick = event.target.closest('[data-pick]');
    if (!pick) return;
    const path = pick.dataset.pick;
    if (pick.checked) state.selection.add(path);
    else state.selection.delete(path);
    const tile = pick.closest('.tile');
    if (tile) tile.classList.toggle('selected', pick.checked);
    renderSelectionInfo();
  });

  $('#gallery').addEventListener('click', async (event) => {
    const thumb = event.target.closest('.thumb');
    const action = event.target.closest('[data-act]');
    if (action) {
      event.preventDefault();
      const tile = action.closest('.tile');
      const file = state.files.find((f) => f.path === tile.dataset.path);
      if (file) await handleTileAction(action.dataset.act, file);
      return;
    }
    if (thumb) {
      openLightbox(thumb.dataset.zoom, thumb.dataset.caption || '');
    }
  });
}

async function handleTileAction(action, file) {
  const cfg = cdnConfig();
  const url = buildFileUrl(cfg, file.path);

  switch (action) {
    case 'copy':
      await copyWithToast(url, '直链已复制');
      break;

    case 'md':
      await copyWithToast(`![${file.email || file.name}](${url})`, 'Markdown 已复制');
      break;

    case 'preview':
      openLightbox(url, file.path);
      break;

    case 'purge':
      await purgePaths([file.path]);
      break;

    case 'open':
      window.open(
        `https://github.com/${state.settings.owner}/${state.settings.repo}/blob/${state.settings.branch}/${file.path}`,
        '_blank',
        'noopener'
      );
      break;

    case 'download':
      try {
        const base64 = await state.client.getBlobBase64(file.sha);
        const { blob, ext } = blobFromBase64(base64);
        triggerDownload(blob, `${file.name}.${ext}`);
        toast('已开始下载原图', 'ok');
      } catch (error) {
        toast(`下载失败：${error.message}`, 'err', 6000);
      }
      break;

    case 'rename':
      await renameAvatar(file);
      break;

    case 'note':
      await annotateAvatar(file);
      break;

    case 'delete':
      await deleteFiles([file]);
      break;

    default:
      break;
  }
}

/** 写入备注（本地缓存 + 安排远程同步）。 */
function writeNotes(entries, { tombstone = [] } = {}) {
  let doc = loadNotesDoc();
  if (tombstone.length) doc = tombstoneEntries(doc, tombstone);
  if (entries.length) doc = upsertEntries(doc, entries, Date.now(), state.settings.historyLimit);
  saveNotesDoc(doc, state.settings.historyLimit);
  renderNotesStatus();
  syncNotesSoon();
  return doc;
}

/** 只记录「邮箱 ↔ 哈希」备注，完全不动仓库里的图片。 */
function recordNote(file, email) {
  const normalized = normalizeMail(email);
  writeNotes([
    { email: normalized, hash: file.name, path: file.path, url: buildFileUrl(cdnConfig(), file.path), size: file.size }
  ]);
  file.email = normalized;
  renderGallery();
}

/** 把文件移动到某个邮箱对应的正确路径（新增 + 删除两次提交）。 */
async function moveToEmail(file, email, hash) {
  const target = buildRepoPath(hash, {
    prefix: state.settings.prefix,
    keepExtension: state.settings.keepExtension,
    extension: extensionOf(file.path)
  });
  await state.client.moveFile(file.path, target, file.sha, {
    overwrite: true,
    message: commitMessage('rename', { hash, path: `${file.path} -> ${target}`, email })
  });
  writeNotes([{ email: normalizeMail(email), hash, path: target, url: buildFileUrl(cdnConfig(), target) }], {
    tombstone: [file.name]
  });
  autoPurge([file.path, target]);
  await loadGallery({ silent: true });
}

/**
 * 改绑邮箱：算出新哈希 → 在仓库里移动文件。
 * 如果新邮箱的哈希与当前文件名本来就一致（只是本地缺备注），就只记录备注、不动机器。
 */
async function renameAvatar(file) {
  const current = file.email || '';
  const next = await promptDialog({
    title: '改绑邮箱',
    label: '新的邮箱',
    value: current,
    placeholder: 'newuser@example.com',
    help: '会用新邮箱的哈希作为新文件名，并在仓库里把文件移动过去（一次新增 + 一次删除提交）。若哈希本来就一致，则只记录备注。',
    confirmText: '移动'
  });
  if (next === null) return;
  const email = next.trim();
  if (!email) {
    toast('邮箱不能为空', 'warn');
    return;
  }
  if (normalizeMail(email) === normalizeMail(current)) {
    toast('邮箱没有变化', 'warn');
    return;
  }

  const hash = emailToFileName(email, state.settings.algorithm);
  if (hash === file.name) {
    recordNote(file, email);
    toast('哈希本来就一致，已直接记录备注（无需移动文件）', 'ok');
    return;
  }

  try {
    await moveToEmail(file, email, hash);
    toast('已改绑邮箱并移动文件', 'ok');
  } catch (error) {
    toast(`移动失败：${error.message}`, 'err', 7000);
  }
}

/**
 * 备注邮箱：把仓库里已有的头像和某个邮箱关联起来。
 * 场景：头像早就传上去了，或者别人帮你传的，本地没有备注 → 图库里只显示一串哈希。
 * 哈希一致就只写本地；不一致则问你要不要顺手把文件搬到正确路径。
 */
async function annotateAvatar(file) {
  const next = await promptDialog({
    title: '备注邮箱',
    label: '这个头像属于哪个邮箱？',
    value: file.email || '',
    placeholder: 'user@example.com',
    help: '只记录在浏览器本地，用于显示与搜索，不会改动仓库里的文件。',
    confirmText: '保存备注'
  });
  if (next === null) return;
  const email = next.trim();
  if (!email) {
    toast('邮箱不能为空', 'warn');
    return;
  }
  if (normalizeMail(email) === normalizeMail(file.email || '')) {
    toast('备注没有变化', 'warn');
    return;
  }

  const hash = emailToFileName(email, state.settings.algorithm);
  if (hash === file.name) {
    recordNote(file, email);
    toast('已保存备注', 'ok');
    return;
  }

  const move = await confirmDialog({
    title: '哈希不匹配',
    html: `<p>这个头像的文件名是：<br><code>${escapeHtml(file.name)}</code></p>
           <p><code>${escapeHtml(email)}</code> 的哈希却是：<br><code>${escapeHtml(hash)}</code></p>
           <p>两者不一致，说明它并不是由这个邮箱算出来的 —— <strong>Twikoo 用这个邮箱取不到它</strong>。
              要把文件移动到正确的路径吗？（会新增一个文件并删除原来的）</p>`,
    confirmText: '移动文件',
    cancelText: '只存备注'
  });

  if (!move) {
    recordNote(file, email);
    toast('已只存备注（未改动仓库）', 'warn', 5000);
    return;
  }
  try {
    await moveToEmail(file, email, hash);
    toast('已移动到正确的路径', 'ok');
  } catch (error) {
    toast(`移动失败：${error.message}`, 'err', 7000);
  }
}

async function deleteSelected() {
  const files = selectedFiles();
  if (!files.length) return;
  await deleteFiles(files);
}

async function deleteFiles(files) {
  const list = files.filter(Boolean);
  if (!list.length) return;

  const preview = list
    .slice(0, 6)
    .map((f) => `<li><code>${escapeHtml(f.path)}</code>${f.email ? ` · ${escapeHtml(f.email)}` : ''}</li>`)
    .join('');
  const ok = await confirmDialog({
    title: `删除 ${list.length} 个头像`,
    html: `<p>将从仓库中删除以下文件（每个文件一次提交，可以随时在 GitHub 上回滚）：</p>
           <ul>${preview}</ul>
           ${list.length > 6 ? `<p class="muted small">…以及另外 ${list.length - 6} 个</p>` : ''}`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  const btn = $('#deleteSelected');
  setBusy(btn, true, '删除中…');
  let okCount = 0;
  const failed = [];

  const results = await mapLimit(list, Math.min(4, list.length), async (file) => {
    try {
      await state.client.deleteFile(file.path, file.sha, {
        message: commitMessage('delete', { hash: file.name, path: file.path, email: file.email })
      });
      okCount++;
      return file;
    } catch (error) {
      failed.push(`${file.path}：${error.message}`);
      return null;
    }
  });

  const deleted = results.filter((r) => r.ok && r.value).map((r) => r.value);
  const deletedPaths = new Set(deleted.map((f) => f.path));
  state.files = state.files.filter((f) => !deletedPaths.has(f.path));
  deleted.forEach((f) => state.selection.delete(f.path));
  if (deleted.length) writeNotes([], { tombstone: deleted.map((f) => f.name) });

  setBusy(btn, false);
  renderRateChip();
  applyFilters({ keepPage: true });
  renderGallery();
  if (deleted.length) autoPurge(deleted.map((f) => f.path));

  if (!failed.length) toast(`已删除 ${okCount} 个头像`, 'ok');
  else toast(`删除完成：成功 ${okCount} · 失败 ${failed.length}（${failed[0]}）`, 'err', 8000);
}

/* ==================================================================== *
 * CDN 与 Twikoo
 * ==================================================================== */

function bindCdn() {
  $('#cdnPreset').addEventListener('change', (event) => {
    $('#settingsPreset').value = event.target.value;
    persist({ preset: event.target.value });
  });

  $('#customTemplate').addEventListener(
    'input',
    debounce(() => persist({ customTemplate: $('#customTemplate').value.trim() }), 300)
  );

  $('#genLinks').addEventListener('click', generateLinks);

  $('#bulkEmails').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') generateLinks();
  });

  $('#copyAllLinks').addEventListener('click', () => {
    if (!state.links.length) return;
    copyWithToast(toPlainLinks(state.links), `已复制 ${state.links.length} 条链接`);
  });

  $('#downloadTxt').addEventListener('click', () => downloadLinks('txt'));
  $('#downloadCsv').addEventListener('click', () => downloadLinks('csv'));
  $('#downloadJson').addEventListener('click', () => downloadLinks('json'));
}

function renderCdnPanel() {
  const cfg = cdnConfig();
  const preset = getPreset(state.settings.preset);

  $('#customTemplateField').hidden = preset.id !== 'custom';
  $('#cdnPreset').value = preset.id;
  $('#settingsPreset').value = preset.id;
  $('#presetNote').textContent = preset.note || '';

  // 缓存刷新能力：jsdmirror 这类第三方镜像 purge 管不到，必须在这里就说清楚，
  // 否则用户会以为「刷过缓存了」，然后在评论区看到旧头像干着急。
  const support = purgeSupport(cfg);
  const purgeNote = $('#cdnPurgeNote');
  purgeNote.hidden = support.supported;
  purgeNote.textContent = support.supported ? '' : `⚠️ ${support.reason} ${support.workaround.split('\n').join(' ')}`;

  const base = buildCdnBase(cfg);
  const value = toTwikooValue(base);
  $('#cdnBase').textContent = base || '—（请先在设置页填写仓库所有者与仓库名）';
  $('#twikooValue').textContent = value || '—';

  const prefixOk = normalizePrefix(state.settings.prefix) === 'avatar';
  const d = state.settings.defaultGravatar || 'mp';
  const sampleHash = '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b';

  $('#twikooSnippet').innerHTML = `
Twikoo 后台 → 设置 → 评论 → 头像 CDN（GRAVATAR_CDN）

  GRAVATAR_CDN = ${escapeHtml(value || '（尚未配置仓库）')}
  DEFAULT_GRAVATAR = ${escapeHtml(d)}

Twikoo 最终请求的地址形如：

  https://${escapeHtml(value || '<你的CDN基址>')}/avatar/<邮箱的SHA-256>?d=${escapeHtml(d)}

以上面测试邮箱 test@example.com 为例：

  https://${escapeHtml(value || '<你的CDN基址>')}/avatar/${sampleHash}?d=${escapeHtml(d)}
${prefixOk ? '' : '\n⚠️ 当前目录前缀不是 avatar，Twikoo 会 404。请到设置页把「仓库内目录」改回 avatar。'}`;
}

function generateLinks() {
  const raw = $('#bulkEmails').value;
  if (!raw.trim()) {
    toast('先输入至少一个邮箱', 'warn');
    return;
  }
  const cfg = cdnConfig();
  const exists = new Set(state.files.map((f) => f.name));
  state.links = uniqueBy(
    describeEmails(cfg, raw, { d: state.settings.defaultGravatar }).map((info) => ({
      ...info,
      uploaded: exists.has(info.hash)
    })),
    (x) => x.hash
  );

  const box = $('#linkResult');
  if (!state.links.length) {
    box.innerHTML = '<p class="muted">没有解析到有效邮箱。</p>';
    return;
  }

  box.innerHTML = state.links
    .map(
      (info) => `
    <div class="link-row ${info.uploaded ? '' : 'missing'}">
      <img src="${escapeHtml(info.url)}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'">
      <div>
        <div class="l-email">${escapeHtml(info.email)}${isQQMail(info.email) ? ' <span class="l-tag">QQ 邮箱：Twikoo 不请求图床</span>' : ''}</div>
        <div class="l-url" title="${escapeHtml(info.url)}">${escapeHtml(info.url)}</div>
      </div>
      <div class="row" style="margin:0;gap:6px">
        <span class="l-tag">${info.uploaded ? '<span class="ok">已上传</span>' : '未上传'}</span>
        <button type="button" class="mini" data-copy-inline="${escapeHtml(info.url)}">复制</button>
      </div>
    </div>`
    )
    .join('');

  box.querySelectorAll('[data-copy-inline]').forEach((btn) =>
    btn.addEventListener('click', () => copyWithToast(btn.dataset.copyInline))
  );

  ['#copyAllLinks', '#downloadTxt', '#downloadCsv', '#downloadJson'].forEach((sel) => ($(sel).disabled = false));

  const missing = state.links.filter((l) => !l.uploaded).length;
  $('#genLinks').textContent = `生成（${state.links.length}）`;
  toast(`已生成 ${state.links.length} 条链接${missing ? `，其中 ${missing} 个邮箱还没有头像` : '，全部都已上传'}`, missing ? 'warn' : 'ok', 5000);
}

function downloadLinks(format) {
  if (!state.links.length) return;
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'txt') {
    triggerDownload(toPlainLinks(state.links), `youtiao-links-${stamp}.txt`, 'text/plain;charset=utf-8');
  } else if (format === 'csv') {
    const rows = state.links.map((l) => [l.email, l.hash, l.url, l.twikooUrl, l.uploaded ? 'yes' : 'no']);
    triggerDownload(toCsv(rows, ['email', 'hash', 'url', 'twikoo_url', 'uploaded']), `youtiao-links-${stamp}.csv`, 'text/csv;charset=utf-8');
  } else {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      cdnBase: buildCdnBase(cdnConfig()),
      twikooValue: toTwikooValue(buildCdnBase(cdnConfig())),
      items: state.links.map((l) => ({
        email: l.email,
        hash: l.hash,
        path: l.repoPath,
        url: l.url,
        twikooUrl: l.twikooUrl,
        uploaded: l.uploaded
      }))
    };
    triggerDownload(JSON.stringify(payload, null, 2), `youtiao-links-${stamp}.json`, 'application/json');
  }
}

/* ==================================================================== *
 * 启动
 * ==================================================================== */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// 给 index.html 里的兜底提示用：标记脚本确实跑起来了。
// （以 file:// 双击打开时 ES 模块会被浏览器拦截，这段代码根本不会执行，
//   页面上的提示就会告诉用户改用 npm start 或单文件版。）
document.documentElement.dataset.youtiaoBooted = '1';

// 便于在浏览器控制台排查
window.youtiao = { state, cdnConfig, buildCdnBase, buildTwikooRequestUrl };
