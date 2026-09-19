/**
 * HTML 净化器
 *
 * 订阅源正文是最不可信的输入之一：它来自任意第三方站点，且会被直接插入到我们的页面里。
 * 这里用「白名单」而不是「黑名单」：只保留明确安全的标签与属性，其余一律处理掉。
 *
 * 关键点：
 *  - 用 DOMParser 解析，它不会执行脚本、不会加载外部资源（天然沙箱）
 *  - 非白名单标签「解包」保留文字，而不是整段删除，避免丢掉正文
 *  - 真正危险的容器（script/style/iframe/svg/form…）整块移除，包括其后代
 *  - 所有 on* 事件属性、style 内联样式一律不保留
 *  - 链接强制 rel="noopener noreferrer" + target="_blank"
 *  - 图片加 lazy + no-referrer，顺带规避追踪像素
 */

const DROP_ENTIRELY = new Set([
  'script', 'style', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'form', 'input', 'textarea', 'select', 'option', 'button', 'fieldset',
  'legend', 'label', 'svg', 'math', 'template', 'link', 'meta', 'base', 'title',
  'head', 'canvas', 'audio', 'video', 'source', 'track', 'dialog', 'slot', 'portal'
]);

const ALLOWED = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br',
  'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol',
  'p', 'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small',
  'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr'
]);

const ALLOWED_ATTRS = new Set([
  'href', 'title', 'alt', 'src', 'srcset', 'sizes', 'width', 'height', 'colspan',
  'rowspan', 'scope', 'datetime', 'lang', 'dir', 'loading', 'decoding',
  'referrerpolicy', 'target', 'rel', 'id', 'class', 'align', 'start', 'reversed', 'value'
]);

const SAFE_URL = /^(https?:|mailto:|tel:|\/|#|\.\/|\.\.\/)/i;
const SAFE_DATA_IMG = /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);base64,[a-z0-9+/=\s]+$/i;

const MAX_INPUT = 600_000;
const MAX_NODES = 6000;

export function isSafeUrl(value, { allowData = false } = {}) {
  const url = String(value || '').trim().replace(/[\u0000-\u001f\u007f\s]/g, '');
  if (!url) return false;
  if (url.startsWith('data:')) return allowData && SAFE_DATA_IMG.test(String(value).trim());
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return SAFE_URL.test(url);
  return true; // 相对地址
}

/** 标签是否整体丢弃（含其全部后代）。 */
export function isDroppedTag(tagName) {
  return DROP_ENTIRELY.has(String(tagName || '').toLowerCase());
}

/** 标签是否在白名单内（不在白名单的标签会被「解包」，保留文字）。 */
export function isAllowedTag(tagName) {
  return ALLOWED.has(String(tagName || '').toLowerCase());
}

export function isAllowedAttr(name) {
  return ALLOWED_ATTRS.has(String(name || '').toLowerCase());
}

function cleanElement(el) {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    if (!ALLOWED_ATTRS.has(name)) { el.removeAttribute(attr.name); continue; }
    if (name === 'href' && !isSafeUrl(attr.value)) { el.removeAttribute('href'); continue; }
    if ((name === 'src' || name === 'srcset') && !isSafeUrl(attr.value, { allowData: true })) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'class' && !/^[\w\s-]{0,200}$/.test(attr.value)) el.removeAttribute('class');
  }

  if (el.tagName === 'A') {
    if (!el.getAttribute('href')) {
      // 没有可用链接的 a 标签退化为普通文字容器
      const span = el.ownerDocument.createElement('span');
      span.innerHTML = el.innerHTML;
      el.replaceWith(span);
      return span;
    }
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer nofollow');
  }

  if (el.tagName === 'IMG') {
    el.setAttribute('loading', 'lazy');
    el.setAttribute('decoding', 'async');
    el.setAttribute('referrerpolicy', 'no-referrer');
    if (!el.getAttribute('src') && !el.getAttribute('srcset')) { el.remove(); return null; }
  }

  return el;
}

function walk(node, state) {
  const children = [...node.childNodes];
  for (const child of children) {
    if (state.count > MAX_NODES) { child.remove(); continue; }
    if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    state.count += 1;
    const tag = child.tagName.toLowerCase();

    if (DROP_ENTIRELY.has(tag)) { child.remove(); continue; }

    if (!ALLOWED.has(tag)) {
      // 解包：保留正文，丢掉这层标签
      const parent = child.parentNode;
      const fragment = node.ownerDocument.createDocumentFragment();
      while (child.firstChild) fragment.appendChild(child.firstChild);
      parent.replaceChild(fragment, child);
      continue;
    }

    const cleaned = cleanElement(child);
    if(!cleaned) continue;
    walk(cleaned, state);
  }
}

/**
 * @param {string} html 原始 HTML
 * @returns {string} 可安全插入 DOM 的 HTML
 */
export function sanitizeHtml(html) {
  const input = String(html || '');
  if (!input) return '';
  const truncated = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;

  const doc = new DOMParser().parseFromString(`<body><div id="__lumen_root">${truncated}</div></body>`, 'text/html');
  const root = doc.getElementById('__lumen_root');
  if (!root) return '';
  walk(root, { count: 0 });
  return root.innerHTML;
}

/** 纯文本 → 段落 HTML（当正文缺失时兜底）。 */
export function textToParagraphs(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
