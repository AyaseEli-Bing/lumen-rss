/**
 * 领域层：文件夹 / 订阅源 / 文章
 *
 * 数据一致性约定（重要）：
 *  - 抓取只影响「抓取态字段」；read / starred / read_at / starred_at 属于用户态，
 *    upsert 语句中永不出现，因此重复抓取不会把用户已读、收藏状态冲掉。
 *  - 文章主键 = sha1(feedId + guid)，同一篇文章无论抓取多少次都只有一行（幂等）。
 *  - 所有多语句写入都在事务内完成，失败整体回滚。
 */
import { createHash, randomUUID } from 'node:crypto';
import { stripHtml } from './xml.js';

const now = () => Date.now();
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 16);

/** 限制单源保留的文章数量，只裁剪「已读且未收藏」的旧文，绝不丢用户数据。 */
const MAX_ARTICLES_PER_FEED = 1500;

export function articleId(feedId, guid) {
  return createHash('sha1').update(`${feedId}\u0000${guid}`).digest('hex').slice(0, 32);
}

function buildSearchBlob({ title, summary, author, contentHtml }) {
  // 注意：分隔符必须是普通空格。SQLite 的 LIKE 遇到内嵌 NUL 字节会停止匹配，
  // 一旦用了 \u0000 做分隔，正文部分就永远搜不到了。
  return [title, summary, author, stripHtml(contentHtml || '').slice(0, 4000)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function likePattern(term) {
  return `%${String(term).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function createStore(db) {
  const s = (sql) => db.stmt(sql);

  const Q = {
    // ---- folders ----
    foldersAll: s('SELECT * FROM folders ORDER BY sort_order ASC, name ASC'),
    folderById: s('SELECT * FROM folders WHERE id = ?'),
    folderByName: s('SELECT id FROM folders WHERE name = ? COLLATE NOCASE'),
    folderInsert: s('INSERT INTO folders(id, name, sort_order, created_at) VALUES(?, ?, ?, ?)'),
    folderRename: s('UPDATE folders SET name = ? WHERE id = ?'),
    folderCollapse: s('UPDATE folders SET collapsed = ? WHERE id = ?'),
    folderDelete: s('DELETE FROM folders WHERE id = ?'),
    folderNextOrder: s('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM folders'),
    folderReorder: s('UPDATE folders SET sort_order = ? WHERE id = ?'),

    // ---- feeds ----
    feedsAll: s('SELECT * FROM feeds ORDER BY sort_order ASC, COALESCE(custom_title, title) COLLATE NOCASE ASC'),
    feedById: s('SELECT * FROM feeds WHERE id = ?'),
    feedByUrl: s('SELECT id FROM feeds WHERE url = ?'),
    feedInsert: s(`INSERT INTO feeds
      (id, url, site_url, title, custom_title, description, icon_url, folder_id, interval_min, enabled,
       sort_order, next_fetch_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    feedUpdateMeta: s(`UPDATE feeds SET title = ?, site_url = ?, description = ?, icon_url = ?, updated_at = ?
      WHERE id = ?`),
    feedUpdateUser: s(`UPDATE feeds SET custom_title = ?, folder_id = ?, interval_min = ?, enabled = ?,
      sort_order = ?, updated_at = ? WHERE id = ?`),
    feedFetchOk: s(`UPDATE feeds SET etag = ?, last_modified = ?, last_fetched_at = ?, last_success_at = ?,
      next_fetch_at = ?, status = 'ok', error_count = 0, last_error = NULL, updated_at = ? WHERE id = ?`),
    feedFetchFail: s(`UPDATE feeds SET last_fetched_at = ?, next_fetch_at = ?, status = 'error',
      error_count = error_count + 1, last_error = ?, updated_at = ? WHERE id = ?`),
    feedFetching: s(`UPDATE feeds SET status = 'fetching', updated_at = ? WHERE id = ?`),
    feedDelete: s('DELETE FROM feeds WHERE id = ?'),
    feedReorder: s('UPDATE feeds SET sort_order = ? WHERE id = ?'),
    feedDue: s(`SELECT * FROM feeds WHERE enabled = 1 AND next_fetch_at <= ? ORDER BY next_fetch_at ASC LIMIT ?`),
    feedNextOrder: s('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM feeds'),

    // ---- articles ----
    articleById: s('SELECT * FROM articles WHERE id = ?'),
    articleCountForFeed: s('SELECT COUNT(*) AS n FROM articles WHERE feed_id = ?'),
    articleUpsert: s(`INSERT INTO articles
      (id, feed_id, guid, title, link, author, summary, content_html, search_blob,
       published_at, fetched_at, read, starred)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(id) DO UPDATE SET
        title        = excluded.title,
        link         = excluded.link,
        author       = excluded.author,
        summary      = excluded.summary,
        content_html = CASE WHEN length(excluded.content_html) >= length(articles.content_html)
                            THEN excluded.content_html ELSE articles.content_html END,
        search_blob  = excluded.search_blob,
        published_at = CASE WHEN excluded.published_at > 0 THEN excluded.published_at
                            ELSE articles.published_at END,
        fetched_at   = excluded.fetched_at`),
    articlePrune: s(`DELETE FROM articles
      WHERE feed_id = ? AND read = 1 AND starred = 0
        AND id NOT IN (SELECT id FROM articles WHERE feed_id = ? ORDER BY published_at DESC LIMIT ?)`),
    articleSetRead: s(`UPDATE articles SET read = ?, read_at = ? WHERE id = ?`),
    articleSetStar: s(`UPDATE articles SET starred = ?, starred_at = ? WHERE id = ?`),
    articlesByFeedIds: s(`SELECT * FROM articles WHERE feed_id IN (SELECT value FROM json_each(?))
      ORDER BY published_at DESC LIMIT ?`),

    // ---- stats ----
    statsTotals: s(`SELECT
        (SELECT COUNT(*) FROM feeds) AS feeds,
        (SELECT COUNT(*) FROM folders) AS folders,
        (SELECT COUNT(*) FROM articles) AS articles,
        (SELECT COUNT(*) FROM articles WHERE read = 0) AS unread,
        (SELECT COUNT(*) FROM articles WHERE starred = 1) AS starred,
        (SELECT COUNT(*) FROM articles WHERE read = 0 AND published_at >= ?) AS unread_today`),
    unreadByFeed: s(`SELECT feed_id, COUNT(*) AS n FROM articles WHERE read = 0 GROUP BY feed_id`),
    recentLog: s('SELECT * FROM refresh_log ORDER BY started_at DESC LIMIT ?'),
    logInsert: s(`INSERT INTO refresh_log(feed_id, started_at, ok, new_count, http_status, message)
      VALUES (?, ?, ?, ?, ?, ?)`),
    logPrune: s(`DELETE FROM refresh_log WHERE id NOT IN
      (SELECT id FROM refresh_log ORDER BY started_at DESC LIMIT 500)`)
  };

  const mapFeed = (row, unread = 0) => row && ({
    id: row.id,
    url: row.url,
    siteUrl: row.site_url || '',
    title: row.custom_title || row.title || row.url,
    feedTitle: row.title || '',
    customTitle: row.custom_title || '',
    description: row.description || '',
    iconUrl: row.icon_url || '',
    folderId: row.folder_id || null,
    intervalMin: row.interval_min,
    enabled: !!row.enabled,
    sortOrder: row.sort_order,
    lastFetchedAt: row.last_fetched_at || null,
    lastSuccessAt: row.last_success_at || null,
    nextFetchAt: row.next_fetch_at || null,
    status: row.status,
    errorCount: row.error_count,
    lastError: row.last_error || '',
    createdAt: row.created_at,
    unread
  });

  const mapArticle = (row, withContent = false) => row && ({
    id: row.id,
    feedId: row.feed_id,
    title: row.title || '（无标题）',
    link: row.link || '',
    author: row.author || '',
    summary: row.summary || '',
    ...(withContent ? { contentHtml: row.content_html || '' } : {}),
    hasContent: !!row.content_html,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    read: !!row.read,
    starred: !!row.starred,
    readAt: row.read_at || null,
    starredAt: row.starred_at || null
  });

  const api = {
    /** 暴露底层数据库句柄，供抓取编排等模块执行少量无法预置的语句。 */
    raw: db.raw,

    // ==================== 文件夹 ====================
    listFolders() {
      const feeds = api.listFeeds();
      const unreadByFeed = new Map();
      for (const row of Q.unreadByFeed.all()) unreadByFeed.set(row.feed_id, row.n);
      return Q.foldersAll.all().map((row) => {
        const inFolder = feeds.filter((f) => f.folderId === row.id);
        return {
          id: row.id,
          name: row.name,
          sortOrder: row.sort_order,
          collapsed: !!row.collapsed,
          createdAt: row.created_at,
          feedCount: inFolder.length,
          unread: inFolder.reduce((sum, f) => sum + (unreadByFeed.get(f.id) || 0), 0)
        };
      });
    },

    createFolder(name) {
      const clean = String(name || '').trim();
      if (!clean) throw httpError(400, '文件夹名称不能为空');
      if (clean.length > 60) throw httpError(400, '文件夹名称过长');
      if (Q.folderByName.get(clean)) throw httpError(409, `文件夹「${clean}」已存在`);
      const id = shortId();
      Q.folderInsert.run(id, clean, Q.folderNextOrder.get().n, now());
      return api.getFolder(id);
    },

    getFolder(id) {
      const row = Q.folderById.get(id);
      if (!row) return null;
      return { id: row.id, name: row.name, sortOrder: row.sort_order, collapsed: !!row.collapsed, createdAt: row.created_at };
    },

    renameFolder(id, name) {
      const clean = String(name || '').trim();
      if (!clean) throw httpError(400, '文件夹名称不能为空');
      const exists = Q.folderByName.get(clean);
      if (exists && exists.id !== id) throw httpError(409, `文件夹「${clean}」已存在`);
      if (!Q.folderById.get(id)) throw httpError(404, '文件夹不存在');
      Q.folderRename.run(clean, id);
      return api.getFolder(id);
    },

    setFolderCollapsed(id, collapsed) {
      Q.folderCollapse.run(collapsed ? 1 : 0, id);
      return api.getFolder(id);
    },

    /** 删除文件夹：把其中的源移动到目标文件夹或「未分类」，不会连带删除订阅。 */
    deleteFolder(id, moveTo = null) {
      return db.tx(() => {
        const folder = Q.folderById.get(id);
        if (!folder) throw httpError(404, '文件夹不存在');
        if (moveTo && !Q.folderById.get(moveTo)) throw httpError(404, '目标文件夹不存在');
        const affected = s('SELECT id FROM feeds WHERE folder_id = ?').all(id);
        const move = s('UPDATE feeds SET folder_id = ?, updated_at = ? WHERE folder_id = ?');
        move.run(moveTo, now(), id);
        Q.folderDelete.run(id);
        return { removed: folder.name, movedFeeds: affected.length };
      });
    },

    reorderFolders(ids) {
      return db.tx(() => {
        ids.forEach((id, index) => Q.folderReorder.run(index, id));
        return api.listFolders();
      });
    },

    // ==================== 订阅源 ====================
    listFeeds(rows = null) {
      const unreadByFeed = new Map();
      for (const row of Q.unreadByFeed.all()) unreadByFeed.set(row.feed_id, row.n);
      const source = rows || Q.feedsAll.all();
      return source.map((row) => mapFeed(row, unreadByFeed.get(row.id) || 0));
    },

    getFeed(id) {
      const row = Q.feedById.get(id);
      if (!row) return null;
      const unread = s('SELECT COUNT(*) AS n FROM articles WHERE feed_id = ? AND read = 0').get(id).n;
      return mapFeed(row, unread);
    },

    getFeedRow(id) {
      return Q.feedById.get(id) || null;
    },

    findByUrl(url) {
      const row = Q.feedByUrl.get(url);
      return row ? api.getFeed(row.id) : null;
    },

    addFeed({ url, title = '', siteUrl = '', description = '', iconUrl = '', folderId = null, intervalMin = 30, status = 'idle', lastError = '', nextFetchAt = 0 }) {
      const cleanUrl = String(url || '').trim();
      if (!cleanUrl) throw httpError(400, '订阅地址不能为空');
      const existing = Q.feedByUrl.get(cleanUrl);
      if (existing) throw httpError(409, '该订阅地址已存在');
      if (folderId && !Q.folderById.get(folderId)) throw httpError(400, '指定的文件夹不存在');

      const id = shortId();
      const ts = now();
      Q.feedInsert.run(
        id, cleanUrl, siteUrl || '', title || '', null, description || '', iconUrl || '', folderId,
        clampInterval(intervalMin), 1, Q.feedNextOrder.get().n, nextFetchAt || ts, ts, ts
      );
      if (lastError) s('UPDATE feeds SET last_error = ?, status = ? WHERE id = ?').run(lastError, status, id);
      return api.getFeed(id);
    },

    updateFeed(id, patch = {}) {
      const row = Q.feedById.get(id);
      if (!row) throw httpError(404, '订阅源不存在');
      if (patch.folderId && !Q.folderById.get(patch.folderId)) throw httpError(400, '指定的文件夹不存在');
      if (patch.url && patch.url !== row.url) {
        const dup = Q.feedByUrl.get(patch.url);
        if (dup && dup.id !== id) throw httpError(409, '该订阅地址已存在');
        s('UPDATE feeds SET url = ?, etag = NULL, last_modified = NULL, updated_at = ? WHERE id = ?')
          .run(patch.url, now(), id);
      }
      const customTitle = patch.customTitle === undefined
        ? row.custom_title
        : (String(patch.customTitle || '').trim() || null);
      const folderId = patch.folderId === undefined ? row.folder_id : (patch.folderId || null);
      const interval = patch.intervalMin === undefined ? row.interval_min : clampInterval(patch.intervalMin);
      const enabled = patch.enabled === undefined ? row.enabled : (patch.enabled ? 1 : 0);

      Q.feedUpdateUser.run(customTitle, folderId, interval, enabled, row.sort_order, now(), id);
      // 间隔或启用状态变化后，立即重算下次抓取时间
      s('UPDATE feeds SET next_fetch_at = ? WHERE id = ?').run(enabled ? now() + interval * 60000 : 0, id);
      return api.getFeed(id);
    },

    removeFeed(id) {
      return db.tx(() => {
        const row = Q.feedById.get(id);
        if (!row) throw httpError(404, '订阅源不存在');
        const removed = Q.articleCountForFeed.get(id).n;
        Q.feedDelete.run(id); // 外键 ON DELETE CASCADE 会一并清理文章
        return { removedArticles: removed };
      });
    },

    markFetching(id) {
      Q.feedFetching.run(now(), id);
    },

    recordFetchSuccess(id, { etag, lastModified, intervalMin, itemCount }) {
      const ts = now();
      Q.feedFetchOk.run(etag || null, lastModified || null, ts, ts, ts + clampInterval(intervalMin) * 60000, ts, id);
      Q.logInsert.run(id, ts, 1, itemCount, 200, null);
      Q.logPrune.run();
    },

    recordFetchFailure(id, { message, status = null, intervalMin, errorCount }) {
      const ts = now();
      // 指数退避：间隔 × 2^n，封顶 24 小时。成功时 error_count 归零，不会把偶发抖动永久打进慢速通道。
      const delayMinutes = Math.min(clampInterval(intervalMin) * 2 ** Math.min(errorCount, 20), 24 * 60);
      Q.feedFetchFail.run(ts, ts + delayMinutes * 60000, String(message).slice(0, 500), ts, id);
      Q.logInsert.run(id, ts, 0, 0, status, String(message).slice(0, 500));
      Q.logPrune.run();
    },

    dueFeeds(limit = 50) {
      return Q.feedDue.all(now(), limit);
    },

    reorderFeeds(ids) {
      return db.tx(() => {
        ids.forEach((id, index) => Q.feedReorder.run(index, id));
        return api.listFeeds();
      });
    },

    /**
     * 幂等写入抓取结果：返回真正新增（首次插入）的条数。
     * 通过事务内前后计数差值精确统计，避免 upsert 无法区分插入/更新。
     */
    upsertArticles(feedId, items, feedUrl = '') {
      if (!items?.length) return { inserted: 0, total: items?.length || 0 };
      return db.tx(() => {
        const before = Q.articleCountForFeed.get(feedId).n;
        const fetchedAt = now();
        for (const item of items) {
          const guid = String(item.guid || item.link || `${item.title}|${item.publishedAt || ''}`).slice(0, 512);
          const id = articleId(feedId, guid);
          const contentHtml = String(item.contentHtml || '').slice(0, 400_000);
          Q.articleUpsert.run(
            id,
            feedId,
            guid,
            String(item.title || '（无标题）').slice(0, 500),
            item.link ? String(item.link).slice(0, 2048) : null,
            item.author ? String(item.author).slice(0, 200) : null,
            item.summary ? String(item.summary).slice(0, 4000) : null,
            contentHtml || null,
            buildSearchBlob({ ...item, contentHtml }).slice(0, 20000),
            item.publishedAt && item.publishedAt > 0 ? item.publishedAt : fetchedAt,
            fetchedAt
          );
        }
        Q.articlePrune.run(feedId, feedId, MAX_ARTICLES_PER_FEED);
        const after = Q.articleCountForFeed.get(feedId).n;
        return { inserted: Math.max(0, after - before), total: items.length };
      });
    },

    // ==================== 文章 ====================
    getArticle(id, withContent = true) {
      const row = Q.articleById.get(id);
      return row ? mapArticle(row, withContent) : null;
    },

    listArticles(options = {}) {
      const {
        folderId = null, feedId = null, filter = 'all', q = '',
        limit = 40, offset = 0, since = null, sort = 'published'
      } = options;

      const where = [];
      const params = [];

      if (feedId) { where.push('a.feed_id = ?'); params.push(feedId); }
      else if (folderId === '__uncategorized__') {
        where.push('a.feed_id IN (SELECT id FROM feeds WHERE folder_id IS NULL)');
      } else if (folderId) {
        where.push('a.feed_id IN (SELECT id FROM feeds WHERE folder_id = ?)');
        params.push(folderId);
      }

      if (filter === 'unread') where.push('a.read = 0');
      else if (filter === 'starred') where.push('a.starred = 1');
      else if (filter === 'read') where.push('a.read = 1');

      if (since) { where.push('a.published_at >= ?'); params.push(since); }

      const terms = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      for (const term of terms) {
        where.push("a.search_blob LIKE ? ESCAPE '\\'");
        params.push(likePattern(term));
      }

      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const order = sort === 'received' ? 'a.fetched_at DESC, a.published_at DESC' : 'a.published_at DESC, a.id DESC';
      const safeLimit = Math.min(Math.max(1, Number(limit) || 40), 200);
      const safeOffset = Math.max(0, Number(offset) || 0);

      const total = s(`SELECT COUNT(*) AS n FROM articles a ${clause}`).get(...params).n;
      const rows = s(`SELECT a.* FROM articles a ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...params, safeLimit, safeOffset);

      const unreadInQuery = s(`SELECT COUNT(*) AS n FROM articles a ${clause ? `${clause} AND` : 'WHERE'} a.read = 0`)
        .get(...params).n;

      return {
        items: rows.map((row) => mapArticle(row, false)),
        total,
        unread: unreadInQuery,
        limit: safeLimit,
        offset: safeOffset,
        hasMore: safeOffset + rows.length < total
      };
    },

    setRead(id, read) {
      const row = Q.articleById.get(id);
      if (!row) throw httpError(404, '文章不存在');
      Q.articleSetRead.run(read ? 1 : 0, read ? now() : null, id);
      return mapArticle(Q.articleById.get(id), true);
    },

    setStarred(id, starred) {
      const row = Q.articleById.get(id);
      if (!row) throw httpError(404, '文章不存在');
      Q.articleSetStar.run(starred ? 1 : 0, starred ? now() : null, id);
      return mapArticle(Q.articleById.get(id), true);
    },

    /** 批量标记已读/未读；scope 支持 ids / feed / folder / all，可叠加 filter。 */
    markAll({ scope = 'all', ids = null, feedId = null, folderId = null, filter = 'all', read = true, before = null } = {}) {
      const where = [];
      const params = [];

      if (scope === 'ids') {
        const list = (ids || []).filter(Boolean).slice(0, 2000);
        if (!list.length) return { changed: 0 };
        where.push(`id IN (SELECT value FROM json_each(?))`);
        params.push(JSON.stringify(list));
      } else {
        if (scope === 'feed') {
          if (!feedId) throw httpError(400, '缺少 feedId');
          where.push('feed_id = ?');
          params.push(feedId);
        } else if (scope === 'folder') {
          if (folderId === '__uncategorized__') where.push('feed_id IN (SELECT id FROM feeds WHERE folder_id IS NULL)');
          else if (folderId) { where.push('feed_id IN (SELECT id FROM feeds WHERE folder_id = ?)'); params.push(folderId); }
        }
        if (filter === 'unread') where.push('read = 0');
        else if (filter === 'starred') where.push('starred = 1');
        if (before) { where.push('published_at < ?'); params.push(before); }
      }

      // 只对「状态确实需要变化」的行计数，避免把已经是已读的文章也算进本次变更，
      // 这样界面上提示的「已标记 N 篇」与用户预期一致。
      where.push('read <> ?');
      params.push(read ? 1 : 0);

      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const result = s(`UPDATE articles SET read = ?, read_at = ? ${clause}`)
        .run(read ? 1 : 0, read ? now() : null, ...params);
      return { changed: Number(result.changes || 0) };
    },

    stats() {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const row = Q.statsTotals.get(startOfToday.getTime());
      return {
        feeds: row.feeds,
        folders: row.folders,
        articles: row.articles,
        unread: row.unread,
        starred: row.starred,
        unreadToday: row.unread_today
      };
    },

    recentLog(limit = 30) {
      return Q.recentLog.all(Math.min(Number(limit) || 30, 200)).map((row) => ({
        id: row.id,
        feedId: row.feed_id,
        startedAt: row.started_at,
        ok: !!row.ok,
        newCount: row.new_count,
        httpStatus: row.http_status,
        message: row.message || ''
      }));
    },

    /** 一次性取回全量快照，供前端首屏渲染（避免多次往返导致的状态撕裂）。 */
    snapshot({ includeArticles = false } = {}) {
      const folders = api.listFolders();
      const feeds = api.listFeeds();
      return {
        folders,
        feeds,
        stats: api.stats(),
        settings: db.allSettings(),
        ...(includeArticles ? { articles: api.listArticles({ limit: 40 }) } : {})
      };
    }
  };

  return api;
}

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(24 * 60, Math.max(5, Math.round(n)));
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
