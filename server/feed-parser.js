/**
 * 订阅源格式归一化：RSS 2.0 / RSS 1.0(RDF) / Atom 1.0 → 统一结构。
 * 目标：无论源用什么方言，下游只面对一种数据结构。
 */
import {
  parseXml, children, firstChild, findDeep, childText, directText, textOf,
  attrValue, stripHtml, decodeEntities, escapeXml
} from './xml.js';

const MAX_ITEMS_PER_FETCH = 400;

/** 把解析树还原为 HTML 字符串（用于 Atom type="xhtml" 的正文）。 */
function innerHtml(node) {
  if (!node) return '';
  let out = '';
  for (const part of node.parts) {
    if (part.type === 'text') {
      out += escapeXml(part.text);
      continue;
    }
    const child = part.node;
    const attrs = Object.entries(child.attrs)
      // attrs 里同时存了带前缀与不带前缀的键，去重时只保留原名
      .filter(([key]) => key === child.local || !Object.prototype.hasOwnProperty.call(child.attrs, key.split(':').pop()))
      .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
      .join('');
    const inner = innerHtml(child);
    out += inner ? `<${child.name}${attrs}>${inner}</${child.name}>` : `<${child.name}${attrs} />`;
  }
  return out;
}

/** 取 HTML 型字段的真实内容（兼容 type="html|xhtml|text"）。 */
function htmlField(node) {
  if (!node) return '';
  const type = (attrValue(node, 'type') || 'text').toLowerCase();
  if (type === 'xhtml') {
    const div = firstChild(node, 'div') || node;
    const html = innerHtml(div);
    return html || textOf(node);
  }
  if (type === 'html') return textOf(node) || directText(node);
  return textOf(node) || directText(node);
}

function textField(node) {
  if (!node) return '';
  const type = (attrValue(node, 'type') || 'text').toLowerCase();
  const raw = textOf(node) || directText(node);
  if (type === 'html' || type === 'xhtml') return stripHtml(raw);
  return decodeEntities(raw).replace(/\s+/g, ' ').trim();
}

export function resolveUrl(base, href) {
  if (!href) return '';
  const value = String(href).trim();
  if (!value) return '';
  if (/^(https?:|mailto:|data:)/i.test(value)) return value;
  try {
    return new URL(value, base || undefined).toString();
  } catch {
    return value;
  }
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const TZ_OFFSETS = { ut: 0, utc: 0, gmt: 0, z: 0, est: -5, edt: -4, cst: -6, cdt: -5, mst: -7, mdt: -6, pst: -8, pdt: -7, cet: 1, cest: 2, bst: 1, jst: 9, cst8: 8 };

/**
 * 容错日期解析：先交给 Date.parse（覆盖 ISO8601 / RFC822），
 * 失败则按常见无序格式手工解析，最后返回 null。
 */
export function parseDate(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const direct = Date.parse(raw);
  if (validTimestamp(direct)) return direct;

  // 去掉星期前缀："Tue," / "周二,"
  const cleaned = raw.replace(/^[A-Za-z\u4e00-\u9fa5]{2,10}\s*,\s*/, '').trim();

  // 24 Jan 2024 10:00:00 +0800  /  24 Jan 2024 10:00
  let m = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?/.exec(cleaned);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month != null) return buildTs(m[3], month, m[1], m[4], m[5], m[6] || '0', m[7]);
  }

  // Jan 24, 2024 10:00:00 GMT
  m = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?/.exec(cleaned);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month != null) return buildTs(m[3], month, m[2], m[4], m[5], m[6] || '0', m[7]);
  }

  // 2024-01-24 10:00:00（无时区，按 UTC 处理）
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(cleaned);
  if (m) {
    return buildTs(m[1], Number(m[2]) - 1, m[3], m[4] || '0', m[5] || '0', m[6] || '0', null);
  }

  // 前面已尝试过 Date.parse，等价于 new Date(raw)，这里不再重复尝试
  return null;
}

