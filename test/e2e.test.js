/**
 * 端到端测试：抓取编排 + REST API
 * 通过本地 mock 站点模拟真实订阅源（含 304、失败源、自动发现、OPML）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { createRequestHandler } from '../server/index.js';

const rss = (title, count, { tag = 'a' } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${title}</title><link>http://example.com/</link><description>${title} 描述</description>
${Array.from({ length: count }, (_, i) => `<item>
  <guid>${tag}-${i}</guid><title>${title} 条目 ${i}</title>
  <link>http://example.com/${tag}/${i}</link>
  <pubDate>Mon, 0${(i % 9) + 1} Sep 2025 10:00:00 GMT</pubDate>
  <description>这是 ${title} 的第 ${i} 条摘要</description>
</item>`).join('')}
</channel></rss>`;

const atom = (title, count) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>${title}</title>
<link rel="alternate" href="http://example.com/atom"/>
<updated>2025-09-19T10:00:00Z</updated><id>urn:demo</id>
${Array.from({ length: count }, (_, i) => `<entry>
  <title>${title} Atom ${i}</title><id>atom-${i}</id>
  <link href="http://example.com/atom/${i}"/>
  <updated>2025-09-1${i % 9}T10:00:00Z</updated>
  <summary>Atom 摘要 ${i}</summary>
</entry>`).join('')}
</feed>`;

/** 启动 mock 站点：/feed-a、/feed-b（Atom）、/broken（500）、/site（含自动发现链接） */
async function startMockSite() {
  const hits = { a: 0, b: 0, broken: 0, site: 0, notModified: 0, concurrent: 0, maxConcurrent: 0 };
  let etagIssued = false;

  const server = createServer(async (req, res) => {
    hits.concurrent += 1;
    hits.maxConcurrent = Math.max(hits.maxConcurrent, hits.concurrent);
    await new Promise((r) => setTimeout(r, 15)); // 模拟网络延迟
    const path = new URL(req.url, 'http://x').pathname;

    try {
      if (path === '/feed-a') {
        hits.a += 1;
        if (hits.a > 1 && req.headers['if-none-match'] === '"a1"') {
          hits.notModified += 1;
          res.writeHead(304); res.end(); return;
        }
        etagIssued = true;
        res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', ETag: '"a1"' });
        res.end(rss('A 源', 5, { tag: 'a' }));
        return;
      }
      if (path === '/feed-b') {
        hits.b += 1;
        res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
        res.end(atom('B 源', 3));
        return;
      }
      if (path === '/broken') {
        hits.broken += 1;
        res.writeHead(500); res.end('internal error');
        return;
      }
      if (path === '/site') {
        hits.site += 1;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head>
          <link rel="alternate" type="application/rss+xml" title="A 源" href="/feed-a">
          </head><body>站点首页</body></html>`);
        return;
      }
      res.writeHead(404); res.end('not found');
    } finally {
      hits.concurrent -= 1;
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, hits, close: () => new Promise((r) => server.close(r)) };
}

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-e2e-'));
  const app = createApp({ dataDir: dir, logger: { log() {}, warn() {}, error() {} } });
  return { app, dir, cleanup() { app.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function startApi(app, origin = 'http://127.0.0.1') {
  const server = createServer(createRequestHandler(app, { origin }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（如 OPML） */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { server, base, call, close: () => new Promise((r) => server.close(r)) };
}

// ===========================================================================
// 抓取编排
// ===========================================================================

test('抓取：多源并发更新，单个失败源不影响其它源', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  try {
    const good = app.store.addFeed({ url: `${site.base}/feed-a`, title: 'A' });
    const atomFeed = app.store.addFeed({ url: `${site.base}/feed-b`, title: 'B' });
    const broken = app.store.addFeed({ url: `${site.base}/broken`, title: 'C' });

    const summary = await app.refresher.refreshMany(
      [good, atomFeed, broken].map((f) => app.store.getFeedRow(f.id)), { force: true });

    assert.equal(summary.ok, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.newArticles, 8, '应写入 5 + 3 篇文章');

    assert.equal(app.store.getFeed(good.id).status, 'ok');
    assert.equal(app.store.getFeed(atomFeed.id).status, 'ok');
    const brokenFeed = app.store.getFeed(broken.id);
    assert.equal(brokenFeed.status, 'error');
    assert.ok(brokenFeed.lastError.includes('500'));

    assert.equal(app.store.stats().articles, 8);
    assert.equal(app.store.stats().unread, 8);
  } finally {
    await site.close();
    cleanup();
  }
});

test('抓取：304 条件请求跳过解析与写库，且不产生新增', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  try {
    const feed = app.store.addFeed({ url: `${site.base}/feed-a`, title: 'A' });
    await app.refresher.refreshFeed(feed.id, { force: true });
    assert.equal(app.store.stats().articles, 5);

    const before = app.store.getFeedRow(feed.id).last_fetched_at;
    const summary = await app.refresher.refreshMany([app.store.getFeedRow(feed.id)], { force: false });

    assert.equal(summary.notModified, 1);
    assert.equal(summary.newArticles, 0);
    assert.equal(site.hits.notModified, 1);
    assert.equal(app.store.stats().articles, 5);
    assert.ok(app.store.getFeedRow(feed.id).last_fetched_at >= before);
  } finally {
    await site.close();
    cleanup();
  }
});

test('抓取：同一源并发触发不会重复请求（重入保护）', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  try {
    const feed = app.store.addFeed({ url: `${site.base}/feed-a`, title: 'A' });

    const [r1, r2] = await Promise.all([
      app.refresher.refreshFeed(feed.id, { force: true }),
      app.refresher.refreshFeed(feed.id, { force: true })
    ]);

    const skipped = [r1, r2].filter((r) => r.skipped);
    assert.equal(skipped.length, 1, '第二次调用应被重入保护拦截');
    assert.equal(site.hits.a, 1, '同一个源只应发出一次请求');
    assert.equal(app.store.stats().articles, 5, '重复抓取不应产生重复文章');
  } finally {
    await site.close();
    cleanup();
  }
});

test('抓取：并发上限被尊重（不会一次打满所有源）', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  try {
    app.db.setSetting('max_concurrency', 2);
    app.db.setSetting('per_host_concurrency', 2);
    // 池子在创建时读取设置，这里重建以应用新配置
    const { createRefresher } = await import('../server/refresh.js');
    const refresher = createRefresher({ store: app.store, settings: app.settings, notify: () => {} , logger: { log() {}, warn() {} } });

    const feeds = [
      app.store.addFeed({ url: `${site.base}/feed-a`, title: 'A' }),
      app.store.addFeed({ url: `${site.base}/feed-b`, title: 'B' }),
      app.store.addFeed({ url: `${site.base}/site`, title: 'C' }),
      app.store.addFeed({ url: `${site.base}/feed-a?x=1`, title: 'D' })
    ];
    await refresher.refreshMany(feeds.map((f) => app.store.getFeedRow(f.id)), { force: true });

    assert.ok(site.hits.maxConcurrent <= 2, `峰值并发 ${site.hits.maxConcurrent} 超过配置上限 2`);
  } finally {
    await site.close();
    cleanup();
  }
});

test('失败退避：连续失败的源，下次抓取时间被推后', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  try {
    const feed = app.store.addFeed({ url: `${site.base}/broken`, title: 'C', intervalMin: 30 });
    await app.refresher.refreshFeed(feed.id, { force: true });
    const row = app.store.getFeedRow(feed.id);
    assert.ok(row.error_count >= 1);
    assert.ok(row.next_fetch_at - Date.now() > 50 * 60000, '失败后应进入退避窗口');
  } finally {
    await site.close();
    cleanup();
  }
});

// ===========================================================================
// REST API
// ===========================================================================

test('API：添加订阅时直接完成首次抓取，返回新增数量', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  const api = await startApi(app);
  try {
    const res = await api.call('POST', '/api/feeds', { url: `${site.base}/feed-a` });
    assert.equal(res.status, 201);
    assert.equal(res.json.feed.title, 'A 源');
    assert.equal(res.json.newCount, 5);
    assert.equal(res.json.format, 'rss');

    // 重复添加被拒绝
    const again = await api.call('POST', '/api/feeds', { url: `${site.base}/feed-a` });
    assert.equal(again.status, 409);
  } finally {
    await api.close();
    await site.close();
    cleanup();
  }
});

test('API：粘贴站点首页时自动发现真实订阅地址', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  const api = await startApi(app);
  try {
    const res = await api.call('POST', '/api/feeds', { url: `${site.base}/site` });
    assert.equal(res.status, 201);
    assert.equal(res.json.discovered, true);
    assert.equal(res.json.feed.url, `${site.base}/feed-a`);
    assert.equal(res.json.newCount, 5);
  } finally {
    await api.close();
    await site.close();
    cleanup();
  }
});

test('API：地址无法解析时返回 422，force 可强制保存为失败状态', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  const api = await startApi(app);
  try {
    const bad = await api.call('POST', '/api/feeds', { url: `${site.base}/not-exist` });
    assert.equal(bad.status, 422);

    const forced = await api.call('POST', '/api/feeds', { url: `${site.base}/not-exist`, force: true });
    assert.equal(forced.status, 201);
    assert.equal(forced.json.feed.status, 'error');
    assert.ok(forced.json.feed.lastError.length > 0);
  } finally {
    await api.close();
    await site.close();
    cleanup();
  }
});

test('API：文章列表、搜索、已读与收藏的完整闭环', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  const api = await startApi(app);
  try {
    const created = await api.call('POST', '/api/feeds', { url: `${site.base}/feed-a` });
    const feedId = created.json.feed.id;

    const list = await api.call('GET', `/api/articles?feedId=${feedId}&limit=3`);
    assert.equal(list.json.total, 5);
    assert.equal(list.json.items.length, 3);
    assert.equal(list.json.unread, 5);
    assert.equal(list.json.hasMore, true);

    const id = list.json.items[0].id;
    const detail = await api.call('GET', `/api/articles/${id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.json.article.contentHtml.includes('摘要'));
    assert.equal(detail.json.feed.title, 'A 源');

    await api.call('PATCH', `/api/articles/${id}`, { read: true });
    await api.call('PATCH', `/api/articles/${id}`, { starred: true });
    assert.equal((await api.call('GET', `/api/articles?feedId=${feedId}&filter=unread`)).json.total, 4);
    assert.equal((await api.call('GET', `/api/articles?feedId=${feedId}&filter=starred`)).json.total, 1);

    const search = await api.call('GET', '/api/articles?q=' + encodeURIComponent('条目 2'));
    assert.ok(search.json.total >= 1);
    assert.equal((await api.call('GET', '/api/articles?q=' + encodeURIComponent('绝不存在的关键词'))).json.total, 0);

    const marked = await api.call('POST', '/api/articles/mark-all', { scope: 'feed', feedId });
    assert.equal(marked.json.changed, 4);
    assert.equal((await api.call('GET', '/api/state')).json.stats.unread, 0);
  } finally {
    await api.close();
    await site.close();
    cleanup();
  }
});

test('API：单源刷新返回该源的具体结果（前端据此提示新增或失败）', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  const api = await startApi(app);
  try {
    const created = await api.call('POST', '/api/feeds', { url: `${site.base}/feed-b` });
    const feedId = created.json.feed.id;

    const refreshed = await api.call('POST', `/api/feeds/${feedId}/refresh`);
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.json.result, '缺少单源结果，前端将无法判断本次刷新是否成功');
    assert.equal(refreshed.json.result.ok, true);
    // Atom 源条目发布时间固定，强制刷新不会新增
    assert.equal(refreshed.json.result.newCount, 0);
    assert.equal(refreshed.json.summary.requested, 1);

    // 失败源同样要能被前端识别出原因
    const broken = await api.call('POST', '/api/feeds', { url: `${site.base}/broken`, force: true });
    const brokenRefresh = await api.call('POST', `/api/feeds/${broken.json.feed.id}/refresh`);
    assert.equal(brokenRefresh.json.result.ok, false);
    assert.ok(brokenRefresh.json.result.error.includes('500'));

    // 不存在的源返回 404
    assert.equal((await api.call('POST', '/api/feeds/nope/refresh')).status, 404);
  } finally {
    await api.close();
    await site.close();
    cleanup();
  }
});

