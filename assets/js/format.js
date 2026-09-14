/**
 * format.js —— 纯格式化 / 分页 / 导出工具（无 DOM，可单元测试）。
 */

/** 人类可读的文件体积。 */
export function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

/** 时间戳 → 本地时间字符串。 */
export function fmtDateTime(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** HTML 转义 —— 仓库里的文件名可能带尖括号，注入 innerHTML 前必须过一遍。 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 中间截断，保留头尾，便于展示长哈希。 */
export function truncateMiddle(value, head = 10, tail = 6) {
  const s = String(value == null ? '' : value);
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** 分页切片。 */
export function pageSlice(list, page, pageSize) {
  const size = Math.max(1, Number(pageSize) || 24);
  const totalPages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (current - 1) * size;
  return { items: list.slice(start, start + size), page: current, totalPages, start, size };
}

/** 生成分页按钮要显示的页码（首尾 + 当前附近，其余用省略号）。 */
export function pageNumbers(current, totalPages) {
  const out = [];
  const push = (v) => {
    if (!out.includes(v)) out.push(v);
  };
  push(1);
  for (let p = current - 1; p <= current + 1; p++) if (p > 1 && p < totalPages) push(p);
  if (totalPages > 1) push(totalPages);
  const withGaps = [];
  let prev = 0;
  for (const p of out.sort((a, b) => a - b)) {
    if (prev && p - prev > 1) withGaps.push('…');
    withGaps.push(p);
    prev = p;
  }
  return withGaps;
}

/** 转 CSV（自动加 BOM，Excel 打开中文不乱码）。 */
export function toCsv(rows, headers) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  if (Array.isArray(headers) && headers.length) lines.push(headers.map(esc).join(','));
  for (const row of rows) {
    lines.push(
      (Array.isArray(row) ? row : (headers || Object.keys(row)).map((k) => row[k])).map(esc).join(',')
    );
  }
  return '\uFEFF' + lines.join('\r\n');
}

/** 链接列表 → Markdown 图片语法，可直接贴进博客。 */
export function toMarkdown(entries) {
  return entries
    .map((e) => {
      const alt = e.email || e.name || e.hash || 'avatar';
      return `![${alt}](${e.url})`;
    })
    .join('\n');
}

/** 链接列表 → 纯文本（每行一个 URL）。 */
export function toPlainLinks(entries) {
  return entries.map((e) => e.url).join('\n');
}

/** 按 key 去重，保留首次出现。 */
export function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 安全文件名（用于下载）。 */
export function safeFileName(name) {
  return String(name == null ? 'file' : name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}
