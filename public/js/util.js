/** 通用工具：转义、时间格式化、防抖、关键词高亮 */

export function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 昨天 14:20 / 8月12日 */
export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return formatDateTime(ts);
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;

  const date = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday - DAY && ts < startOfToday) {
    return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const pad = (n) => String(n).padStart(2, '0');

export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

/** 把命中关键词包成 <mark>，输入为纯文本，输出为安全 HTML。 */
export function highlight(text, query) {
  const raw = String(text ?? '');
  const terms = String(query || '').trim().split(/\s+/).filter((t) => t.length > 0).slice(0, 6);
  if (!terms.length) return escapeHtml(raw);

  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');

  let out = '';
  let last = 0;
  const source = raw;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(source))) {
    out += escapeHtml(source.slice(last, m.index));
    out += `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  out += escapeHtml(source.slice(last));
  return out;
}

export function clampText(text, max) {
  const value = String(text || '').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** 首字母/首字作为无图标时的占位。 */
export function initialOf(name) {
  const clean = String(name || '').trim();
  if (!clean) return 'R';
  return /^[\x00-\x7F]/.test(clean) ? clean[0].toUpperCase() : clean[0];
}

export function friendlyHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}

export function bytesToText(n) {
  if (!Number.isFinite(n)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