function buildTs(year, month, day, hour, minute, second, tz) {
  let y = Number(year);
  if (y < 100) y += y < 70 ? 2000 : 1900;
  let offsetMinutes = 0;
  if (tz) {
    const t = tz.toLowerCase();
    if (/^[+-]\d{4}$/.test(tz)) {
      offsetMinutes = (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))) * (tz[0] === '-' ? -1 : 1);
    } else if (TZ_OFFSETS[t] != null) {
      offsetMinutes = TZ_OFFSETS[t] * 60;
    }
  }
  const ts = Date.UTC(y, month, Number(day), Number(hour), Number(minute), Number(second)) - offsetMinutes * 60000;
  return validTimestamp(ts) ? ts : null;
}

/**
 * 时间戳有效性：排除解析失败、1970 之前以及明显离谱的未来时间。
 * 脏时间会直接污染「按发布时间倒序」的排序结果，必须在入口拦掉。
 */
function validTimestamp(ts) {
  return Number.isFinite(ts) && ts >= 0 && ts <= Date.now() + 3 * 86400000;
}

function pickAtomLink(node, base, rel = 'alternate') {
  let fallback = '';
  for (const link of children(node, 'link')) {
    const href = attrValue(link, 'href') || textOf(link);
    if (!href) continue;
    const linkRel = (attrValue(link, 'rel') || 'alternate').toLowerCase();
    const type = (attrValue(link, 'type') || '').toLowerCase();
    if (linkRel === rel && (!type || type.includes('html') || type === 'application/atom+xml')) {
      return resolveUrl(base, href);
    }
    if (!fallback && linkRel === 'alternate') fallback = resolveUrl(base, href);
  }
  return fallback;
}

function dedupeByGuid(items) {
  const seen = new Map();
  // 同 guid 出现多次时保留「信息更完整」的一条：按正文+摘要长度收敛
  const richness = (x) => (x.contentHtml || '').length + (x.summary || '').length;
  for (const item of items) {
    const key = item.guid || item.link || `${item.title}::${item.publishedAt}`;
    item.guid = key;
    const prev = seen.get(key);
    if (!prev || richness(item) > richness(prev)) seen.set(key, item);
  }
  return [...seen.values()];
}

function normalizeRssItem(node, base) {
  // guid 优先；缺失时退回 link；两者都无则交给上层用标题+时间合成稳定 ID
  const guidText = childText(node, 'guid', 'id') || childText(node, 'link');
  const link = resolveUrl(base, childText(node, 'link', 'origLink'));
  const contentNode = firstChild(node, 'encoded', 'content');
  const descriptionNode = firstChild(node, 'description', 'summary');
  const contentHtml = contentNode
    ? htmlField(contentNode)
    : (descriptionNode ? htmlField(descriptionNode) : '');
  const published = parseDate(childText(node, 'pubDate', 'date', 'published', 'updated', 'created'));

  return {
    guid: decodeEntities(guidText || link).trim(),
    title: decodeEntities(childText(node, 'title')).replace(/\s+/g, ' ').trim() || '（无标题）',
    link,
    author: decodeEntities(childText(node, 'creator', 'author', 'name')).trim(),
    summary: stripHtml(contentHtml).slice(0, 1200),
    contentHtml,
    publishedAt: published,
    categories: children(node, 'category').map((c) => textField(c)).filter(Boolean).slice(0, 12)
  };
}

function normalizeAtomEntry(node, base) {
  const contentNode = firstChild(node, 'content');
  const summaryNode = firstChild(node, 'summary');
  const contentHtml = contentNode ? htmlField(contentNode) : (summaryNode ? htmlField(summaryNode) : '');
  const link = pickAtomLink(node, base, 'alternate') || resolveUrl(base, childText(node, 'link'));
  const authorNode = firstChild(node, 'author');
  const published = parseDate(
    childText(node, 'published', 'updated', 'issued', 'created', 'modified', 'date')
  );

  return {
    guid: decodeEntities(childText(node, 'id') || link).trim(),
    title: textField(firstChild(node, 'title')) || '（无标题）',
    link,
    author: authorNode ? (textField(firstChild(authorNode, 'name')) || textField(authorNode)) : textField(firstChild(node, 'author')),
    summary: stripHtml(summaryNode ? htmlField(summaryNode) : contentHtml).slice(0, 1200),
    contentHtml,
    publishedAt: published,
    categories: children(node, 'category').map((c) => attrValue(c, 'term') || textField(c)).filter(Boolean).slice(0, 12)
  };
}