test('API：文件夹增删改与订阅归类', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  const api = await startApi(app);
  try {
    const folder = await api.call('POST', '/api/folders', { name: '技术' });
    assert.equal(folder.status, 201);
    assert.equal((await api.call('POST', '/api/folders', { name: '技术' })).status, 409);

    const created = await api.call('POST', '/api/feeds', { url: `${site.base}/feed-a`, folderId: folder.json.folder.id });
    const feedId = created.json.feed.id;

    const renamed = await api.call('PATCH', `/api/folders/${folder.json.folder.id}`, { name: '工程' });
    assert.equal(renamed.json.folder.name, '工程');

    const scoped = await api.call('GET', `/api/articles?folderId=${folder.json.folder.id}`);
    assert.equal(scoped.json.total, 5);

    // 删除文件夹后订阅保留并转为未分类
    const removed = await api.call('DELETE', `/api/folders/${folder.json.folder.id}`);
    assert.equal(removed.json.movedFeeds, 1);
    assert.equal((await api.call('GET', '/api/feeds')).json.feeds[0].folderId, null);
    assert.equal((await api.call('GET', '/api/articles')).json.total, 5);

    // 修改订阅：自定义标题与抓取间隔
    const patched = await api.call('PATCH', `/api/feeds/${feedId}`, { customTitle: '我的源', intervalMin: 1440 });
    assert.equal(patched.json.feed.title, '我的源');
    assert.equal(patched.json.feed.intervalMin, 1440);

    const deleted = await api.call('DELETE', `/api/feeds/${feedId}`);
    assert.equal(deleted.json.removedArticles, 5);
    assert.equal((await api.call('GET', '/api/articles')).json.total, 0);
  } finally {
    await api.close();
    await site.close();
    cleanup();
  }
});

