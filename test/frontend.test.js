/**
 * 前端静态一致性 + 净化策略测试
 *
 * 前端没法在 Node 里跑真实 DOM，但「最容易悄悄坏掉」的几类问题都是静态可查的：
 *  - app.js 查询的 DOM id 与 index.html 不一致（拼写错误 → 运行时 null）
 *  - 引用了未定义的 SVG 图标 symbol
 *  - 渲染出的 data-act 在事件分发里没有对应分支
 *  - 净化策略把危险标签/协议列进了白名单
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isSafeUrl, isDroppedTag, isAllowedTag, isAllowedAttr } from '../public/js/sanitize.js';
import { escapeHtml, highlight, relativeTime, clampText, initialOf } from '../public/js/util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 这些 id 由前端在运行时生成，不写在 index.html 里。 */
const RUNTIME_GENERATED_IDS = new Set(['btn-load-more', 'btn-load-demo']);

const HTML = read('public/index.html');
const APP_JS = read('public/js/app.js');
const CSS = read('public/styles.css');

// ---------------------------------------------------------------------------
// DOM 绑定一致性
// ---------------------------------------------------------------------------

test('前端：app.js 通过 $() 引用的每个 id 都存在于 index.html', () => {
  const htmlIds = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set();

  for (const m of APP_JS.matchAll(/\$\('([^']+)'\)/g)) referenced.add(m[1]);
  for (const m of APP_JS.matchAll(/\$\("([^"]+)"\)/g)) referenced.add(m[1]);
  // 模板里动态拼接的 id 也一并收集，例如 $('btn-load-more')
  for (const m of APP_JS.matchAll(/getElementById\('([^']+)'\)/g)) referenced.add(m[1]);

  const missing = [...referenced].filter((id) => !htmlIds.has(id) && !RUNTIME_GENERATED_IDS.has(id));
  assert.deepEqual(missing, [], `app.js 引用了不存在的元素 id：${missing.join(', ')}`);
  assert.ok(referenced.size >= 25, `只检查到 ${referenced.size} 个引用，正则可能失配`);
});

test('前端：index.html 中引用的 SVG 图标都已定义', () => {
  const defined = new Set([...HTML.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([
    ...[...HTML.matchAll(/href="#(i-[a-z-]+)"/g)].map((m) => m[1]),
    ...[...APP_JS.matchAll(/href="#(i-[a-z-]+)"/g)].map((m) => m[1]),
    // 模板字符串中的图标名（如 ${key === 'all' ? 'i-list' : ...}）单独收集
    ...[...APP_JS.matchAll(/'(i-[a-z-]+)'/g)].map((m) => m[1])
  ]);
  const missing = [...used].filter((icon) => !defined.has(icon));
  assert.deepEqual(missing, [], `引用了未定义的图标：${missing.join(', ')}`);
});

test('前端：列表与侧栏渲染出的 data-act 都有事件处理分支', () => {
  const rendered = new Set([...APP_JS.matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]));
  // 事件分发处同时存在 === 'x' 与 dataset 解构
  const handled = new Set([
    ...[...APP_JS.matchAll(/act === '([a-z-]+)'/g)].map((m) => m[1]),
    ...[...APP_JS.matchAll(/\[data-act="([a-z-]+)"\]/g)].map((m) => m[1]),
    // 弹窗按钮通过 foot.querySelector('[data-act="x"]') 绑定
    ...[...APP_JS.matchAll(/querySelector\('\[data-act="([a-z-]+)"\]'\)/g)].map((m) => m[1])
  ]);
  const missing = [...rendered].filter((act) => !handled.has(act));
  assert.deepEqual(missing, [], `存在未处理的 data-act：${missing.join(', ')}`);
});

test('前端：样式表定义了 JS 动态添加的关键类名', () => {
  for (const cls of ['article-item', 'side-item', 'seg-btn', 'toast', 'modal', 'reader-body', 'drag-over', 'empty-state', 'feed-favicon', 'article-dot']) {
    assert.ok(CSS.includes(`.${cls}`), `styles.css 缺少 .${cls}`);
  }
});

test('前端：主题变量在深色与浅色下都被定义', () => {
  for (const token of ['--bg', '--panel', '--border', '--text', '--accent']) {
    const count = (CSS.match(new RegExp(`${token}:`, 'g')) || []).length;
    assert.ok(count >= 2, `${token} 只在 ${count} 处定义，深浅色主题不完整`);
  }
});

test('前端：未使用任何外部 CDN / 远程脚本（本地优先）', () => {
  const remote = [
    ...[...HTML.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
  ].filter((url) => !url.includes('127.0.0.1'));
  assert.deepEqual(remote, [], `页面引用了外部资源：${remote.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 净化策略
// ---------------------------------------------------------------------------

test('净化：危险的容器标签整块丢弃', () => {
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'svg', 'template', 'link', 'meta', 'video']) {
    assert.equal(isDroppedTag(tag), true, `${tag} 应被整块丢弃`);
    assert.equal(isDroppedTag(tag.toUpperCase()), true, `大写 ${tag} 也应被丢弃`);
  }
});

test('净化：常用排版标签被保留', () => {
  for (const tag of ['p', 'h1', 'h3', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'em', 'a', 'img', 'table', 'td', 'figure']) {
    assert.equal(isAllowedTag(tag), true, `${tag} 应被保留`);
  }
});

test('净化：事件属性与内联样式不在白名单', () => {
  for (const attr of ['onclick', 'onerror', 'onload', 'onmouseover', 'style', 'formaction', 'srcdoc', 'xlink:href']) {
    assert.equal(isAllowedAttr(attr), false, `${attr} 不应被保留`);
  }
  for (const attr of ['href', 'src', 'title', 'alt', 'colspan', 'datetime']) {
    assert.equal(isAllowedAttr(attr), true, `${attr} 应被保留`);
  }
});

test('净化：javascript / vbscript / 数据 URI 等危险协议被拦截', () => {
  const unsafe = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    // 带内嵌脚本的 SVG 伪装为图片，也必须拦掉
    'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PjxhbGVydCgxKT48L3NjcmlwdD48L3N2Zz4=',
    ''
  ];
  for (const url of unsafe) {
    assert.equal(isSafeUrl(url), false, `危险协议未被拦截：${JSON.stringify(url)}`);
  }
});

test('净化：正常链接与图片地址放行', () => {
  for (const url of ['https://example.com/a', 'http://example.com/a', 'mailto:a@b.com', '#anchor', '/relative/path', './x.png', 'https://example.com/图.png']) {
    assert.equal(isSafeUrl(url), true, `正常地址被误杀：${url}`);
  }
  assert.equal(isSafeUrl('data:image/png;base64,iVBORw0KGgo=', { allowData: true }), true);
  assert.equal(isSafeUrl('data:image/png;base64,iVBORw0KGgo='), false, '默认不应允许 data URI');
});

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

test('工具：escapeHtml 阻断标记注入', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('"quoted" & \'single\''), '&quot;quoted&quot; &amp; &#39;single&#39;');
  assert.equal(escapeHtml(null), '');
});

test('工具：highlight 转义后再包 mark，不产生可执行标签', () => {
  const html = highlight('<script>x</script> 关键词', '关键词');
  assert.ok(!html.includes('<script>'), '高亮结果不能出现原始 script 标签');
  assert.ok(html.includes('<mark>关键词</mark>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('工具：highlight 对正则元字符做转义，不会误匹配或崩溃', () => {
  const html = highlight('a.b 与 axb', '.');
  assert.ok(html.includes('<mark>.</mark>'));
  assert.ok(!html.includes('<mark>a</mark>'), '点号不应被当成通配符');
  assert.equal(highlight('abc', ''), 'abc');
});

test('工具：relativeTime 覆盖各时间尺度', () => {
  const now = Date.now();
  assert.equal(relativeTime(now - 10_000), '刚刚');
  assert.equal(relativeTime(now - 5 * 60_000), '5 分钟前');
  assert.equal(relativeTime(now - 3 * 3_600_000), '3 小时前');
  assert.ok(relativeTime(now - 40 * 3_600_000).length > 0);
  assert.equal(relativeTime(null), '');
});

test('工具：clampText 与 initialOf', () => {
  assert.equal(clampText('abcdef', 4), 'abc…');
  assert.equal(clampText('abc', 10), 'abc');
  assert.equal(initialOf('Lumen'), 'L');
  assert.equal(initialOf('科技观察'), '科');
  assert.equal(initialOf(''), 'R');
});
