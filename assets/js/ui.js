/**
 * ui.js —— 通用 DOM 助手：toast、确认框、输入框弹窗、剪贴板、灯箱、主题。
 * 这里只放与业务无关的能力，业务逻辑在 app.js。
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* ------------------------------- toast ------------------------------- */

const TOAST_ICONS = { info: 'ℹ️', ok: '✅', err: '⛔', warn: '⚠️' };

/**
 * 右下角提示。
 * @param {string} message
 * @param {'info'|'ok'|'err'|'warn'} [type]
 * @param {number} [timeout] 毫秒，传 0 表示不自动关闭
 */
export function toast(message, type = 'info', timeout = 3800) {
  const container = $('#toasts');
  if (!container) return null;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = `${TOAST_ICONS[type] || ''} ${message}`.trim();
  container.appendChild(node);

  const remove = () => {
    node.style.opacity = '0';
    node.style.transform = 'translateX(16px)';
    node.style.transition = 'opacity .18s, transform .18s';
    setTimeout(() => node.remove(), 200);
  };
  node.addEventListener('click', remove);
  if (timeout > 0) setTimeout(remove, timeout);
  return node;
}

/* ------------------------------ 对话框 ------------------------------ */

/**
 * 确认框。
 * @param {{title?:string, html?:string, text?:string, confirmText?:string, cancelText?:string, danger?:boolean}} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options = {}) {
  const dialog = $('#modal');
  const body = $('#modalBody');
  const confirmBtn = $('#modalConfirm');
  const cancelBtn = $('#modalCancel');

  $('#modalTitle').textContent = options.title || '请确认';
  body.innerHTML = options.html || `<p>${escapeText(options.text || '确定继续吗？')}</p>`;
  confirmBtn.textContent = options.confirmText || '确定';
  confirmBtn.className = options.danger ? 'danger' : 'primary';
  confirmBtn.hidden = false;
  cancelBtn.textContent = options.cancelText || '取消';
  cancelBtn.hidden = false;

  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    dialog.showModal();
  });
}

/**
 * 单行输入弹窗。
 * @returns {Promise<string|null>} 取消时返回 null
 */
export function promptDialog(options = {}) {
  const dialog = $('#modal');
  const body = $('#modalBody');
  const confirmBtn = $('#modalConfirm');
  const cancelBtn = $('#modalCancel');

  $('#modalTitle').textContent = options.title || '请输入';
  body.innerHTML = `
    <label class="field">
      <span>${escapeText(options.label || '')}</span>
      <input id="modalInput" type="${options.type || 'text'}" value="${escapeAttr(options.value || '')}"
             placeholder="${escapeAttr(options.placeholder || '')}" autocomplete="off" spellcheck="false">
      ${options.help ? `<small class="muted">${escapeText(options.help)}</small>` : ''}
    </label>`;
  confirmBtn.textContent = options.confirmText || '确定';
  confirmBtn.className = 'primary';
  confirmBtn.hidden = false;
  cancelBtn.textContent = '取消';
  cancelBtn.hidden = false;

  const input = $('#modalInput', body);
  setTimeout(() => input && input.focus(), 30);

  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm' ? input.value : null);
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    dialog.showModal();
  });
}

/**
 * 单选对话框（比 confirmDialog 多几个选项时用）。
 * @param {{title?:string, html?:string, options:Array<{label:string, value:string, description?:string, primary?:boolean, danger?:boolean}>}} config
 * @returns {Promise<string|null>} 用户选中的 value；按 Esc / 关闭则返回 null
 */
export function choiceDialog(config = {}) {
  const dialog = $('#modal');
  const body = $('#modalBody');
  const confirmBtn = $('#modalConfirm');
  const cancelBtn = $('#modalCancel');

  $('#modalTitle').textContent = config.title || '请选择';
  const buttons = (config.options || [])
    .map(
      (option) => `
      <button type="button" class="choice ${option.primary ? 'primary' : ''} ${option.danger ? 'danger' : ''}"
              data-choice="${escapeAttr(option.value)}">
        <strong>${escapeText(option.label)}</strong>
        ${option.description ? `<small>${escapeText(option.description)}</small>` : ''}
      </button>`
    )
    .join('');
  body.innerHTML = `${config.html || ''}<div class="choice-list">${buttons}</div>`;

  // 这个对话框自己带按钮，隐藏通用的确认/取消
  confirmBtn.hidden = true;
  cancelBtn.hidden = true;

  return new Promise((resolve) => {
    const onClick = (event) => {
      const btn = event.target.closest('[data-choice]');
      if (!btn) return;
      dialog.returnValue = btn.dataset.choice;
      dialog.close();
    };
    const onClose = () => {
      body.removeEventListener('click', onClick);
      dialog.removeEventListener('close', onClose);
      confirmBtn.hidden = false;
      cancelBtn.hidden = false;
      resolve(dialog.returnValue || null);
    };
    body.addEventListener('click', onClick);
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    dialog.showModal();
  });
}

/**
 * 只读提示框（只有「知道了」一个按钮）。
 * 适合用来解释「为什么不能这么做、那应该怎么办」这类不需要用户抉择的信息。
 * @returns {Promise<void>}
 */
export function noticeDialog(options = {}) {
  const dialog = $('#modal');
  const body = $('#modalBody');
  const confirmBtn = $('#modalConfirm');
  const cancelBtn = $('#modalCancel');

  $('#modalTitle').textContent = options.title || '提示';
  body.innerHTML = options.html || `<p>${escapeText(options.text || '')}</p>`;
  confirmBtn.textContent = options.okText || '知道了';
  confirmBtn.className = 'primary';
  confirmBtn.hidden = false;
  cancelBtn.hidden = true;

  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve();
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    dialog.showModal();
  });
}

/* ------------------------------ 剪贴板 ------------------------------ */

/** 复制文本，失败时回退到 execCommand。 */
export async function copyText(text) {
  const value = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 复制并提示。 */
export async function copyWithToast(text, label = '已复制') {
  const ok = await copyText(text);
  toast(ok ? `${label}：${String(text).slice(0, 60)}${String(text).length > 60 ? '…' : ''}` : '复制失败，请手动选中复制', ok ? 'ok' : 'err');
  return ok;
}

/* ------------------------------- 灯箱 ------------------------------- */

export function openLightbox(src, caption = '') {
  const lightbox = $('#lightbox');
  const img = $('#lightboxImg');
  $('#lightboxCaption').textContent = caption;
  img.src = src;
  if (typeof lightbox.showModal === 'function') lightbox.showModal();
  else window.open(src, '_blank');
}

/* ------------------------------- 主题 ------------------------------- */

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

export function toggleTheme(theme) {
  return theme === 'dark' ? 'light' : 'dark';
}

/* ------------------------------ 小工具 ------------------------------ */

/** 输入框防抖。 */
export function debounce(fn, ms = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** 按钮进入/退出忙碌态。 */
export function setBusy(button, busy, busyText = '处理中…') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = false;
  }
}

export function escapeText(value) {
  return String(value == null ? '' : value);
}

export function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 切换标签页。 */
export function activateTab(name) {
  $$('#tabs .tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${name}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