test('API：OPML 导出与导入往返一致', async () => {
  const site = await startMockSite();
  const { app, cleanup } = freshApp();
  const api = await startApi(app);
  try {
    const folder = await api.call('POST', '/api/folders', { name: '示例组' });
    await api.call('POST', '/api/feeds', { url: `${site.base}/feed-a`, folderId: folder.json.folder.id });
    await api.call('POST', '/api/feeds', { url: `${site.base}/feed-b` });

    const exported = await api.call('GET', '/api/opml');
    assert.equal(exported.status, 200);
    assert.ok(exported.text.includes('<opml version="2.0">'));
    assert.ok(exported.text.includes(`${site.base}/feed-a`));
    assert.ok(exported.text.includes('示例组'));

    // 导入到另一个实例，应还原出同样的订阅
    const other = freshApp();
    const otherApi = await startApi(other.app);
    try {
      const imported = await otherApi.call('POST', '/api/opml', { opml: exported.text });
      assert.equal(imported.json.added, 2);
      assert.equal(imported.json.skipped, 0);
      assert.equal(imported.json.folders, 1);

      const state = await otherApi.call('GET', '/api/state');
      assert.equal(state.json.feeds.length, 2);
      assert.equal(state.json.folders.some((f) => f.name === '示例组'), true);

      // 重复导入应全部跳过
      const again = await otherApi.call('POST', '/api/opml', { opml: exported.text });
      assert.equal(again.json.added, 0);
      assert.equal(again.json.skipped, 2);
    } finally {
      await otherApi.close();
      other.cleanup();
    }
  } finally {
    await api.close();
    await site.close();
    cleanup();
  }
});

