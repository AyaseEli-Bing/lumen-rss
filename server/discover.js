/**
 * 智能地址解析：用户经常直接粘贴「网站首页」而不是「订阅源地址」。
 * 这里先尝试按订阅源解析，失败则扫描页面里的 <link rel="alternate"> 做自动发现。
 */
import { fetchFeedDocument, FetchError } from './http.js';
import { parseFeed } from './feed-parser.js';
import { parseXml, children, attrValue } from './xml.js';
import { resolveUrl } from './feed-parser.js';

const FEED_TYPES = /(application\/(rss|atom)\+xml|application\/xml|text\/xml)/i;
const COMMON_PATHS = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/feeds/all.atom.xml'];

/** 从 HTML 中提取候选订阅源地址。 */
export function extractFeedLinks(html, baseUrl) {
  const out = [];
  const push = (href, title = '') => {
    const url = resolveUrl(baseUrl, href);
    if (url && !out.some((x) => x.url === url)) out.push({ url, title });
  };

  const linkRe = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRe.exec(html))) {
    const tag = match[0];
    const rel = /rel\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1] || '';
    const type = /type\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1] || '';
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || /href\s*=\s*([^\s>]+)/i.exec(tag)?.[1] || '';
    if (!href || !/alternate/i.test(rel)) continue;
    if (FEED_TYPES.test(type) || /\.(xml|rss|atom)(\?|$)/i.test(href)) {
      push(href, /title\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || '');
    }
  }

  // 兜底：页面里直接出现的 .xml / /feed 链接
  const hrefRe = /href\s*=\s*["']([^"']*(?:\/feed\/?|\/rss\/?|\.xml|\.rss|atom)[^"']*)["']/gi;
  while ((match = hrefRe.exec(html))) {
    if (/\.css|\.js|\.png|\.jpg|\.svg|\.ico/i.test(match[1])) continue;
    push(match[1]);
    if (out.length >= 12) break;
  }

  return out.slice(0, 12);
}

/**
 * 解析出真正可用的订阅源地址与内容。
 * @returns {Promise<{feedUrl:string, parsed:object, etag:string, lastModified:string, discovered:boolean}>}
 */
export async function resolveFeedUrl(inputUrl, { timeoutMs = 12000, maxBytes = 8 * 1024 * 1024, signal = null } = {}) {
  const url = normalizeInputUrl(inputUrl);

  // 这是一次「用户主动提交地址」的解析，任何失败都应作为可读的校验错误返回（HTTP 422），
  // 而不是把目标站点的 404/500 原样透传，否则用户看到的是「接口不存在」这类误导信息。
  let first;
  try {
    first = await fetchFeedDocument(url, { timeoutMs, maxBytes, retries: 0, signal });
  } catch (err) {
    throw new FetchError(`无法读取该地址：${err.message}`, { code: 'NOT_A_FEED', retryable: false });
  }

  if (!first.notModified) {
    try {
      const parsed = parseFeed(first.body, first.finalUrl);
      return { feedUrl: first.finalUrl || url, parsed, etag: first.etag, lastModified: first.lastModified, discovered: false };
    } catch (parseErr) {
      // 继续尝试自动发现
      const candidates = extractFeedLinks(first.body, first.finalUrl || url)
        .filter((c) => c.url !== url);
      for (const candidate of candidates.slice(0, 4)) {
        try {
          const res = await fetchFeedDocument(candidate.url, { timeoutMs, maxBytes, retries: 0, signal });
          if (res.notModified) continue;
          const parsed = parseFeed(res.body, res.finalUrl || candidate.url);
          return { feedUrl: res.finalUrl || candidate.url, parsed, etag: res.etag, lastModified: res.lastModified, discovered: true };
        } catch { /* 试下一个候选 */ }
      }

      for (const path of COMMON_PATHS) {
        const guess = resolveUrl(url, path);
        if (!guess || guess === url) continue;
        try {
          const res = await fetchFeedDocument(guess, { timeoutMs, maxBytes, retries: 0, signal });
          if (res.notModified) continue;
          const parsed = parseFeed(res.body, guess);
          return { feedUrl: guess, parsed, etag: res.etag, lastModified: res.lastModified, discovered: true };
        } catch { /* 试下一个候选 */ }
      }

      throw new FetchError(`该地址不是可识别的订阅源：${parseErr.message}`, { code: 'NOT_A_FEED' });
    }
  }
  throw new FetchError('服务端返回 304，地址有效但无法取得内容', { code: 'NOT_MODIFIED_FIRST_FETCH' });
}

