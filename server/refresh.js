/**
 * 抓取编排 + 定时调度
 *
 * 稳定性要点：
 *  - 重入保护：同一个源正在抓取时，后续请求直接跳过（inFlight 集合），
 *    定时器与手动刷新同时触发也不会产生重复请求。
 *  - 失败退避：连续失败按 2^n 放大下次抓取间隔（上限 24h），不会对挂掉的源高频重试。
 *  - 条件请求：保存 ETag / Last-Modified，304 时完全跳过解析与写库。
 *  - 局部失败不影响整体：单源异常被捕获并记录，批次继续推进并汇总上报。
 *  - 并发由调度池统一限流（全局 + 单域名），不会因为源数量增长而打出请求风暴。
 */
import { createPool, hostOf } from './pool.js';
import { fetchFeedDocument, FetchError } from './http.js';
import { parseFeed } from './feed-parser.js';

const noop = () => {};

export function createRefresher({ store, settings, notify = noop, logger = console }) {
  const inFlight = new Set();
  let lastBatch = null;

  const readSettings = () => (typeof settings === 'function' ? settings() : settings);

  const pool = createPool({
    limit: readSettings().max_concurrency || 6,
    perHost: readSettings().per_host_concurrency || 2
  });

  /** 抓取单个源并落库。返回结构化结果，绝不抛出（错误以 ok:false 返回）。 */
  async function refreshFeed(feedId, { force = false, newFeed = false } = {}) {
    const row = store.getFeedRow(feedId);
    if (!row) return { feedId, ok: false, skipped: true, error: '订阅源不存在' };
    if (inFlight.has(feedId)) return { feedId, ok: false, skipped: true, reason: 'already-running' };

    inFlight.add(feedId);
    const cfg = readSettings();
    const startedAt = Date.now();
    store.markFetching(feedId);
    notify('feed:start', { feedId, title: row.custom_title || row.title || row.url });

    try {
      const result = await fetchFeedDocument(row.url, {
        timeoutMs: newFeed ? Math.min(cfg.request_timeout_ms || 20000, 12000) : (cfg.request_timeout_ms || 20000),
        maxBytes: cfg.max_response_bytes || 8 * 1024 * 1024,
        retries: newFeed ? 0 : 2,
        etag: force ? null : row.etag,
        lastModified: force ? null : row.last_modified
      });

      if (result.notModified) {
        store.recordFetchSuccess(feedId, {
          etag: result.etag,
          lastModified: result.lastModified,
          intervalMin: row.interval_min,
          itemCount: 0
        });
        notify('feed:done', { feedId, notModified: true, newCount: 0 });
        return { feedId, ok: true, notModified: true, newCount: 0, durationMs: Date.now() - startedAt };
      }

      const parsed = parseFeed(result.body, result.finalUrl || row.url);
      const { inserted } = store.upsertArticles(feedId, parsed.items, result.finalUrl || row.url);

      // 站点元信息只在抓到有效数据时更新，且永不覆盖用户自定义标题
      store.raw.prepare('UPDATE feeds SET title = ?, site_url = ?, description = ?, icon_url = ?, updated_at = ? WHERE id = ?')
        .run(
          (parsed.title || row.title || '').slice(0, 300),
          (parsed.siteUrl || row.site_url || '').slice(0, 2048),
          (parsed.description || '').slice(0, 800),
          (parsed.iconUrl || row.icon_url || '').slice(0, 2048),
          Date.now(),
          feedId
        );

      store.recordFetchSuccess(feedId, {
        etag: result.etag,
        lastModified: result.lastModified,
        intervalMin: row.interval_min,
        itemCount: inserted
      });

      notify('feed:done', { feedId, newCount: inserted, format: parsed.format });
      return {
        feedId, ok: true, notModified: false, newCount: inserted,
        itemCount: parsed.items.length, format: parsed.format, durationMs: Date.now() - startedAt
      };
    } catch (err) {
      const message = err instanceof FetchError ? err.message : (err?.message || '未知错误');
      const status = err instanceof FetchError ? err.status : null;
      store.recordFetchFailure(feedId, {
        message,
        status,
        intervalMin: row.interval_min,
        errorCount: (row.error_count || 0) + 1
      });
      logger.warn?.(`[refresh] ${row.url} 失败：${message}`);
      notify('feed:error', { feedId, message });
      return { feedId, ok: false, error: message, status, durationMs: Date.now() - startedAt };
    } finally {
      inFlight.delete(feedId);
    }
  }

  /** 批量抓取：targets 为 feed 行数组。 */
  async function refreshMany(feedRows, { force = false, label = 'batch' } = {}) {
    const rows = feedRows.filter((row) => row && row.enabled !== 0);
    if (!rows.length) {
      return { label, requested: 0, ok: 0, failed: 0, newArticles: 0, results: [] };
    }

    const startedAt = Date.now();
    notify('batch:start', { label, total: rows.length });
    logger.log?.(`[refresh] 开始抓取 ${rows.length} 个源（${label}）`);

    const results = [];
    let done = 0;
    await Promise.all(rows.map((row) => pool.run(async () => {
      const result = await refreshFeed(row.id, { force });
      results.push(result);
      done += 1;
      notify('batch:progress', { label, done, total: rows.length });
      return result;
    }, hostOf(row.url))));

    const summary = {
      label,
      requested: rows.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok && !r.skipped).length,
      skipped: results.filter((r) => r.skipped).length,
      notModified: results.filter((r) => r.notModified).length,
      newArticles: results.reduce((sum, r) => sum + (r.newCount || 0), 0),
      durationMs: Date.now() - startedAt,
      results
    };
    lastBatch = summary;
    logger.log?.(`[refresh] 完成：成功 ${summary.ok} / 失败 ${summary.failed} / 新增 ${summary.newArticles} 篇（${summary.durationMs}ms）`);
    notify('batch:done', summary);
    return summary;
  }

  /** 抓取到期（next_fetch_at <= now）的源。 */
  async function refreshDue({ limit = 24, force = false } = {}) {
    const due = store.dueFeeds(limit);
    if (!due.length) return { label: 'due', requested: 0, ok: 0, failed: 0, newArticles: 0, results: [] };
    return refreshMany(due, { force, label: 'due' });
  }

  async function refreshAll({ force = false } = {}) {
    return refreshMany(store.listFeeds().map((f) => store.getFeedRow(f.id)), { force, label: 'all' });
  }

  async function refreshFeedByIds(ids, { force = true } = {}) {
    const rows = ids.map((id) => store.getFeedRow(id)).filter(Boolean);
    return refreshMany(rows, { force, label: 'manual' });
  }

  /** 新增订阅时的首次抓取：只试一次、超时更短，失败也保留订阅并记录错误。 */
  async function initialFetch(feedId) {
    return refreshFeed(feedId, { force: true, newFeed: true });
  }

  return {
    pool,
    refreshFeed,
    refreshMany,
    refreshDue,
    refreshAll,
    refreshFeedByIds,
    initialFetch,
    get lastBatch() { return lastBatch; },
    get inFlight() { return [...inFlight]; },
    /** 等待当前所有在途抓取收敛（关停或测试用）。 */
    async settle() { await pool.drain(); }
  };
}

/** 定时调度器：按固定节拍挑选到期的源，交给抓取编排执行。 */
export function createScheduler({ refresher, tickMs = 20000, logger = console }) {
  let timer = null;
  let running = false;
  let ticks = 0;

  async function tick() {
    if (running) return; // 上一轮还没跑完就跳过，避免任务堆积
    running = true;
    try {
      ticks += 1;
      await refresher.refreshDue();
    } catch (err) {
      logger.error?.(`[scheduler] tick 异常：${err?.message || err}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick(); }, tickMs);
      timer.unref?.();
      logger.log?.(`[scheduler] 已启动，节拍 ${Math.round(tickMs / 1000)}s`);
      // 启动后稍作延迟先跑一次，把上次退出期间到期的源补上
      setTimeout(() => { tick(); }, 3000).unref?.();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    get state() { return { running: timer !== null, busy: running, ticks }; },
    tick
  };
}
