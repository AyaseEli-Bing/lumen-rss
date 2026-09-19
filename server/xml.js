/**
 * 轻量 XML 解析器（无外部依赖）
 *
 * 面向「真实世界的订阅源」做了容错，而不是严格 XML 合规：
 *  - CDATA 段落原样保留（HTML 内容常放在 CDATA 里）
 *  - 命名空间前缀忽略，只比 local name（rdf:RDF / content:encoded / dc:creator）
 *  - 常见 HTML 实体、数字实体（&#233; / &#xE9;）解码
 *  - 标签未闭合、属性未加引号、DOCTYPE 内部子集等异常输入不会抛错中断
 *  - parts 保留文本与子节点的先后顺序，便于还原 description 中的富文本
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  middot: '\u00b7', bull: '\u2022', deg: '\u00b0', trade: '\u2122',
  laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7', divide: '\u00f7',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  sect: '\u00a7', para: '\u00b6', dagger: '\u2020', permil: '\u2030',
  prime: '\u2032', ne: '\u2260', le: '\u2264', ge: '\u2265', minus: '\u2212',
  shy: '', zwj: '', zwnj: '', ensp: ' ', emsp: ' ', thinsp: ' ', tab: '\t'
};

export function decodeEntities(input) {
  if (!input || input.indexOf('&') === -1) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      // 过滤不可见控制字符，避免污染存储与渲染
      if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return '';
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const key = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
    return match;
  });
}

export function escapeXml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function localName(name) {
  const idx = name.indexOf(':');
  return (idx === -1 ? name : name.slice(idx + 1)).toLowerCase();
}

/** 找到标签结束的 '>'，跳过引号内的内容。 */
function findTagEnd(src, from) {
  let quote = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

function parseAttributes(src) {
  const attrs = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(src))) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    const key = m[1];
    attrs[key] = decodeEntities(value);
    const local = localName(key);
    if (!(local in attrs)) attrs[local] = attrs[key];
  }
  return attrs;
}

export function parseXml(source) {
  const src = String(source ?? '').replace(/^\uFEFF/, '');
  const root = { name: '#document', local: '#document', attrs: {}, parts: [], parent: null };
  const stack = [root];
  const len = src.length;
  let i = 0;

  const pushText = (raw, alreadyDecoded) => {
    if (!raw) return;
    const text = alreadyDecoded ? raw : decodeEntities(raw);
    if (!text) return;
    stack[stack.length - 1].parts.push({ type: 'text', text });
  };

  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      pushText(end === -1 ? src.slice(lt + 9) : src.slice(lt + 9, end), true);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE（含内部子集）或其它声明：跳到配对的 '>'
      let depth = 0;
      let j = lt;
      for (; j < len; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt + 2);
      const name = src.slice(lt + 2, end === -1 ? len : end).trim();
      i = end === -1 ? len : end + 1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name || stack[k].local === localName(name)) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const end = findTagEnd(src, lt);
    if (end === -1) { pushText(src.slice(lt)); break; }
    let inner = src.slice(lt + 1, end);
    i = end + 1;

    let selfClose = false;
    if (inner.endsWith('/')) { selfClose = true; inner = inner.slice(0, -1); }
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(inner);
    if (!m) continue;

    const name = m[1];
    const node = {
      name,
      local: localName(name),
      attrs: parseAttributes(m[2]),
      parts: [],
      parent: stack[stack.length - 1]
    };
    stack[stack.length - 1].parts.push({ type: 'node', node });
    if (!selfClose) stack.push(node);
  }

  return root;
}

/** 子节点列表（按 local name，忽略命名空间前缀与大小写）。 */
export function children(node, name) {
  const out = [];
  if (!node) return out;
  for (const part of node.parts) {
    if (part.type === 'node' && (!name || part.node.local === String(name).toLowerCase())) {
      out.push(part.node);
    }
  }
  return out;
}

export function firstChild(node, ...names) {
  for (const name of names) {
    const target = String(name).toLowerCase();
    for (const part of node.parts) {
      if (part.type === 'node' && part.node.local === target) return part.node;
    }
  }
  return null;
}

/** 任意层级深度优先查找第一个匹配项。 */
export function findDeep(node, name, maxDepth = 8) {
  const target = String(name).toLowerCase();
  const walk = (n, depth) => {
    if (depth > maxDepth) return null;
    for (const part of n.parts) {
      if (part.type !== 'node') continue;
      if (part.node.local === target) return part.node;
      const found = walk(part.node, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(node, 0);
}

/** 直接文本（不含子元素文本）。 */
export function directText(node) {
  if (!node) return '';
  return node.parts.filter((p) => p.type === 'text').map((p) => p.text).join('').trim();
}

/** 递归文本（含子元素，按出现顺序拼接），用于 description 内嵌 HTML 的情形。 */
export function textOf(node) {
  if (!node) return '';
  let out = '';
  for (const part of node.parts) {
    if (part.type === 'text') out += part.text;
    else out += textOf(part.node);
  }
  return out.trim();
}

/** 取第一个存在且非空的子元素文本（名称大小写不敏感）。 */
export function childText(node, ...names) {
  for (const name of names) {
    const target = String(name).toLowerCase();
    for (const part of node.parts) {
      if (part.type === 'node' && part.node.local === target) {
        const value = textOf(part.node) || directText(part.node);
        if (value) return value;
      }
    }
  }
  return '';
}

export function attrValue(node, ...names) {
  if (!node) return '';
  for (const name of names) {
    const key = String(name).toLowerCase();
    if (node.attrs?.[key] != null && node.attrs[key] !== '') return node.attrs[key];
  }
  return '';
}

const ENTITY_TEXT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', middot: '\u00b7' };

/** 去除 HTML 标签，得到纯文本。用于生成摘要与搜索索引。 */
export function stripHtml(input) {
  if (!input) return '';
  let out = String(input);
  out = out.replace(/<(script|style|noscript)[\s\S]*?<\/\1\s*>/gi, ' ');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  out = out.replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n');
  out = out.replace(/<[^>]*>/g, ' ');
  out = out.replace(/&([a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);/g, (m, body) => {
    if (body[0] === '#') return decodeEntities(m);
    const key = body.toLowerCase();
    return ENTITY_TEXT[key] ?? '';
  });
  out = out.replace(/[ \t\f\v\u00a0]+/g, ' ');
  out = out.replace(/ ?\n ?/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}