export function normalizeInputUrl(input) {
  let value = String(input || '').trim();
  if (!value) throw new FetchError('订阅地址不能为空', { code: 'INVALID_URL' });
  if (!/^https?:\/\//i.test(value)) {
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)) value = `https://${value}`;
    else throw new FetchError('请输入完整的 http/https 地址', { code: 'INVALID_URL' });
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new FetchError('地址格式不正确', { code: 'INVALID_URL' }); }
  if (!/^https?:$/.test(parsed.protocol)) throw new FetchError('仅支持 http/https 协议', { code: 'INVALID_URL' });
  return parsed.toString();
}

/** 生成 OPML 2.0 文档（导出订阅）。 */
export function buildOpml(folders, feeds) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const now = new Date().toUTCString();

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<opml version="2.0">');
  lines.push('  <head>');
  lines.push(`    <title>Lumen RSS 订阅导出</title>`);
  lines.push(`    <dateCreated>${now}</dateCreated>`);
  lines.push('  </head>');
  lines.push('  <body>');

  const byFolder = new Map();
  for (const feed of feeds) {
    const key = feed.folderId || '__none__';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(feed);
  }

  const outline = (feed, indent) => {
    const attrs = [
      `text="${esc(feed.title)}"`,
      `title="${esc(feed.title)}"`,
      `type="rss"`,
      `xmlUrl="${esc(feed.url)}"`
    ];
    if (feed.siteUrl) attrs.push(`htmlUrl="${esc(feed.siteUrl)}"`);
    lines.push(`${indent}<outline ${attrs.join(' ')} />`);
  };

  for (const folder of folders) {
    const list = byFolder.get(folder.id) || [];
    lines.push(`    <outline text="${esc(folder.name)}" title="${esc(folder.name)}">`);
    for (const feed of list) outline(feed, '      ');
    lines.push('    </outline>');
  }
  const loose = byFolder.get('__none__') || [];
  for (const feed of loose) outline(feed, '    ');

  lines.push('  </body>');
  lines.push('</opml>');
  return lines.join('\n');
}

/** 解析 OPML，返回 {folders:[{name, feeds:[{title, xmlUrl, htmlUrl}]}]}。 */
export function parseOpml(xmlText) {
  const doc = parseXml(xmlText);
  const body = findFirst(doc, 'body');
  const root = body || doc;
  const groups = [];

  const walk = (node, folderName) => {
    for (const child of children(node)) {
      if (child.local !== 'outline') continue;
      const xmlUrl = attrValue(child, 'xmlUrl', 'xmlurl');
      const text = attrValue(child, 'text', 'title') || '';
      if (xmlUrl) {
        groups.push({ folder: folderName, feed: { title: text, xmlUrl, htmlUrl: attrValue(child, 'htmlUrl', 'htmlurl') } });
      } else {
        walk(child, text || folderName);
      }
    }
  };

  walk(root, null);

  // 汇总成「按文件夹分组」的结构
  const byFolder = new Map();
  for (const entry of groups) {
    const key = entry.folder || '';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(entry.feed);
  }
  return {
    total: groups.length,
    folders: [...byFolder.entries()].map(([name, feeds]) => ({ name, feeds }))
  };
}

function findFirst(node, name) {
  for (const child of children(node)) {
    if (child.local === name) return child;
    const deep = findFirst(child, name);
    if (deep) return deep;
  }
  return null;
}