/**
 * 主入口：返回归一化后的订阅源数据。
 * @param {string} body  订阅源正文
 * @param {string} feedUrl 该订阅源的请求地址（用于解析相对链接）
 */
export function parseFeed(body, feedUrl = '') {
  const doc = parseXml(body);
  const root = children(doc)[0];
  if (!root) {
    const err = new Error('内容不是有效的 XML');
    err.code = 'PARSE_EMPTY';
    throw err;
  }

  const rootName = root.local;
  let format = 'unknown';
  let channel = null;
  let itemNodes = [];

  if (rootName === 'rss') {
    format = 'rss';
    channel = firstChild(root, 'channel') || root;
    itemNodes = children(channel, 'item');
  } else if (rootName === 'feed') {
    format = 'atom';
    channel = root;
    itemNodes = children(root, 'entry');
  } else if (rootName === 'rdf' || rootName === 'rdf:rdf') {
    format = 'rdf';
    channel = firstChild(root, 'channel') || root;
    itemNodes = children(root, 'item');
  } else if (rootName === 'channel') {
    format = 'rss';
    channel = root;
    itemNodes = children(root, 'item');
  } else {
    // 有些源把 RSS 包在其它根节点里，尽力而为
    const deepChannel = findDeep(root, 'channel');
    const deepFeed = findDeep(root, 'feed');
    channel = deepChannel || deepFeed || root;
    itemNodes = [...children(channel, 'item'), ...children(channel, 'entry')];
    if (itemNodes.length) format = deepChannel ? 'rss' : 'atom';
  }

  if (!itemNodes.length && format === 'unknown') {
    const err = new Error('未识别出 RSS/Atom 结构（可能返回的是 HTML 页面）');
    err.code = 'PARSE_UNKNOWN';
    throw err;
  }

  const feedLink = format === 'atom'
    ? (pickAtomLink(channel, feedUrl, 'alternate') || resolveUrl(feedUrl, childText(channel, 'link')))
    : resolveUrl(feedUrl, childText(channel, 'link'));

  let iconUrl = '';
  const imageNode = firstChild(channel, 'image');
  if (imageNode) iconUrl = resolveUrl(feedUrl, childText(imageNode, 'url') || attrValue(imageNode, 'href'));
  if (!iconUrl) iconUrl = resolveUrl(feedUrl, childText(channel, 'icon', 'logo'));

  let title = format === 'atom'
    ? (textField(firstChild(channel, 'title')) || childText(channel, 'title'))
    : decodeEntities(childText(channel, 'title')).replace(/\s+/g, ' ').trim();

  const description = format === 'atom'
    ? (textField(firstChild(channel, 'subtitle')) || childText(channel, 'subtitle'))
    : stripHtml(htmlField(firstChild(channel, 'description', 'subtitle')) || '').slice(0, 500);

  const ttl = Number(childText(channel, 'ttl'));
  const normalizedItems = itemNodes
    .slice(0, MAX_ITEMS_PER_FETCH)
    .map((node) => (format === 'atom' ? normalizeAtomEntry(node, feedUrl) : normalizeRssItem(node, feedUrl)));

  return {
    format,
    title: title || '',
    siteUrl: feedLink || '',
    description: description || '',
    iconUrl: iconUrl || '',
    ttlMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    items: dedupeByGuid(normalizedItems)
  };
}

export { MAX_ITEMS_PER_FETCH };
