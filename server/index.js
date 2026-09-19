/**
 * Lumen RSS 服务端
 *
 * 一个进程同时承担三件事：静态资源服务、REST API、后台抓取调度。
 * 只监听回环地址（127.0.0.1），数据全部保存在本机 SQLite 文件里，不依赖任何外部服务。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';
import { createStore } from './store.js';
import { createRefresher, createScheduler } from './refresh.js';
import { resolveFeedUrl, buildOpml, parseOpml } from './discover.js';
import { DEMO_SOURCES, renderDemoFeed, seedDemoSubscriptions } from './demo-feeds.js';
import { FetchError } from './http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(PROJECT_ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8'
};

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { port: Number(process.env.PORT) || 5178, host: '127.0.0.1', dataDir: join(PROJECT_ROOT, 'data'), seed: true, open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') args.port = Number(argv[++i]) || args.port;
    else if (arg === '--host') args.host = argv[++i] || args.host;
    else if (arg === '--data-dir') args.dataDir = resolve(argv[++i] || args.dataDir);
    else if (arg === '--no-seed') args.seed = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

export function createApp({ dataDir, seed = true, logger = console } = {}) {
  const db = createDatabase(join(dataDir, 'lumen.sqlite'));
  const store = createStore(db);
  const clients = new Set();

  const notify = (type, payload = {}) => {
    if (clients.size === 0) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try { client.write(frame); } catch { clients.delete(client); }
    }
  };

  const settings = () => db.allSettings();
  const refresher = createRefresher({ store, settings, notify, logger });
  const scheduler = createScheduler({ refresher, logger });

  return { db, store, refresher, scheduler, notify, clients, settings, logger };
}

// ---------------------------------------------------------------------------
// 请求辅助
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err?.status || (err instanceof FetchError ? 422 : 500);
  const payload = { error: err?.message || '服务器内部错误', code: err?.code || null };
  if (status >= 500) payload.detail = String(err?.stack || '').split('\n').slice(0, 3).join('\n');
  sendJson(res, status, payload);
}

async function readJson(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('请求体过大');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    throw err;
  }
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: '禁止访问' });
    return true;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    const data = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': extname(target) === '.html' ? 'no-cache' : 'public, max-age=60'
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function createRequestHandler(app, { origin = '' } = {}) {
  const { store, db, refresher, scheduler, notify } = app;

  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---------------- 快照与事件 ----------------
  on('GET', /^\/api\/snapshot$/, async (req, res) => {
    sendJson(res, 200, {
      ...store.snapshot(),
      scheduler: scheduler.state,
      refresh: {
        inFlight: refresher.inFlight.length,
        lastBatch: refresher.lastBatch ? summarizeBatch(refresher.lastBatch) : null,
        pool: refresher.pool.stats
      },
      serverTime: Date.now()
    });
  });

  on('GET', /^\/api\/state$/, async (req, res) => {
    sendJson(res, 200, { ...store.snapshot(), scheduler: scheduler.state, serverTime: Date.now() });
  });

  on('GET', /^\/api\/events$/, async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`retry: 3000\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`);
    app.clients.add(res);

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* 连接已断开 */ }
    }, 25000);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      app.clients.delete(res);
    });
  });

  on('GET', /^\/api\/health$/, async (req, res) => {
    sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      scheduler: scheduler.state,
      pool: refresher.pool.stats,
      inFlight: refresher.inFlight,
      sseClients: app.clients.size,
      stats: store.stats()
    });
  });

  // ---------------- 文件夹 ----------------
  on('GET', /^\/api\/folders$/, async (req, res) => sendJson(res, 200, { folders: store.listFolders() }));

  on('POST', /^\/api\/folders$/, async (req, res) => {
    const body = await readJson(req);
    const folder = store.createFolder(body.name);
    notify('folders:changed', { action: 'create', folderId: folder.id });
    sendJson(res, 201, { folder });
  });

  on('POST', /^\/api\/folders\/reorder$/, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 200, { folders: store.reorderFolders(body.ids || []) });
  });

  on('PATCH', /^\/api\/folders\/([^/]+)$/, async (req, res, params) => {
    const body = await readJson(req);
    const id = params[0];
    if (body.collapsed !== undefined) store.setFolderCollapsed(id, body.collapsed);
    const folder = body.name !== undefined ? store.renameFolder(id, body.name) : store.getFolder(id);
    if (!folder) { sendJson(res, 404, { error: '文件夹不存在' }); return; }
    notify('folders:changed', { action: 'update', folderId: id });
    sendJson(res, 200, { folder });
  });

  on('DELETE', /^\/api\/folders\/([^/]+)$/, async (req, res, params) => {
    const url = new URL(req.url, 'http://localhost');
    const result = store.deleteFolder(params[0], url.searchParams.get('moveTo') || null);
    notify('folders:changed', { action: 'delete' });
    sendJson(res, 200, result);
  });

  // ---------------- 订阅源 ----------------
  on('GET', /^\/api\/feeds$/, async (req, res) => sendJson(res, 200, { feeds: store.listFeeds() }));

  on('POST', /^\/api\/feeds$/, async (req, res) => {
    const body = await readJson(req);
    const cfg = app.settings();

    if (body.url && store.findByUrl(String(body.url).trim())) {
      sendJson(res, 409, { error: '该订阅地址已存在' });
      return;
    }

    let resolved = null;
    let warning = null;
    try {
      resolved = await resolveFeedUrl(body.url, { timeoutMs: Math.min(cfg.request_timeout_ms || 20000, 15000) });
    } catch (err) {
      if (!body.force) throw err;
      warning = err.message;
    }

    const folderId = body.folderId || null;
    const feed = store.addFeed({
      url: resolved?.feedUrl || String(body.url).trim(),
      title: resolved?.parsed?.title || body.title || String(body.url).trim(),
      siteUrl: resolved?.parsed?.siteUrl || '',
      description: resolved?.parsed?.description || '',
      iconUrl: resolved?.parsed?.iconUrl || '',
      folderId,
      intervalMin: body.intervalMin || cfg.global_refresh_min || 30
    });

    let inserted = 0;
    if (resolved) {
      const result = store.upsertArticles(feed.id, resolved.parsed.items, feed.url);
      inserted = result.inserted;
      store.recordFetchSuccess(feed.id, {
        etag: resolved.etag,
        lastModified: resolved.lastModified,
        intervalMin: feed.intervalMin,
        itemCount: inserted
      });
    } else {
      store.recordFetchFailure(feed.id, {
        message: warning || '首次抓取失败',
        intervalMin: feed.intervalMin,
        errorCount: 1
      });
    }

    notify('feeds:changed', { action: 'create', feedId: feed.id, newCount: inserted });
    sendJson(res, 201, {
      feed: store.getFeed(feed.id),
      newCount: inserted,
      discovered: resolved?.discovered || false,
      format: resolved?.parsed?.format || null,
      warning
    });
  });

  on('POST', /^\/api\/feeds\/discover$/, async (req, res) => {
    const body = await readJson(req);
    const cfg = app.settings();
    const resolved = await resolveFeedUrl(body.url, { timeoutMs: Math.min(cfg.request_timeout_ms || 20000, 15000) });
    sendJson(res, 200, {
      feedUrl: resolved.feedUrl,
      discovered: resolved.discovered,
      title: resolved.parsed.title,
      siteUrl: resolved.parsed.siteUrl,
      format: resolved.parsed.format,
      itemCount: resolved.parsed.items.length
    });
  });

  on('PATCH', /^\/api\/feeds\/([^/]+)$/, async (req, res, params) => {
    const body = await readJson(req);
    const feed = store.updateFeed(params[0], body);
    notify('feeds:changed', { action: 'update', feedId: feed.id });
    sendJson(res, 200, { feed });
  });

  on('DELETE', /^\/api\/feeds\/([^/]+)$/, async (req, res, params) => {
    const result = store.removeFeed(params[0]);
    notify('feeds:changed', { action: 'delete', feedId: params[0] });
    sendJson(res, 200, result);
  });

  on('POST', /^\/api\/feeds\/reorder$/, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 200, { feeds: store.reorderFeeds(body.ids || []) });
  });

  on('POST', /^\/api\/feeds\/([^/]+)\/refresh$/, async (req, res, params) => {
    const feed = store.getFeedRow(params[0]);
    if (!feed) { sendJson(res, 404, { error: '订阅源不存在' }); return; }
    const summary = await refresher.refreshFeedByIds([params[0]], { force: true });
    sendJson(res, 200, {
      summary: summarizeBatch(summary),
      // 单源刷新时把这一条的具体结果一并返回，前端据此给出「新增 N 篇 / 无变化 / 失败原因」
      result: summary.results?.[0] || null,
      feed: store.getFeed(params[0])
    });
  });

  // ---------------- 抓取触发 ----------------
  on('POST', /^\/api\/refresh$/, async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const target = body.target || 'due';
    const force = !!body.force;

    // 立即返回，抓取在后台推进，进度通过 SSE 推送（避免长连接超时）
    const job = (async () => {
      try {
        if (target === 'all') await refresher.refreshAll({ force });
        else if (target === 'feed' && body.feedId) await refresher.refreshFeedByIds([body.feedId], { force: true });
        else if (target === 'folder' && body.folderId) {
          const ids = store.listFeeds().filter((f) => f.folderId === body.folderId).map((f) => f.id);
          await refresher.refreshFeedByIds(ids, { force: true });
        } else await refresher.refreshDue();
      } catch (err) {
        app.logger.error?.(`[refresh] 后台任务异常：${err?.message || err}`);
      }
    })();

    sendJson(res, 202, { accepted: true, target, force, queued: job ? 1 : 0 });
  });

  // ---------------- 文章 ----------------
  on('GET', /^\/api\/articles$/, async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.searchParams;
    const result = store.listArticles({
      folderId: p.get('folderId'),
      feedId: p.get('feedId'),
      filter: p.get('filter') || 'all',
      q: p.get('q') || '',
      limit: p.get('limit') || 40,
      offset: p.get('offset') || 0,
      since: p.get('since') ? Number(p.get('since')) : null,
      sort: p.get('sort') || 'published'
    });
    sendJson(res, 200, result);
  });

  on('GET', /^\/api\/articles\/([^/]+)$/, async (req, res, params) => {
    const article = store.getArticle(params[0], true);
    if (!article) { sendJson(res, 404, { error: '文章不存在' }); return; }
    const feed = store.getFeed(article.feedId);
    sendJson(res, 200, { article, feed: feed ? { id: feed.id, title: feed.title, siteUrl: feed.siteUrl } : null });
  });

  on('PATCH', /^\/api\/articles\/([^/]+)$/, async (req, res, params) => {
    const body = await readJson(req);
    let article = null;
    if (body.read !== undefined) article = store.setRead(params[0], !!body.read);
    if (body.starred !== undefined) article = store.setStarred(params[0], !!body.starred);
    if (!article) { sendJson(res, 400, { error: '未提供 read 或 starred 字段' }); return; }
    notify('articles:changed', { action: 'update', ids: [params[0]] });
    sendJson(res, 200, { article });
  });

  on('POST', /^\/api\/articles\/mark-all$/, async (req, res) => {
    const body = await readJson(req);
    const result = store.markAll(body);
    notify('articles:changed', { action: 'mark-all', changed: result.changed });
    sendJson(res, 200, result);
  });

  // ---------------- 设置 ----------------
  on('GET', /^\/api\/settings$/, async (req, res) => sendJson(res, 200, { settings: db.allSettings() }));

  on('PATCH', /^\/api\/settings$/, async (req, res) => {
    const body = await readJson(req);
    const allowed = ['global_refresh_min', 'max_concurrency', 'per_host_concurrency', 'request_timeout_ms',
      'max_response_bytes', 'mark_read_on_open', 'show_full_content', 'theme'];
    const updated = {};
    for (const key of allowed) {
      if (body[key] !== undefined) updated[key] = db.setSetting(key, body[key]);
    }
    notify('settings:changed', updated);
    sendJson(res, 200, { settings: db.allSettings(), updated });
  });

  on('GET', /^\/api\/log$/, async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    sendJson(res, 200, { log: store.recentLog(url.searchParams.get('limit') || 30) });
  });

  // ---------------- OPML ----------------
  on('GET', /^\/api\/opml$/, async (req, res) => {
    const body = buildOpml(store.listFolders(), store.listFeeds());
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="lumen-subscriptions-${new Date().toISOString().slice(0, 10)}.opml"`,
      'Cache-Control': 'no-store'
    });
    res.end(body);
  });

  on('POST', /^\/api\/opml$/, async (req, res) => {
    const body = await readJson(req, 2 * 1024 * 1024);
    const xmlText = body.opml || '';
    if (!xmlText.trim()) { sendJson(res, 400, { error: '缺少 OPML 内容' }); return; }
    const parsed = parseOpml(xmlText);

    const result = { added: 0, skipped: 0, failed: 0, folders: 0, details: [] };
    for (const group of parsed.folders) {
      let folderId = null;
      if (group.name) {
        const existing = store.listFolders().find((f) => f.name === group.name);
        folderId = existing ? existing.id : store.createFolder(group.name).id;
        if (!existing) result.folders += 1;
      }
      for (const item of group.feeds) {
        try {
          if (store.findByUrl(item.xmlUrl)) { result.skipped += 1; continue; }
          const feed = store.addFeed({
            url: item.xmlUrl,
            title: item.title || item.xmlUrl,
            siteUrl: item.htmlUrl || '',
            folderId,
            intervalMin: app.settings().global_refresh_min || 30,
            status: 'idle'
          });
          result.added += 1;
          result.details.push({ id: feed.id, title: feed.title, url: feed.url });
        } catch (err) {
          result.failed += 1;
          result.details.push({ url: item.xmlUrl, error: err?.message || '导入失败' });
        }
      }
    }
    notify('feeds:changed', { action: 'import', count: result.added });
    // 导入后异步补抓，不阻塞响应
    if (result.details.some((d) => d.id)) {
      const ids = result.details.filter((d) => d.id).map((d) => d.id);
      setTimeout(() => refresher.refreshFeedByIds(ids, { force: true }).catch(() => {}), 50).unref?.();
    }
    sendJson(res, 200, result);
  });

  // ---------------- 示例源 ----------------
  on('GET', /^\/api\/demo-sources$/, async (req, res) => {
    const seen = seedDemoSubscriptions(store, origin, app.logger);
    sendJson(res, 200, { sources: DEMO_SOURCES.map((s) => ({ key: s.key, title: s.title, url: `${origin}${s.path}` })), ...seen });
  });

  // ---------------- 主处理 ----------------
  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // 示例订阅源（模拟外部站点，走完整的网络抓取链路）
    const demoMatch = /^\/demo\/([a-z]+)\.(xml|atom|rdf)$/.exec(pathname);
    if (demoMatch) {
      const rendered = renderDemoFeed(demoMatch[1], origin);
      if (!rendered) { sendJson(res, 404, { error: '示例源不存在' }); return; }
      res.writeHead(200, {
        'Content-Type': rendered.contentType,
        'Cache-Control': 'no-store'
      });
      res.end(rendered.body);
      return;
    }
    // 示例源对应的「原站」页面：用于演示自动发现订阅地址
    if (/^\/demo\/[a-z]+-site\.html$/.test(pathname)) {
      const key = pathname.slice(6, -9);
      const source = DEMO_SOURCES.find((s) => s.key === key);
      if (!source) { sendJson(res, 404, { error: '页面不存在' }); return; }
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${source.title}</title>
<link rel="alternate" type="application/rss+xml" title="${source.title}" href="${source.path}">
</head><body><h1>${source.title}</h1><p>${source.description}</p>
<p>这是一个用于演示「订阅地址自动发现」的页面。</p></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (pathname.startsWith('/api/')) {
      const path = pathname.replace(/\/+$/, '') || '/api';
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = route.pattern.exec(path);
        if (!match) continue;
        try {
          await route.handler(req, res, match.slice(1));
        } catch (err) {
          if (!res.headersSent) sendError(res, err);
          else res.end();
          if (!err?.status || err.status >= 500) {
            app.logger.error?.(`[api] ${req.method} ${pathname} → ${err?.message || err}`);
          }
        }
        return;
      }
      sendJson(res, 404, { error: `接口不存在：${req.method} ${pathname}` });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: '方法不允许' });
      return;
    }

    if (await serveStatic(res, pathname)) return;
    if (!extname(pathname) && await serveStatic(res, '/index.html')) return;
    sendJson(res, 404, { error: '资源不存在' });
  };
}

function summarizeBatch(summary) {
  if (!summary) return null;
  return {
    label: summary.label,
    requested: summary.requested,
    ok: summary.ok,
    failed: summary.failed,
    skipped: summary.skipped,
    notModified: summary.notModified,
    newArticles: summary.newArticles,
    durationMs: summary.durationMs
  };
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

export async function startServer(args = parseArgs()) {
  const app = createApp({ dataDir: args.dataDir, logger: console });
  const server = createServer();

  let origin = `http://127.0.0.1:${args.port}`;
  const handler = createRequestHandler(app, { get origin() { return origin; } });
  // handler 读取的是 origin 变量本体，这里用闭包代理保证端口确定后仍然正确
  const boundHandler = (req, res) => {
    req.__origin = origin;
    return handler(req, res);
  };
  server.on('request', boundHandler);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, args.host, resolve);
  });

  const address = server.address();
  origin = `http://${args.host === '0.0.0.0' ? '127.0.0.1' : args.host}:${address.port}`;

  if (args.seed) {
    const result = seedDemoSubscriptions(app.store, origin, console);
    if (result.created > 0) console.log(`[seed] 已创建 ${result.created} 个示例订阅源`);
  }

  app.scheduler.start();

  console.log('');
  console.log('  \u001b[1mLumen RSS\u001b[0m 已启动');
  console.log(`  → 阅读器界面   ${origin}`);
  console.log(`  → 数据文件     ${join(args.dataDir, 'lumen.sqlite')}`);
  console.log(`  → 订阅源数量   ${app.store.stats().feeds}`);
  console.log('');

  const shutdown = async (signal) => {
    console.log(`\n[server] 收到 ${signal}，正在停止调度与在途抓取…`);
    app.scheduler.stop();
    try { await Promise.race([app.refresher.settle(), new Promise((r) => setTimeout(r, 5000))]); } catch { /* 忽略 */ }
    app.db.checkpoint();
    app.db.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, app, origin };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs();
  if (args.help) {
    console.log('用法：node server/index.js [--port 5178] [--host 127.0.0.1] [--data-dir ./data] [--no-seed]');
    process.exit(0);
  }
  startServer(args).catch((err) => {
    console.error('启动失败：', err);
    process.exit(1);
  });
}