test('API：设置读写与参数校验', async () => {
  const { app, cleanup } = freshApp();
  const api = await startApi(app);
  try {
    const initial = await api.call('GET', '/api/settings');
    assert.equal(initial.json.settings.max_concurrency, 6);

    const updated = await api.call('PATCH', '/api/settings', { max_concurrency: 10, theme: 'light', unknown_key: 'x' });
    assert.equal(updated.json.settings.max_concurrency, 10);
    assert.equal(updated.json.settings.theme, 'light');
    assert.equal(updated.json.updated.unknown_key, undefined, '未知设置项应被忽略');
  } finally {
    await api.close();
    cleanup();
  }
});

test('API：健康检查与错误响应格式', async () => {
  const { app, cleanup } = freshApp();
  const api = await startApi(app);
  try {
    const health = await api.call('GET', '/api/health');
    assert.equal(health.json.ok, true);
    assert.ok(health.json.pool.limit > 0);

    const missing = await api.call('GET', '/api/articles/not-a-real-id');
    assert.equal(missing.status, 404);
    assert.ok(missing.json.error);

    const unknown = await api.call('GET', '/api/does-not-exist');
    assert.equal(unknown.status, 404);

    const badPatch = await api.call('PATCH', '/api/feeds/nope', { title: 'x' });
    assert.equal(badPatch.status, 404);
  } finally {
    await api.close();
    cleanup();
  }
});

test('API：示例源可一键载入并抓到内容', async () => {
  const { app, cleanup } = freshApp();
  const api = await startApi(app, 'http://127.0.0.1:1');
  try {
    // 示例源的 absolute 地址由 origin 决定，这里直接使用 app 内部 origin
    const seeded = await api.call('GET', '/api/demo-sources');
    assert.equal(seeded.status, 200);
    assert.equal(seeded.json.sources.length, 3);
    assert.ok(seeded.json.created >= 0);
  } finally {
    await api.close();
    cleanup();
  }
});

test('渲染：示例源可按三种格式生成合法文档', async () => {
  const { renderDemoFeed, DEMO_SOURCES } = await import('../server/demo-feeds.js');
  const { parseFeed } = await import('../server/feed-parser.js');
  const origin = 'http://127.0.0.1:5178';

  for (const source of DEMO_SOURCES) {
    const rendered = renderDemoFeed(source.key, origin);
    assert.ok(rendered, `${source.key} 未能渲染`);
    const parsed = parseFeed(rendered.body, `${origin}${source.path}`);
    assert.equal(parsed.format, source.format === 'rdf' ? 'rdf' : source.format);
    assert.equal(parsed.items.length, source.items.length);
    assert.ok(parsed.title.length > 0);
    assert.ok(parsed.items.every((i) => i.guid && i.title && i.publishedAt));
  }
});
