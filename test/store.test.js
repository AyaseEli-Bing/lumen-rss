/** 数据层测试：幂等入库、用户状态保护、检索与并发一致性 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../server/db.js';
import { createStore, articleId } from '../server/store.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-store-'));
  const db = createDatabase(join(dir, 'test.sqlite'));
  const store = createStore(db);
  return {
    store, db,
    cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

const item = (n, overrides = {}) => ({
  guid: `guid-${n}`,
  title: `文章 ${n}`,
  link: `https://example.com/${n}`,
  author: '作者',
  summary: `摘要 ${n}`,
  contentHtml: `<p>正文 ${n}</p>`,
  publishedAt: Date.UTC(2025, 0, 1) + n * 60000,
  ...overrides
});

test('文件夹：创建、重名拒绝、重命名、排序', () => {
  const { store, cleanup } = freshStore();
  try {
    const tech = store.createFolder('技术');
    const news = store.createFolder('资讯');
    assert.equal(store.listFolders().length, 2);
    assert.throws(() => store.createFolder('技术'), (err) => err.status === 409);

    store.renameFolder(news.id, '行业');
    assert.equal(store.getFolder(news.id).name, '行业');

    store.reorderFolders([news.id, tech.id]);
    assert.deepEqual(store.listFolders().map((f) => f.name), ['行业', '技术']);
  } finally { cleanup(); }
});

test('删除文件夹：订阅被移动到目标文件夹，不会连带删除', () => {
  const { store, cleanup } = freshStore();
  try {
    const a = store.createFolder('A');
    const b = store.createFolder('B');
    const feed = store.addFeed({ url: 'https://x.com/feed', title: 'X', folderId: a.id });

    const result = store.deleteFolder(a.id, b.id);
    assert.equal(result.movedFeeds, 1);
    assert.equal(store.getFeed(feed.id).folderId, b.id);
    assert.equal(store.listFeeds().length, 1);
  } finally { cleanup(); }
});

test('删除文件夹：不指定目标时订阅落到未分类', () => {
  const { store, cleanup } = freshStore();
  try {
    const a = store.createFolder('A');
    const feed = store.addFeed({ url: 'https://x.com/feed', folderId: a.id });
    store.deleteFolder(a.id, null);
    assert.equal(store.getFeed(feed.id).folderId, null);
  } finally { cleanup(); }
});

test('订阅源：地址唯一、更新元信息、删除级联清理文章', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed', title: 'X' });
    assert.throws(() => store.addFeed({ url: 'https://x.com/feed' }), (err) => err.status === 409);

    store.updateFeed(feed.id, { customTitle: '我的 X', intervalMin: 1440 });
    const updated = store.getFeed(feed.id);
    assert.equal(updated.title, '我的 X');
    assert.equal(updated.customTitle, '我的 X');
    assert.equal(updated.intervalMin, 1440);

    store.upsertArticles(feed.id, [item(1), item(2), item(3)]);
    assert.equal(store.stats().articles, 3);

    const result = store.removeFeed(feed.id);
    assert.equal(result.removedArticles, 3);
    assert.equal(store.stats().articles, 0);
    assert.equal(store.stats().feeds, 0);
  } finally { cleanup(); }
});

test('入库：首次插入计数准确，重复抓取不产生新行', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    const first = store.upsertArticles(feed.id, [item(1), item(2)]);
    assert.equal(first.inserted, 2);

    const second = store.upsertArticles(feed.id, [item(1), item(2)]);
    assert.equal(second.inserted, 0);
    assert.equal(store.stats().articles, 2);

    const third = store.upsertArticles(feed.id, [item(2), item(3)]);
    assert.equal(third.inserted, 1);
    assert.equal(store.stats().articles, 3);
  } finally { cleanup(); }
});

test('入库：重复抓取不会覆盖用户的已读与收藏状态', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    store.upsertArticles(feed.id, [item(1), item(2)]);
    const id = articleId(feed.id, 'guid-1');

    store.setRead(id, true);
    store.setStarred(id, true);

    // 模拟标题与正文在源站被修改后再次抓取
    store.upsertArticles(feed.id, [item(1, { title: '文章 1（已修订）', summary: '新摘要' })]);

    const after = store.getArticle(id);
    assert.equal(after.title, '文章 1（已修订）');
    assert.equal(after.summary, '新摘要');
    assert.equal(after.read, true, '已读状态被覆盖了');
    assert.equal(after.starred, true, '收藏状态被覆盖了');
  } finally { cleanup(); }
});

test('入库：正文变短时保留更完整的旧正文', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    store.upsertArticles(feed.id, [item(1, { contentHtml: `<p>${'完整正文。'.repeat(50)}</p>` })]);
    const id = articleId(feed.id, 'guid-1');

    store.upsertArticles(feed.id, [item(1, { contentHtml: '<p>摘要片段</p>' })]);
    const after = store.getArticle(id);
    assert.ok(after.contentHtml.length > 50, '较短的正文不应覆盖较完整的正文');
  } finally { cleanup(); }
});

test('入库：缺失发布时间的文章用抓取时间兜底', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    store.upsertArticles(feed.id, [item(1, { publishedAt: null })]);
    const article = store.getArticle(articleId(feed.id, 'guid-1'));
    assert.ok(article.publishedAt > Date.now() - 60_000);
  } finally { cleanup(); }
});

test('并发入库：多路同时写入同一源，不产生重复行且计数精确', async () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    const batches = Array.from({ length: 12 }, (_, i) =>
      Array.from({ length: 10 }, (_, j) => item(i * 10 + j)));

    const results = await Promise.all(batches.map((batch) =>
      Promise.resolve().then(() => store.upsertArticles(feed.id, batch))));

    const total = results.reduce((sum, r) => sum + r.inserted, 0);
    assert.equal(total, 120, '并发写入的新增计数与实际不符');
    assert.equal(store.stats().articles, 120);

    const ids = new Set();
    for (const row of store.raw.prepare('SELECT id FROM articles').all()) ids.add(row.id);
    assert.equal(ids.size, 120, '出现了重复行');
  } finally { cleanup(); }
});

test('并发入库：重叠数据批量写入后每篇只有一行', async () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    const shared = [item(1), item(2), item(3)];
    await Promise.all(Array.from({ length: 8 }, () =>
      Promise.resolve().then(() => store.upsertArticles(feed.id, shared))));
    assert.equal(store.stats().articles, 3);
  } finally { cleanup(); }
});

test('多源隔离：不同源使用相同 guid 不会互相覆盖', () => {
  const { store, cleanup } = freshStore();
  try {
    const a = store.addFeed({ url: 'https://a.com/feed' });
    const b = store.addFeed({ url: 'https://b.com/feed' });
    store.upsertArticles(a.id, [item(1, { title: '来自 A' })]);
    store.upsertArticles(b.id, [item(1, { title: '来自 B' })]);

    assert.equal(store.stats().articles, 2);
    assert.notEqual(articleId(a.id, 'guid-1'), articleId(b.id, 'guid-1'));
  } finally { cleanup(); }
});

test('检索：关键词跨标题、摘要与正文命中，多词为 AND 关系', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    store.upsertArticles(feed.id, [
      item(1, { title: 'SQLite 并发写入', summary: '事务与 WAL' }),
      item(2, { title: '前端性能', summary: '渲染优化', contentHtml: '<p>提到 SQLite 一次</p>' }),
      item(3, { title: '无关内容', summary: '别的' })
    ]);

    assert.equal(store.listArticles({ q: '并发' }).total, 1);
    assert.equal(store.listArticles({ q: 'sqlite' }).total, 2, '正文中的关键词也应命中');
    assert.equal(store.listArticles({ q: 'sqlite 渲染' }).total, 1, '多词应按 AND 组合');
    assert.equal(store.listArticles({ q: '不存在的词' }).total, 0);
  } finally { cleanup(); }
});

test('检索：LIKE 特殊字符被转义，不会变成通配', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    store.upsertArticles(feed.id, [item(1, { title: '百分比 100% 测试' }), item(2, { title: '普通文章' })]);
    assert.equal(store.listArticles({ q: '100%' }).total, 1);
    assert.equal(store.listArticles({ q: '%' }).total, 1);
  } finally { cleanup(); }
});

test('过滤与分页：已读 / 未读 / 收藏 / 时间范围', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    store.upsertArticles(feed.id, Array.from({ length: 25 }, (_, i) => item(i)));
    const all = store.listArticles({ limit: 10 });
    assert.equal(all.total, 25);
    assert.equal(all.items.length, 10);
    assert.equal(all.hasMore, true);
    assert.equal(all.unread, 25);

    // 分页不重不漏
    const page2 = store.listArticles({ limit: 10, offset: 10 });
    const ids = new Set([...all.items, ...page2.items].map((a) => a.id));
    assert.equal(ids.size, 20);

    store.setRead(articleId(feed.id, 'guid-0'), true);
    assert.equal(store.listArticles({ filter: 'unread' }).total, 24);
    assert.equal(store.listArticles({ filter: 'read' }).total, 1);

    store.setStarred(articleId(feed.id, 'guid-5'), true);
    assert.equal(store.listArticles({ filter: 'starred' }).total, 1);

    assert.equal(store.listArticles({ since: Date.UTC(2025, 0, 1) + 20 * 60000 }).total, 5);
  } finally { cleanup(); }
});

test('过滤：按文件夹与未分类范围查询', () => {
  const { store, cleanup } = freshStore();
  try {
    const folder = store.createFolder('技术');
    const inFolder = store.addFeed({ url: 'https://a.com/feed', folderId: folder.id });
    const loose = store.addFeed({ url: 'https://b.com/feed' });
    store.upsertArticles(inFolder.id, [item(1), item(2)]);
    store.upsertArticles(loose.id, [item(3)]);

    assert.equal(store.listArticles({ folderId: folder.id }).total, 2);
    assert.equal(store.listArticles({ folderId: '__uncategorized__' }).total, 1);
    assert.equal(store.listArticles({}).total, 3);
  } finally { cleanup(); }
});

test('批量已读：按源 / 按文件夹 / 按结果集', () => {
  const { store, cleanup } = freshStore();
  try {
    const folder = store.createFolder('组');
    const a = store.addFeed({ url: 'https://a.com/feed', folderId: folder.id });
    const b = store.addFeed({ url: 'https://b.com/feed', folderId: folder.id });
    const c = store.addFeed({ url: 'https://c.com/feed' });
    store.upsertArticles(a.id, [item(1), item(2)]);
    store.upsertArticles(b.id, [item(3), item(4)]);
    store.upsertArticles(c.id, [item(5)]);

    assert.equal(store.markAll({ scope: 'feed', feedId: a.id }).changed, 2);
    assert.equal(store.listArticles({ filter: 'unread' }).total, 3);

    assert.equal(store.markAll({ scope: 'folder', folderId: folder.id }).changed, 2);
    assert.equal(store.listArticles({ filter: 'unread' }).total, 1);

    assert.equal(store.markAll({ scope: 'all' }).changed, 1);
    assert.equal(store.stats().unread, 0);

    // 取消已读同样支持
    assert.equal(store.markAll({ scope: 'feed', feedId: c.id, read: false }).changed, 1);
    assert.equal(store.stats().unread, 1);
  } finally { cleanup(); }
});

test('批量已读：按当前结果集（ids）精确操作', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    store.upsertArticles(feed.id, [item(1), item(2), item(3)]);
    const ids = [articleId(feed.id, 'guid-1'), articleId(feed.id, 'guid-3')];
    assert.equal(store.markAll({ scope: 'ids', ids }).changed, 2);
    assert.equal(store.stats().unread, 1);
  } finally { cleanup(); }
});

test('抓取状态：成功清零错误计数，失败按指数放大下次抓取时间', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed', intervalMin: 30 });

    store.recordFetchFailure(feed.id, { message: '超时', intervalMin: 30, errorCount: 1 });
    let row = store.getFeedRow(feed.id);
    assert.equal(row.status, 'error');
    assert.equal(row.error_count, 1);
    assert.ok(row.next_fetch_at - Date.now() > 55 * 60000, '首次失败应退避到约 60 分钟后');

    store.recordFetchFailure(feed.id, { message: '超时', intervalMin: 30, errorCount: 2 });
    row = store.getFeedRow(feed.id);
    assert.equal(row.error_count, 2);

    store.recordFetchSuccess(feed.id, { etag: 'x', lastModified: null, intervalMin: 30, itemCount: 5 });
    row = store.getFeedRow(feed.id);
    assert.equal(row.status, 'ok');
    assert.equal(row.error_count, 0);
    assert.equal(row.last_error, null);
    assert.ok(row.next_fetch_at - Date.now() <= 31 * 60000);
  } finally { cleanup(); }
});

test('到期调度：只返回已启用且到期的源', () => {
  const { store, cleanup } = freshStore();
  try {
    const a = store.addFeed({ url: 'https://a.com/feed' });
    const b = store.addFeed({ url: 'https://b.com/feed' });
    store.updateFeed(b.id, { enabled: false });

    store.raw.prepare('UPDATE feeds SET next_fetch_at = ? WHERE id = ?').run(Date.now() - 1000, a.id);
    store.raw.prepare('UPDATE feeds SET next_fetch_at = ? WHERE id = ?').run(Date.now() - 1000, b.id);

    const due = store.dueFeeds();
    assert.deepEqual(due.map((r) => r.id), [a.id]);
  } finally { cleanup(); }
});

test('保留策略：只裁剪已读且未收藏的旧文，未读与收藏永不丢弃', () => {
  const { store, cleanup } = freshStore();
  try {
    const feed = store.addFeed({ url: 'https://x.com/feed' });
    store.upsertArticles(feed.id, Array.from({ length: 1600 }, (_, i) => item(i)));
    store.markAll({ scope: 'feed', feedId: feed.id });
    const starredId = articleId(feed.id, 'guid-0');
    store.setStarred(starredId, true);
    const unreadId = articleId(feed.id, 'guid-5');
    store.setRead(unreadId, false);

    store.upsertArticles(feed.id, [item(2000)]);
    // 保留最近 1500 篇；被保护的两篇（收藏 / 未读）即使落在窗口外也会留下，因此总数略高于 1500
    const total = store.stats().articles;
    assert.ok(total >= 1500 && total <= 1502, `保留策略失效，当前 ${total} 篇`);
    assert.ok(store.getArticle(starredId), '收藏的文章被误删');
    assert.ok(store.getArticle(unreadId), '未读的文章被误删');
    assert.equal(store.getArticle(articleId(feed.id, 'guid-700')).read, true, '窗口内的已读文章应被保留');
  } finally { cleanup(); }
});

test('快照：一次性返回文件夹、源、统计与设置', () => {
  const { store, cleanup } = freshStore();
  try {
    const folder = store.createFolder('组');
    const feed = store.addFeed({ url: 'https://x.com/feed', folderId: folder.id });
    store.upsertArticles(feed.id, [item(1)]);

    const snap = store.snapshot();
    assert.equal(snap.folders.length, 1);
    assert.equal(snap.feeds.length, 1);
    assert.equal(snap.folders[0].unread, 1);
    assert.equal(snap.stats.articles, 1);
    assert.equal(snap.feeds[0].folderId, folder.id);
  } finally { cleanup(); }
});
