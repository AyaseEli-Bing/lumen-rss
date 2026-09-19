/**
 * Lumen RSS 前端应用
 *
 * 状态模型：单一 state 对象 + 显式 render 函数，没有虚拟 DOM，也不做隐式同步。
 * 所有服务端推送（SSE）都被合并进一条「状态已变脏」的通道，批量结束后统一重绘，
 * 避免多个源同时抓取完成时反复重排列表导致滚动位置丢失。
 */
import { api, connectEvents, ApiError } from './api.js';
import { sanitizeHtml, textToParagraphs } from './sanitize.js';
import {
  escapeHtml, relativeTime, formatDateTime, debounce, highlight,
  clampText, initialOf, friendlyHost
} from './util.js';

// ===========================================================================
// DOM
// ===========================================================================
const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  sidebar: $('sidebar'),
  sidebarScroll: $('sidebar-scroll'),
  listPane: $('list-pane'),
  articleScroll: $('article-scroll'),
  articleList: $('article-list'),
  listFooter: $('list-footer'),
  viewTitle: $('view-title'),
  viewSub: $('view-sub'),
  searchInput: $('search-input'),
  searchClear: $('search-clear'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  readerPane: $('reader-pane'),
  readerEmpty: $('reader-empty'),
  reader: $('reader'),
  readerSource: $('reader-source'),
  readerTime: $('reader-time'),
  readerAuthor: $('reader-author'),
  readerAuthorWrap: $('reader-author-wrap'),
  readerTitle: $('reader-title'),
  readerBody: $('reader-body'),
  btnStar: $('btn-star'),
  btnToggleRead: $('btn-toggle-read'),
  btnOriginal: $('btn-original'),
  overlay: $('overlay'),
  modalTitle: $('modal-title'),
  modalBody: $('modal-body'),
  modalFoot: $('modal-foot'),
  toasts: $('toasts'),
  scrim: $('scrim')
};

const SMART_VIEWS = {
  all: { label: '全部文章', filter: 'all' },
  unread: { label: '未读', filter: 'unread' },
  starred: { label: '收藏', filter: 'starred' }
};

const PAGE_SIZE = 40;
const FONT_RANGE = [15, 24];

// ===========================================================================
// State
// ===========================================================================
const state = {
  folders: [],
  feeds: [],
  stats: {},
  settings: {},
  view: { kind: 'smart', key: 'all' },
  filter: 'all',
  query: '',
  sort: 'published',
  articles: [],
  total: 0,
  unreadInView: 0,
  hasMore: false,
  loading: false,
  selectedId: null,
  reader: null,
  readerFeed: null,
  refreshing: false,
  dirty: false
};

const feedMap = () => new Map(state.feeds.map((f) => [f.id, f]));

const prefs = {
  read(key, fallback) {
    try {
      const value = localStorage.getItem(`lumen.${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(`lumen.${key}`, JSON.stringify(value)); } catch { /* 隐私模式下忽略 */ }
  }
};

// ===========================================================================
// 提示
// ===========================================================================
function toast(message, kind = 'info', duration = 3200) {
  const icon = kind === 'error' ? 'i-close' : kind === 'ok' ? 'i-check' : 'i-rss';
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg><span>${escapeHtml(message)}</span>`;
  els.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  }, duration);
}

function reportError(err, context = '') {
  const message = err instanceof ApiError ? err.message : (err?.message || '未知错误');
  toast(context ? `${context}：${message}` : message, 'error', 5000);
  if (!(err instanceof ApiError)) console.error(err);
}

// ===========================================================================
// 弹窗
// ===========================================================================
let modalCleanup = null;

function openModal({ title, body = '', footer = '', onMount = null, width = null }) {
  closeModal();
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = body;
  els.modalFoot.innerHTML = footer;
  els.overlay.hidden = false;
  els.overlay.querySelector('.modal').style.width = width ? `${width}px` : '';

  const firstInput = els.modalBody.querySelector('input, select, textarea');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);

  modalCleanup = onMount ? (onMount(els.modalBody, els.modalFoot) || null) : null;
}

function closeModal() {
  if (els.overlay.hidden) return;
  els.overlay.hidden = true;
  els.modalBody.innerHTML = '';
  els.modalFoot.innerHTML = '';
  if (typeof modalCleanup === 'function') modalCleanup();
  modalCleanup = null;
}

function confirmDialog({ title, message, confirmText = '确认', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p style="margin:0;font-size:13.5px;line-height:1.7;color:var(--text-dim)">${escapeHtml(message)}</p>`,
      footer: `
        <button class="btn ghost" data-act="cancel">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${escapeHtml(confirmText)}</button>`,
      onMount(body, foot) {
        const done = (value) => { closeModal(); resolve(value); };
        foot.querySelector('[data-act="cancel"]').onclick = () => done(false);
        foot.querySelector('[data-act="ok"]').onclick = () => done(true);
      }
    });
  });
}

// ===========================================================================
// 侧栏
// ===========================================================================
function feedIconHtml(feed) {
  const letter = initialOf(feed.title);
  // 优先使用源自己声明的图标（本地缓存地址，不外链第三方图标服务，避免泄露订阅清单）
  if (feed.iconUrl) {
    return `<span class="feed-favicon"><img src="${escapeHtml(feed.iconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"
      onerror="this.replaceWith(document.createTextNode(this.dataset.fallback))" data-fallback="${escapeHtml(letter)}"></span>`;
  }
  return `<span class="feed-favicon">${escapeHtml(letter)}</span>`;
}

function isViewActive(kind, id) {
  if (state.view.kind !== kind) return false;
  if (kind === 'smart') return state.view.key === id;
  return state.view.id === id;
}

function renderSidebar() {
  const map = feedMap();
  const uncategorized = state.feeds.filter((f) => !f.folderId);
  const parts = [];

  parts.push('<div class="side-group">');
  for (const [key, def] of Object.entries(SMART_VIEWS)) {
    const count = key === 'all' ? state.stats.articles : key === 'unread' ? state.stats.unread : state.stats.starred;
    parts.push(`
      <div class="side-item ${isViewActive('smart', key) ? 'active' : ''}" data-nav="smart" data-key="${key}" title="${escapeHtml(def.label)}">
        <svg class="ic"><use href="#${key === 'all' ? 'i-list' : key === 'unread' ? 'i-dot' : 'i-star'}"/></svg>
        <span class="side-name">${escapeHtml(def.label)}</span>
        <span class="side-count">${count || 0}</span>
      </div>`);
  }
  parts.push('</div>');

  const folders = [...state.folders].sort((a, b) => a.sortOrder - b.sortOrder);
  if (folders.length || state.feeds.length) {
    parts.push('<div class="side-group"><div class="side-label">订阅源</div>');
    for (const folder of folders) {
      const children = state.feeds.filter((f) => f.folderId === folder.id).sort((a, b) => a.sortOrder - b.sortOrder);
      const collapsed = folder.collapsed;
      parts.push(`
        <div class="side-item folder-head ${collapsed ? 'collapsed' : ''} ${isViewActive('folder', folder.id) ? 'active' : ''}"
             data-nav="folder" data-id="${folder.id}" data-drop="folder" title="文件夹：${escapeHtml(folder.name)}">
          <svg class="ic chev"><use href="#i-chevron"/></svg>
          <svg class="ic"><use href="#i-folder"/></svg>
          <span class="side-name">${escapeHtml(folder.name)}</span>
          <span class="side-count">${folder.unread || 0}</span>
          <span class="feed-actions">
            <button class="icon-btn" data-act="rename-folder" data-id="${folder.id}" title="重命名"><svg class="ic"><use href="#i-edit"/></svg></button>
            <button class="icon-btn" data-act="delete-folder" data-id="${folder.id}" title="删除文件夹"><svg class="ic"><use href="#i-trash"/></svg></button>
          </span>
        </div>`);

      if (!collapsed) {
        parts.push('<div class="folder-children">');
        for (const feed of children) parts.push(feedRowHtml(feed));
        if (!children.length) parts.push('<div class="side-stats" style="padding-left:12px">（空文件夹，可把订阅拖进来）</div>');
        parts.push('</div>');
      }
    }

    if (uncategorized.length) {
      parts.push(`
        <div class="side-item folder-head collapsed ${isViewActive('folder', '__uncategorized__') ? 'active' : ''}"
             data-nav="folder" data-id="__uncategorized__" title="未分类订阅">
          <svg class="ic chev" style="opacity:0"></svg>
          <svg class="ic"><use href="#i-folder"/></svg>
          <span class="side-name">未分类</span>
          <span class="side-count">${uncategorized.reduce((s, f) => s + f.unread, 0)}</span>
        </div>`);
      parts.push('<div class="folder-children">');
      for (const feed of uncategorized) parts.push(feedRowHtml(feed));
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  if (!state.feeds.length) {
    parts.push(`
      <div class="empty-state" style="padding:26px 12px">
        <svg class="ic"><use href="#i-rss"/></svg>
        <h3>还没有订阅源</h3>
        <p>点击右上角「添加订阅」粘贴一个 RSS 地址，<br>或者载入内置示例源先看看效果。</p>
        <button class="btn primary" id="btn-load-demo" style="margin:14px auto 0">
          <svg class="ic"><use href="#i-spark"/></svg>载入示例订阅
        </button>
      </div>`);
  }

  parts.push(`<div class="side-stats">
      <span>共 ${state.stats.feeds || 0} 个源</span>
      <span>${state.stats.unread || 0} 篇未读</span>
      ${state.stats.unreadToday ? `<span>今日 ${state.stats.unreadToday} 篇</span>` : ''}
    </div>`);

  els.sidebarScroll.innerHTML = parts.join('');

  const demoBtn = els.sidebarScroll.querySelector('#btn-load-demo');
  if (demoBtn) demoBtn.onclick = loadDemoSources;
  bindDragAndDrop();
}

function feedRowHtml(feed) {
  const status = feed.status === 'error'
    ? `<span class="feed-status error" title="${escapeHtml(feed.lastError || '抓取失败')}"></span>`
    : feed.status === 'fetching'
      ? '<span class="feed-status fetching"></span>'
      : '<span class="feed-status"></span>';
  return `
    <div class="side-item feed-row ${isViewActive('feed', feed.id) ? 'active' : ''} ${feed.unread ? 'unread' : ''}"
         data-nav="feed" data-id="${feed.id}" data-drop="feed" draggable="true"
         title="${escapeHtml(feed.title)}${feed.lastError ? `\n上次抓取失败：${feed.lastError}` : ''}">
      ${feedIconHtml(feed)}
      <span class="side-name">${escapeHtml(feed.title)}</span>
      ${status}
      <span class="side-count">${feed.unread || 0}</span>
      <span class="feed-actions">
        <button class="icon-btn" data-act="refresh-feed" data-id="${feed.id}" title="刷新此源"><svg class="ic"><use href="#i-refresh"/></svg></button>
        <button class="icon-btn" data-act="edit-feed" data-id="${feed.id}" title="编辑"><svg class="ic"><use href="#i-edit"/></svg></button>
        <button class="icon-btn" data-act="delete-feed" data-id="${feed.id}" title="删除"><svg class="ic"><use href="#i-trash"/></svg></button>
      </span>
    </div>`;
}

// ---- 拖拽归类 -------------------------------------------------------------
function bindDragAndDrop() {
  let draggedFeedId = null;

  els.sidebarScroll.querySelectorAll('[draggable="true"][data-nav="feed"]').forEach((row) => {
    row.addEventListener('dragstart', (event) => {
      draggedFeedId = row.dataset.id;
      event.dataTransfer.setData('text/plain', draggedFeedId);
      event.dataTransfer.effectAllowed = 'move';
      row.style.opacity = '0.45';
    });
    row.addEventListener('dragend', () => {
      row.style.opacity = '';
      els.sidebarScroll.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
    });
  });

  els.sidebarScroll.querySelectorAll('[data-drop="folder"]').forEach((zone) => {
    zone.addEventListener('dragover', (event) => {
      if (!draggedFeedId) return;
      event.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
      const feedId = draggedFeedId || event.dataTransfer.getData('text/plain');
      draggedFeedId = null;
      const folderId = zone.dataset.id === '__uncategorized__' ? null : zone.dataset.id;
      const feed = feedMap().get(feedId);
      if (!feed || feed.folderId === folderId) return;
      try {
        await api.updateFeed(feedId, { folderId });
        await refreshState();
        toast(`已移动到「${folderId ? state.folders.find((f) => f.id === folderId)?.name : '未分类'}」`, 'ok');
      } catch (err) { reportError(err, '移动失败'); }
    });
  });
}

// ===========================================================================
// 列表
// ===========================================================================
function viewMeta() {
  const { view } = state;
  if (view.kind === 'smart') {
    const def = SMART_VIEWS[view.key];
    return { title: def.label, subtitle: '' };
  }
  if (view.kind === 'feed') {
    const feed = feedMap().get(view.id);
    return { title: feed?.title || '订阅源', subtitle: feed ? friendlyHost(feed.url) : '' };
  }
  if (view.kind === 'folder') {
    if (view.id === '__uncategorized__') return { title: '未分类', subtitle: '' };
    const folder = state.folders.find((f) => f.id === view.id);
    return { title: folder?.name || '文件夹', subtitle: '' };
  }
  return { title: '文章', subtitle: '' };
}

function currentQuery(offset = 0) {
  const { view } = state;
  const params = { filter: state.filter, q: state.query, sort: state.sort, limit: PAGE_SIZE, offset };
  if (view.kind === 'feed') params.feedId = view.id;
  if (view.kind === 'folder') params.folderId = view.id;
  return params;
}

function renderListHeader() {
  const meta = viewMeta();
  els.viewTitle.textContent = meta.title;

  const bits = [];
  if (state.total) bits.push(`${state.total} 篇`);
  if (state.unreadInView) bits.push(`未读 ${state.unreadInView}`);
  if (state.query) bits.push(`搜索「${state.query}」`);
  if (meta.subtitle) bits.push(meta.subtitle);
  els.viewSub.textContent = bits.join(' · ');
}

function articleItemHtml(article) {
  const feed = feedMap().get(article.feedId);
  const snippet = clampText(article.summary, 190);
  return `
    <li class="article-item ${article.read ? 'read' : ''} ${state.selectedId === article.id ? 'selected' : ''}"
        data-id="${article.id}" tabindex="0" role="button"
        aria-label="${escapeHtml(article.title)}">
      <span class="article-dot"></span>
      <div class="article-main">
        <h3 class="article-title">${highlight(article.title, state.query)}</h3>
        ${snippet ? `<p class="article-snippet">${highlight(snippet, state.query)}</p>` : ''}
        <div class="article-meta">
          <span class="src">${escapeHtml(feed?.title || '未知来源')}</span>
          <span class="sep">·</span>
          <time datetime="${new Date(article.publishedAt).toISOString()}">${escapeHtml(relativeTime(article.publishedAt))}</time>
          ${article.author ? `<span class="sep">·</span><span>${escapeHtml(clampText(article.author, 20))}</span>` : ''}
        </div>
      </div>
      <button class="star-btn ${article.starred ? 'on' : ''}" data-act="star" data-id="${article.id}"
              title="${article.starred ? '取消收藏' : '收藏'}" aria-label="收藏">
        <svg class="ic"><use href="#i-star"/></svg>
      </button>
    </li>`;
}

function renderList({ append = false } = {}) {
  renderListHeader();
  const map = feedMap();

  if (!state.articles.length) {
    els.articleList.innerHTML = '';
    els.articleScroll.querySelector('.empty-state')?.remove();
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    if (state.query) {
      empty.innerHTML = `<svg class="ic"><use href="#i-search"/></svg>
        <h3>没有匹配「${escapeHtml(state.query)}」的文章</h3>
        <p>试试更短的关键词，或切换到「全部文章」再搜。</p>`;
    } else if (state.filter === 'unread') {
      empty.innerHTML = `<svg class="ic"><use href="#i-check"/></svg>
        <h3>全部读完了</h3><p>这个范围里没有未读文章。</p>`;
    } else if (state.filter === 'starred') {
      empty.innerHTML = `<svg class="ic"><use href="#i-star"/></svg>
        <h3>还没有收藏</h3><p>在列表或阅读界面点击星标即可收藏文章。</p>`;
    } else if (!state.feeds.length) {
      empty.innerHTML = `<svg class="ic"><use href="#i-rss"/></svg>
        <h3>先添加一个订阅源</h3><p>点击右上角「添加订阅」，粘贴 RSS / Atom 地址即可。</p>`;
    } else {
      empty.innerHTML = `<svg class="ic"><use href="#i-refresh"/></svg>
        <h3>这里还没有文章</h3><p>按 <kbd>R</kbd> 立即抓取，或等待下一次自动更新。</p>`;
    }
    els.articleScroll.prepend(empty);
    els.listFooter.innerHTML = '';
    return;
  }

  els.articleScroll.querySelector('.empty-state')?.remove();
  const html = state.articles.map(articleItemHtml).join('');

  if (append) els.articleList.insertAdjacentHTML('beforeend', html);
  else els.articleList.innerHTML = html;

  const feedErrors = state.feeds.filter((f) => f.status === 'error');
  if (state.hasMore) {
    els.listFooter.innerHTML = `<button class="btn ghost sm" id="btn-load-more">加载更多（还有 ${Math.max(0, state.total - state.articles.length)} 篇）</button>`;
    $('btn-load-more').onclick = () => loadArticles({ append: true });
  } else {
    els.listFooter.innerHTML = `<span>已显示全部 ${state.total} 篇</span>`;
  }
  if (feedErrors.length && !state.query) {
    els.listFooter.insertAdjacentHTML('beforeend',
      `<div style="margin-top:10px;color:var(--danger);font-size:12px">${feedErrors.length} 个源抓取失败，鼠标悬停左侧源名称可查看原因</div>`);
  }
}

async function loadArticles({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const offset = append ? state.articles.length : 0;
  try {
    const result = await api.listArticles(currentQuery(offset));
    state.articles = append ? [...state.articles, ...result.items] : result.items;
    state.total = result.total;
    state.unreadInView = result.unread;
    state.hasMore = result.hasMore;
    renderList({ append });
    if (!append && state.selectedId && !state.articles.some((a) => a.id === state.selectedId)) {
      state.selectedId = null;
    }
  } catch (err) {
    state.articles = [];
    state.total = 0;
    state.hasMore = false;
    renderList();
    reportError(err, '加载文章失败');
  } finally {
    state.loading = false;
  }
}

// ===========================================================================
// 阅读界面
// ===========================================================================
async function openArticle(id, { focus = false } = {}) {
  const listItem = state.articles.find((a) => a.id === id);
  state.selectedId = id;

  els.articleList.querySelectorAll('.article-item.selected').forEach((n) => n.classList.remove('selected'));
  els.articleList.querySelector(`[data-id="${id}"]`)?.classList.add('selected');

  try {
    const { article, feed } = await api.getArticle(id);
    if (state.selectedId !== id) return; // 用户已经切走了
    state.reader = article;
    state.readerFeed = feed;
    renderReader();
    els.app.classList.add('reader-open');
    if (focus) els.readerBody.focus({ preventScroll: true });

    if (!article.read && state.settings.mark_read_on_open) {
      await setRead(id, true, { silent: true });
    }
  } catch (err) {
    reportError(err, '打开文章失败');
  }
}

function renderReader() {
  const article = state.reader;
  if (!article) {
    els.reader.hidden = true;
    els.readerEmpty.hidden = false;
    return;
  }
  els.reader.hidden = false;
  els.readerEmpty.hidden = true;

  const feed = state.readerFeed || feedMap().get(article.feedId);
  els.readerSource.textContent = feed?.title || '未知来源';
  els.readerSource.href = feed?.siteUrl || article.link || '#';
  els.readerTime.textContent = `${relativeTime(article.publishedAt)} · ${formatDateTime(article.publishedAt)}`;
  els.readerTime.dateTime = new Date(article.publishedAt).toISOString();

  if (article.author) {
    els.readerAuthorWrap.hidden = false;
    els.readerAuthor.textContent = article.author;
  } else {
    els.readerAuthorWrap.hidden = true;
  }

  els.readerTitle.textContent = article.title;
  els.btnStar.classList.toggle('on', article.starred);
  els.btnStar.querySelector('span').textContent = article.starred ? '已收藏' : '收藏';
  els.btnToggleRead.querySelector('span').textContent = article.read ? '标记未读' : '标记已读';

  if (article.link) {
    els.btnOriginal.href = article.link;
    els.btnOriginal.hidden = false;
  } else {
    els.btnOriginal.hidden = true;
  }

  const raw = article.contentHtml && state.settings.show_full_content !== 0
    ? article.contentHtml
    : textToParagraphs(article.summary || '（这篇文章没有正文，可在右侧按钮中打开原文）');
  const safe = sanitizeHtml(raw);
  els.readerBody.innerHTML = safe || textToParagraphs(article.summary || '（正文为空）');
  els.readerBody.scrollTop = 0;
}

function step(delta) {
  if (!state.articles.length) return;
  const index = state.articles.findIndex((a) => a.id === state.selectedId);
  const next = index === -1 ? (delta > 0 ? 0 : state.articles.length - 1) : index + delta;
  if (next < 0 || next >= state.articles.length) return;
  const target = state.articles[next];
  // 条目可能在滚动容器视口之外，先滚进视野再打开
  const node = els.articleList.querySelector(`[data-id="${target.id}"]`);
  node?.scrollIntoView({ block: 'nearest' });
  openArticle(target.id);
}

// ===========================================================================
// 文章操作
// ===========================================================================
async function setRead(id, read, { silent = false } = {}) {
  const item = state.articles.find((a) => a.id === id);
  const previous = item?.read;
  if (item) {
    item.read = read;
    updateArticleNode(item);
  }
  try {
    await api.patchArticle(id, { read });
    if (!silent) refreshStateDebounced();
    else refreshStateDebounced();
    return true;
  } catch (err) {
    if (item) { item.read = previous; updateArticleNode(item); }
    reportError(err, '更新已读状态失败');
    return false;
  }
}

async function setStarred(id, starred) {
  const item = state.articles.find((a) => a.id === id);
  const previous = item?.starred;
  if (item) { item.starred = starred; updateArticleNode(item); }
  if (state.reader?.id === id) {
    state.reader.starred = starred;
    renderReader();
  }
  try {
    await api.patchArticle(id, { starred });
    refreshStateDebounced();
    if (state.filter === 'starred' && !starred) {
      state.articles = state.articles.filter((a) => a.id !== id);
      state.total = Math.max(0, state.total - 1);
      renderList();
    }
  } catch (err) {
    if (item) { item.starred = previous; updateArticleNode(item); }
    reportError(err, '更新收藏状态失败');
  }
}

function updateArticleNode(article) {
  const node = els.articleList.querySelector(`[data-id="${article.id}"]`);
  if (!node) return;
  node.classList.toggle('read', article.read);
  const star = node.querySelector('.star-btn');
  if (star) {
    star.classList.toggle('on', article.starred);
    star.title = article.starred ? '取消收藏' : '收藏';
  }
}

async function markAllRead() {
  const scope = state.view.kind === 'feed' ? 'feed'
    : state.view.kind === 'folder' ? 'folder' : 'all';
  const payload = { scope, filter: state.filter, read: true };
  if (scope === 'feed') payload.feedId = state.view.id;
  if (scope === 'folder') payload.folderId = state.view.id;

  const label = payload.scope === 'all' && !state.query ? '所有' : '当前范围内';
  if (!await confirmDialog({
    title: '全部标为已读',
    message: `将把${label}的 ${state.unreadInView || 0} 篇未读文章标记为已读，此操作可以逐篇撤销。`,
    confirmText: '标记已读'
  })) return;

  try {
    const result = await api.markAll(payload);
    toast(`已标记 ${result.changed} 篇为已读`, 'ok');
    await refreshState();
    await loadArticles();
  } catch (err) { reportError(err, '批量标记失败'); }
}

// ===========================================================================
// 刷新
// ===========================================================================
async function refreshAll({ force = false } = {}) {
  try {
    state.refreshing = true;
    $('btn-refresh').classList.add('spinning');
    await api.refresh({ target: 'all', force });
    if (!force) toast('已开始刷新全部订阅源', 'info', 2000);
  } catch (err) {
    reportError(err, '刷新失败');
    $('btn-refresh').classList.remove('spinning');
    state.refreshing = false;
  }
}

async function refreshOneFeed(id) {
  const feed = feedMap().get(id);
  try {
    toast(`正在刷新「${feed?.title || '订阅源'}」…`, 'info', 1800);
    const { result } = await api.refreshFeed(id);
    if (result?.ok) {
      toast(result.notModified ? '内容没有变化' : `「${feed?.title || '订阅源'}」新增 ${result.newCount} 篇`, 'ok');
    } else if (result?.skipped) {
      toast('该订阅源正在抓取中，请稍候', 'info');
    } else {
      toast(`抓取失败${result?.error ? `：${result.error}` : ''}`, 'error', 5000);
    }
    await refreshState();
    await loadArticles();
  } catch (err) {
    reportError(err, '刷新失败');
    $('btn-refresh').classList.remove('spinning');
  }
}

// ===========================================================================
// 状态加载
// ===========================================================================
async function refreshState() {
  const snapshot = await api.snapshot();
  state.folders = snapshot.folders;
  state.feeds = snapshot.feeds;
  state.stats = snapshot.stats;
  state.settings = { ...state.settings, ...snapshot.settings };
  applyTheme();
  renderSidebar();
  renderListHeader();
  return snapshot;
}

const refreshStateDebounced = debounce(() => {
  if (state.dirty) return;
  state.dirty = true;
  refreshState()
    .catch(() => {})
    .finally(() => { state.dirty = false; });
}, 400);

const reloadAfterBatch = debounce(async () => {
  try {
    await refreshState();
    await loadArticles();
  } catch (err) { console.error(err); }
}, 500);

// ===========================================================================
// 订阅管理
// ===========================================================================
function folderOptions(selected = '', includeNone = true) {
  const options = state.folders
    .map((f) => `<option value="${f.id}" ${selected === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
    .join('');
  return `${includeNone ? `<option value="" ${!selected ? 'selected' : ''}>未分类</option>` : ''}${options}`;
}

function openAddFeedModal() {
  openModal({
    title: '添加订阅',
    body: `
      <div class="field">
        <label for="feed-url">订阅地址</label>
        <div class="input-row">
          <input class="input" id="feed-url" type="text" placeholder="https://example.com/feed.xml 或站点首页地址"
                 autocomplete="off" spellcheck="false">
          <button class="btn ghost" id="btn-discover">检测</button>
        </div>
        <div class="hint" id="feed-hint">支持 RSS 2.0 / Atom / RSS 1.0。如果粘贴的是网站首页，会自动尝试发现其订阅地址。</div>
      </div>
      <div class="field">
        <label for="feed-folder">放入文件夹</label>
        <select class="input" id="feed-folder">${folderOptions()}</select>
      </div>
      <div class="field">
        <label for="feed-interval">自动抓取间隔</label>
        <select class="input" id="feed-interval">
          <option value="15">每 15 分钟</option>
          <option value="30" selected>每 30 分钟</option>
          <option value="60">每小时</option>
          <option value="180">每 3 小时</option>
          <option value="720">每 12 小时</option>
          <option value="1440">每天</option>
        </select>
        <div class="hint">定时器会按此间隔抓取；抓取失败时自动退避，不会反复打扰失效的站点。</div>
      </div>`,
    footer: `
      <button class="btn ghost" data-act="cancel">取消</button>
      <button class="btn primary" data-act="submit">添加并抓取</button>`,
    onMount(body, foot) {
      const urlInput = body.querySelector('#feed-url');
      const hint = body.querySelector('#feed-hint');
      const setHint = (text, kind = '') => {
        hint.textContent = text;
        hint.className = `hint ${kind}`;
      };

      const discover = async () => {
        const url = urlInput.value.trim();
        if (!url) { setHint('请先填写订阅地址', 'error'); return; }
        setHint('正在检测…');
        try {
          const result = await api.discoverFeed(url);
          urlInput.value = result.feedUrl;
          setHint(`检测到「${result.title || result.feedUrl}」（${String(result.format).toUpperCase()}，${result.itemCount} 条）${result.discovered ? '，已自动发现真实订阅地址' : ''}`, 'ok');
        } catch (err) {
          setHint(err.message, 'error');
        }
      };
      body.querySelector('#btn-discover').onclick = discover;

      urlInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); if (urlInput.value.trim()) foot.querySelector('[data-act="submit"]').click(); }
      });

      const submit = async () => {
        const url = urlInput.value.trim();
        if (!url) { urlInput.focus(); setHint('请填写订阅地址', 'error'); return; }
        const button = foot.querySelector('[data-act="submit"]');
        button.disabled = true;
        button.textContent = '正在抓取…';
        try {
          const payload = {
            url,
            folderId: body.querySelector('#feed-folder').value || null,
            intervalMin: Number(body.querySelector('#feed-interval').value)
          };
          let result;
          try {
            result = await api.addFeed(payload);
          } catch (err) {
            if (err.status === 422) {
              const force = await confirmDialog({
                title: '无法读取该地址',
                message: `${err.message}\n\n仍然要保存这个订阅吗？保存后会显示为抓取失败，可以稍后重试。`,
                confirmText: '仍然保存'
              });
              if (!force) { button.disabled = false; button.textContent = '添加并抓取'; return; }
              result = await api.addFeed({ ...payload, force: true });
            } else throw err;
          }
          closeModal();
          toast(`已添加「${result.feed.title}」，抓到 ${result.newCount} 篇文章`, 'ok');
          await refreshState();
          selectView({ kind: 'feed', id: result.feed.id });
        } catch (err) {
          reportError(err, '添加失败');
          button.disabled = false;
          button.textContent = '添加并抓取';
        }
      };
      foot.querySelector('[data-act="submit"]').onclick = submit;
    }
  });
}

function openEditFeedModal(id) {
  const feed = feedMap().get(id);
  if (!feed) return;
  openModal({
    title: '编辑订阅源',
    body: `
      <div class="field">
        <label for="edit-url">订阅地址</label>
        <input class="input" id="edit-url" type="text" value="${escapeHtml(feed.url)}" spellcheck="false">
        <div class="hint">修改地址会重置缓存标记，并在下次抓取时重新拉取全部内容。</div>
      </div>
      <div class="field">
        <label for="edit-title">显示名称</label>
        <input class="input" id="edit-title" type="text" value="${escapeHtml(feed.customTitle || '')}"
               placeholder="${escapeHtml(feed.feedTitle || feed.title)}（留空则使用源自带标题）">
      </div>
      <div class="field">
        <label for="edit-folder">文件夹</label>
        <select class="input" id="edit-folder">${folderOptions(feed.folderId || '')}</select>
      </div>
      <div class="field">
        <label for="edit-interval">抓取间隔（分钟）</label>
        <input class="input" id="edit-interval" type="number" min="5" max="1440" value="${feed.intervalMin}">
      </div>
      <label class="checkline">
        <input type="checkbox" id="edit-enabled" ${feed.enabled ? 'checked' : ''}>
        <span>启用自动抓取</span>
      </label>
      <div class="field" style="margin-top:8px">
        <div class="hint">
          上次抓取：${feed.lastFetchedAt ? escapeHtml(formatDateTime(feed.lastFetchedAt)) : '尚未抓取'} ·
          状态：${feed.status === 'ok' ? '正常' : feed.status === 'error' ? `<span style="color:var(--danger)">失败（${escapeHtml(feed.lastError || '')}）</span>` : '空闲'}
        </div>
      </div>`,
    footer: `
      <button class="btn danger" data-act="delete">删除订阅</button>
      <div style="flex:1"></div>
      <button class="btn ghost" data-act="cancel">取消</button>
      <button class="btn primary" data-act="save">保存</button>`,
    onMount(body, foot) {
      foot.querySelector('[data-act="cancel"]').onclick = closeModal;
      foot.querySelector('[data-act="save"]').onclick = async () => {
        try {
          await api.updateFeed(id, {
            url: body.querySelector('#edit-url').value.trim(),
            customTitle: body.querySelector('#edit-title').value.trim(),
            folderId: body.querySelector('#edit-folder').value || null,
            intervalMin: Number(body.querySelector('#edit-interval').value) || 30,
            enabled: body.querySelector('#edit-enabled').checked
          });
          closeModal();
          toast('已保存', 'ok');
          await refreshState();
        } catch (err) { reportError(err, '保存失败'); }
      };
      foot.querySelector('[data-act="delete"]').onclick = () => { closeModal(); deleteFeed(id); };
    }
  });
}

async function deleteFeed(id) {
  const feed = feedMap().get(id);
  if (!feed) return;
  const ok = await confirmDialog({
    title: '删除订阅源',
    message: `将删除「${feed.title}」及其本地缓存的全部文章（含已收藏的）。该操作不可恢复。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;
  try {
    const result = await api.deleteFeed(id);
    toast(`已删除，清理了 ${result.removedArticles} 篇文章`, 'ok');
    if (state.view.kind === 'feed' && state.view.id === id) selectView({ kind: 'smart', key: 'all' });
    else { await refreshState(); await loadArticles(); }
  } catch (err) { reportError(err, '删除失败'); }
}

function openFolderModal({ id = null } = {}) {
  const folder = id ? state.folders.find((f) => f.id === id) : null;
  openModal({
    title: folder ? '重命名文件夹' : '新建文件夹',
    body: `
      <div class="field">
        <label for="folder-name">文件夹名称</label>
        <input class="input" id="folder-name" type="text" value="${escapeHtml(folder?.name || '')}" placeholder="例如：技术、行业动态、稍后读">
      </div>`,
    footer: `
      <button class="btn ghost" data-act="cancel">取消</button>
      <button class="btn primary" data-act="save">${folder ? '保存' : '创建'}</button>`,
    onMount(body, foot) {
      const input = body.querySelector('#folder-name');
      foot.querySelector('[data-act="cancel"]').onclick = closeModal;
      const save = async () => {
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        try {
          if (folder) await api.updateFolder(folder.id, { name });
          else await api.createFolder(name);
          closeModal();
          toast(folder ? '已重命名' : `已创建「${name}」`, 'ok');
          await refreshState();
        } catch (err) { reportError(err, '操作失败'); }
      };
      foot.querySelector('[data-act="save"]').onclick = save;
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') save(); });
    }
  });
}

async function deleteFolder(id) {
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) return;
  const inside = state.feeds.filter((f) => f.folderId === id);
  openModal({
    title: '删除文件夹',
    body: `
      <p style="margin:0 0 14px;font-size:13.5px;color:var(--text-dim);line-height:1.7">
        文件夹「${escapeHtml(folder.name)}」中有 ${inside.length} 个订阅源。删除文件夹不会删除订阅，请选择它们的去向。
      </p>
      <div class="field">
        <label>订阅源移动到哪里</label>
        <select class="input" id="move-target">
          <option value="">未分类</option>
          ${state.folders.filter((f) => f.id !== id).map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('')}
        </select>
      </div>`,
    footer: `
      <button class="btn ghost" data-act="cancel">取消</button>
      <button class="btn danger" data-act="ok">删除文件夹</button>`,
    onMount(body, foot) {
      foot.querySelector('[data-act="cancel"]').onclick = closeModal;
      foot.querySelector('[data-act="ok"]').onclick = async () => {
        try {
          const moveTo = body.querySelector('#move-target').value || null;
          await api.deleteFolder(id, moveTo);
          closeModal();
          toast('文件夹已删除，订阅已保留', 'ok');
          if (state.view.kind === 'folder' && state.view.id === id) selectView({ kind: 'smart', key: 'all' });
          else await refreshState();
        } catch (err) { reportError(err, '删除失败'); }
      };
    }
  });
}

function openOpmlModal() {
  openModal({
    title: '导入 / 导出订阅',
    body: `
      <div class="field">
        <label>导出</label>
        <div class="hint">把当前全部订阅与文件夹导出为 OPML 文件，可用于备份或迁移到其它阅读器。</div>
        <a class="btn ghost" href="${api.opmlExportUrl}" download style="margin-top:8px;display:inline-flex">
          <svg class="ic"><use href="#i-import"/></svg>下载 OPML 文件
        </a>
      </div>
      <div class="field" style="margin-top:18px">
        <label for="opml-input">导入</label>
        <textarea class="input" id="opml-input" rows="8" placeholder="粘贴 OPML 文件内容，或从下方选择文件…" spellcheck="false"></textarea>
        <div class="input-row" style="margin-top:8px">
          <input type="file" id="opml-file" accept=".opml,.xml,text/xml,text/x-opml" style="display:none">
          <button class="btn ghost" id="btn-pick-file">选择 OPML 文件</button>
          <div class="spacer" style="flex:1"></div>
        </div>
        <div class="hint" id="opml-hint">导入时会自动创建缺失的文件夹，已存在的订阅地址会被跳过。</div>
      </div>`,
    footer: `
      <button class="btn ghost" data-act="cancel">关闭</button>
      <button class="btn primary" data-act="import">开始导入</button>`,
    onMount(body, foot) {
      const textarea = body.querySelector('#opml-input');
      const fileInput = body.querySelector('#opml-file');
      const hint = body.querySelector('#opml-hint');
      foot.querySelector('[data-act="cancel"]').onclick = closeModal;
      body.querySelector('#btn-pick-file').onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        textarea.value = await file.text();
        hint.textContent = `已读入 ${file.name}（${(file.size / 1024).toFixed(1)} KB）`;
        hint.className = 'hint ok';
      };
      foot.querySelector('[data-act="import"]').onclick = async () => {
        const opml = textarea.value.trim();
        if (!opml) { hint.textContent = '请粘贴或选择 OPML 内容'; hint.className = 'hint error'; return; }
        try {
          hint.textContent = '正在导入…';
          hint.className = 'hint';
          const result = await api.importOpml(opml);
          hint.textContent = `导入完成：新增 ${result.added} 个源，新建 ${result.folders} 个文件夹，跳过重复 ${result.skipped} 个。正在后台抓取内容…`;
          hint.className = 'hint ok';
          toast(`已导入 ${result.added} 个订阅源`, 'ok');
          await refreshState();
        } catch (err) {
          hint.textContent = err.message;
          hint.className = 'hint error';
        }
      };
    }
  });
}

function openSettingsModal() {
  const s = state.settings;
  openModal({
    title: '设置',
    body: `
      <div class="field">
        <label>外观主题</label>
        <div class="radio-cards">
          ${[['auto', '跟随系统', '根据系统深浅色自动切换'], ['dark', '深色', '适合长时间阅读'], ['light', '浅色', '明亮环境使用']]
            .map(([value, label, desc]) => `
              <label class="radio-card ${s.theme === value ? 'on' : ''}" data-theme-option="${value}">
                <input type="radio" name="theme" value="${value}" ${s.theme === value ? 'checked' : ''}>
                <span><b>${label}</b><span>${desc}</span></span>
              </label>`).join('')}
        </div>
      </div>
      <div class="field">
        <label for="set-interval">新订阅的默认抓取间隔（分钟）</label>
        <input class="input" id="set-interval" type="number" min="5" max="1440" value="${s.global_refresh_min}">
      </div>
      <div class="field">
        <label for="set-concurrency">并发抓取上限</label>
        <input class="input" id="set-concurrency" type="number" min="1" max="24" value="${s.max_concurrency}">
        <div class="hint">同时进行的抓取任务数量。过大容易触发源站限流。</div>
      </div>
      <div class="field">
        <label for="set-perhost">同一域名并发上限</label>
        <input class="input" id="set-perhost" type="number" min="1" max="8" value="${s.per_host_concurrency}">
        <div class="hint">保护同一站点的礼貌值，建议保持 2。</div>
      </div>
      <div class="field">
        <label for="set-timeout">单次请求超时（毫秒）</label>
        <input class="input" id="set-timeout" type="number" min="3000" max="120000" step="1000" value="${s.request_timeout_ms}">
      </div>
      <label class="checkline">
        <input type="checkbox" id="set-markread" ${s.mark_read_on_open ? 'checked' : ''}>
        <span>打开文章时自动标记为已读</span>
      </label>
      <label class="checkline">
        <input type="checkbox" id="set-fullcontent" ${s.show_full_content ? 'checked' : ''}>
        <span>阅读界面优先显示全文（关闭则只显示摘要）</span>
      </label>
      <div class="field" style="margin-top:14px">
        <label>运行状态</label>
        <div class="hint" id="status-line">加载中…</div>
      </div>`,
    footer: `
      <button class="btn ghost" data-act="cancel">取消</button>
      <button class="btn primary" data-act="save">保存设置</button>`,
    onMount(body, foot) {
      foot.querySelector('[data-act="cancel"]').onclick = closeModal;
      body.querySelectorAll('[data-theme-option]').forEach((card) => {
        card.onclick = () => {
          body.querySelectorAll('.radio-card').forEach((c) => c.classList.remove('on'));
          card.classList.add('on');
          card.querySelector('input').checked = true;
        };
      });
      api.getLog(8).then(({ log }) => {
        const last = log.slice(0, 5).map((entry) =>
          `${new Date(entry.startedAt).toLocaleTimeString()} ${entry.ok ? '✓' : '✗'} ${entry.newCount ? `+${entry.newCount}` : ''} ${escapeHtml(entry.message || '')}`
        ).join('<br>') || '暂无抓取记录';
        body.querySelector('#status-line').innerHTML = last;
      }).catch(() => {
        body.querySelector('#status-line').textContent = '无法获取运行状态';
      });

      foot.querySelector('[data-act="save"]').onclick = async () => {
        try {
          await api.updateSettings({
            theme: body.querySelector('input[name="theme"]:checked').value,
            global_refresh_min: Number(body.querySelector('#set-interval').value),
            max_concurrency: Number(body.querySelector('#set-concurrency').value),
            per_host_concurrency: Number(body.querySelector('#set-perhost').value),
            request_timeout_ms: Number(body.querySelector('#set-timeout').value),
            mark_read_on_open: body.querySelector('#set-markread').checked,
            show_full_content: body.querySelector('#set-fullcontent').checked
          });
          closeModal();
          toast('设置已保存，抓取参数下次调度生效', 'ok');
          await refreshState();
        } catch (err) { reportError(err, '保存设置失败'); }
      };
    }
  });
}

function openShortcutsModal() {
  const rows = [
    ['J / K', '上一篇 / 下一篇'], ['Enter', '打开选中文章'], ['M', '切换已读状态'],
    ['S', '收藏 / 取消收藏'], ['O', '在浏览器打开原文'], ['R', '刷新全部订阅'],
    ['Shift + R', '强制刷新（忽略缓存标记）'], ['Shift + A', '当前列表全部标为已读'],
    ['/', '聚焦搜索框'], ['1 / 2 / 3', '全部 / 未读 / 收藏'], ['N', '添加订阅'],
    ['- / =', '减小 / 增大正文字号'], ['Esc', '关闭弹窗 / 清空搜索'], ['?', '显示本帮助']
  ];
  openModal({
    title: '键盘快捷键',
    body: `<div style="display:grid;grid-template-columns:110px 1fr;gap:9px 16px;font-size:13px">
      ${rows.map(([key, desc]) => `<kbd style="justify-self:start">${escapeHtml(key)}</kbd><span style="color:var(--text-dim)">${escapeHtml(desc)}</span>`).join('')}
    </div>`,
    footer: '<button class="btn primary" data-act="cancel">知道了</button>',
    onMount(body, foot) { foot.querySelector('[data-act="cancel"]').onclick = closeModal; }
  });
}

// ===========================================================================
// 视图切换
// ===========================================================================
function selectView(view) {
  state.view = view;
  state.selectedId = null;
  state.filter = view.kind === 'smart' ? SMART_VIEWS[view.key].filter : 'all';
  state.articles = [];
  prefs.write('view', view);
  els.articleScroll.scrollTop = 0;
  renderSidebar();
  renderFilterChips();
  loadArticles();
  els.app.classList.remove('sidebar-open');
  els.scrim.hidden = true;
}

function renderFilterChips() {
  const chips = [
    ['all', '全部'], ['unread', '未读'], ['starred', '收藏']
  ];
  els.listPane.querySelectorAll('.seg').forEach((n) => n.remove());
  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.innerHTML = chips.map(([key, label]) =>
    `<button class="seg-btn ${state.filter === key ? 'on' : ''}" data-filter="${key}">${label}</button>`).join('');
  els.listPane.querySelector('.pane-head').appendChild(seg);
  seg.querySelectorAll('[data-filter]').forEach((button) => {
    button.onclick = () => {
      if (state.filter === button.dataset.filter) return;
      state.filter = button.dataset.filter;
      renderFilterChips();
      state.articles = [];
      els.articleScroll.scrollTop = 0;
      loadArticles();
    };
  });
}

// ===========================================================================
// 示例源
// ===========================================================================
async function loadDemoSources() {
  try {
    const result = await api.demoSources();
    toast(result.created ? `已添加 ${result.created} 个示例订阅源` : '示例源已存在', 'ok');
    await refreshState();
    await refreshAll();
  } catch (err) { reportError(err, '载入示例源失败'); }
}

// ===========================================================================
// 主题与字号
// ===========================================================================
function applyTheme() {
  const theme = state.settings.theme || 'auto';
  document.documentElement.dataset.theme = theme;
  const readSize = prefs.read('readSize', 17);
  document.documentElement.style.setProperty('--read-size', `${readSize}px`);
}

// ===========================================================================
// 事件绑定
// ===========================================================================
function bindEvents() {
  // 侧栏导航（事件委托）
  els.sidebarScroll.addEventListener('click', (event) => {
    const actionBtn = event.target.closest('[data-act]');
    if (actionBtn) {
      event.stopPropagation();
      const { act, id } = actionBtn.dataset;
      if (act === 'refresh-feed') refreshOneFeed(id);
      else if (act === 'edit-feed') openEditFeedModal(id);
      else if (act === 'delete-feed') deleteFeed(id);
      else if (act === 'rename-folder') openFolderModal({ id });
      else if (act === 'delete-folder') deleteFolder(id);
      return;
    }
    const item = event.target.closest('[data-nav]');
    if (!item) return;
    const { nav, id, key } = item.dataset;
    if (nav === 'folder') {
      const folder = state.folders.find((f) => f.id === id);
      // 点击文件夹箭头只做折叠，点击名称才进入视图
      if (event.target.closest('.chev') || event.offsetX < 46) {
        const collapsed = !folder?.collapsed;
        api.updateFolder(id, { collapsed }).then(refreshState).catch(() => {});
        return;
      }
    }
    selectView(nav === 'smart' ? { kind: 'smart', key } : { kind: nav, id });
  });

  // 文章列表
  els.articleList.addEventListener('click', (event) => {
    const star = event.target.closest('[data-act="star"]');
    if (star) {
      event.stopPropagation();
      const id = star.dataset.id;
      const item = state.articles.find((a) => a.id === id);
      setStarred(id, !item?.starred);
      return;
    }
    const row = event.target.closest('.article-item');
    if (row) openArticle(row.dataset.id);
  });

  els.articleList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('.article-item');
    if (!row) return;
    event.preventDefault();
    openArticle(row.dataset.id);
  });

  // 阅读区操作
  els.btnStar.onclick = () => state.reader && setStarred(state.reader.id, !state.reader.starred);
  els.btnToggleRead.onclick = () => {
    if (!state.reader) return;
    setRead(state.reader.id, !state.reader.read).then(() => {
      if (state.reader) { state.reader.read = !state.reader.read; renderReader(); }
    });
  };
  $('btn-prev').onclick = () => step(-1);
  $('btn-next').onclick = () => step(1);
  $('btn-open-original-foot').onclick = () => {
    if (state.reader?.link) window.open(state.reader.link, '_blank', 'noopener');
  };
  $('btn-font-up').onclick = () => adjustFontSize(1);
  $('btn-font-down').onclick = () => adjustFontSize(-1);

  const backBtn = $('btn-reader-back');
  if (backBtn) backBtn.onclick = () => els.app.classList.remove('reader-open');

  // 顶栏
  $('btn-add-feed').onclick = openAddFeedModal;
  $('btn-refresh').onclick = () => refreshAll({ force: false });
  $('btn-settings').onclick = openSettingsModal;
  $('btn-mark-all').onclick = markAllRead;
  $('btn-new-folder').onclick = () => openFolderModal({});
  $('btn-opml').onclick = openOpmlModal;
  $('btn-sort').onclick = () => {
    state.sort = state.sort === 'published' ? 'received' : 'published';
    $('btn-sort').classList.toggle('active', state.sort === 'received');
    $('btn-sort').title = state.sort === 'published' ? '当前：按发布时间排序' : '当前：按抓取时间排序';
    toast(state.sort === 'published' ? '按发布时间排序' : '按抓取时间排序', 'info', 1600);
    state.articles = [];
    loadArticles();
  };

  $('btn-sidebar').onclick = () => {
    els.app.classList.toggle('sidebar-open');
    els.scrim.hidden = !els.app.classList.contains('sidebar-open');
  };
  els.scrim.onclick = () => {
    els.app.classList.remove('sidebar-open');
    els.scrim.hidden = true;
  };

  // 搜索
  const runSearch = debounce(() => {
    state.query = els.searchInput.value.trim();
    els.searchClear.hidden = !state.query;
    state.articles = [];
    els.articleScroll.scrollTop = 0;
    loadArticles();
  }, 260);
  els.searchInput.addEventListener('input', runSearch);
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      els.searchInput.value = '';
      runSearch.flush();
      els.searchInput.blur();
    }
  });
  els.searchClear.onclick = () => {
    els.searchInput.value = '';
    runSearch.flush();
    els.searchInput.focus();
  };

  // 弹窗
  $('modal-close').onclick = closeModal;
  els.overlay.addEventListener('mousedown', (event) => {
    if (event.target === els.overlay) closeModal();
  });

  // 键盘
  document.addEventListener('keydown', handleKeydown);

  // 无限滚动
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && state.hasMore && !state.loading) {
      loadArticles({ append: true });
    }
  }, { root: els.articleScroll, rootMargin: '320px' });
  const sentinel = document.createElement('div');
  sentinel.style.height = '1px';
  els.listFooter.after(sentinel);
  observer.observe(sentinel);

  // 服务端事件
  connectEvents({
    onEvent(type, data) {
      if (type === 'batch:start') {
        showProgress(0, data.total);
      } else if (type === 'batch:progress') {
        showProgress(data.total ? (data.done / data.total) * 100 : 0, data.total, data.done);
      } else if (type === 'batch:done') {
        showProgress(100, data.total);
        state.refreshing = false;
        $('btn-refresh').classList.remove('spinning');
        const bits = [];
        if (data.newArticles) bits.push(`新增 ${data.newArticles} 篇`);
        if (data.notModified) bits.push(`${data.notModified} 个源无变化`);
        if (data.failed) bits.push(`${data.failed} 个失败`);
        toast(bits.length ? `刷新完成：${bits.join('，')}` : '刷新完成，没有新内容', data.failed ? 'error' : 'ok', 4000);
        reloadAfterBatch();
      } else if (type === 'feed:error') {
        refreshStateDebounced();
      } else if (type === 'feeds:changed' || type === 'folders:changed') {
        refreshStateDebounced();
      } else if (type === 'articles:changed') {
        refreshStateDebounced();
      } else if (type === 'settings:changed') {
        api.getSettings().then(({ settings }) => { state.settings = settings; applyTheme(); }).catch(() => {});
      }
    },
    onOpen() { /* 连接建立 */ },
    onError() { /* 断线由 EventSource 自动重连 */ }
  });

  window.addEventListener('resize', debounce(() => {
    if (window.innerWidth > 780) els.app.classList.remove('reader-open');
  }, 200));
}

let progressTimer = null;
function showProgress(percent, total, done) {
  els.progress.hidden = false;
  els.progressBar.style.width = `${Math.min(100, Math.max(2, percent))}%`;
  if (percent >= 100) {
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      els.progressBar.style.opacity = '0';
      setTimeout(() => {
        els.progress.hidden = true;
        els.progressBar.style.width = '0%';
        els.progressBar.style.opacity = '1';
      }, 320);
    }, 420);
  }
  if (total && typeof done === 'number') {
    $('btn-refresh').classList.add('spinning');
  }
}

function adjustFontSize(delta) {
  const current = prefs.read('readSize', 17);
  const next = Math.min(FONT_RANGE[1], Math.max(FONT_RANGE[0], current + delta));
  prefs.write('readSize', next);
  document.documentElement.style.setProperty('--read-size', `${next}px`);
  toast(`正文字号 ${next}px`, 'info', 1200);
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function handleKeydown(event) {
  const typing = isTypingTarget(event.target);

  if (event.key === 'Escape') {
    if (!els.overlay.hidden) { closeModal(); return; }
    if (typing) { event.target.blur(); return; }
    if (els.app.classList.contains('sidebar-open')) {
      els.app.classList.remove('sidebar-open');
      els.scrim.hidden = true;
      return;
    }
    if (els.app.classList.contains('reader-open')) {
      els.app.classList.remove('reader-open');
      return;
    }
    if (state.query) { els.searchInput.value = ''; state.query = ''; els.searchClear.hidden = true; loadArticles(); }
    return;
  }

  if (!els.overlay.hidden || typing) return;

  const key = event.key;
  if (key === '/') { event.preventDefault(); els.searchInput.focus(); els.searchInput.select(); return; }
  if (key === '?') { event.preventDefault(); openShortcutsModal(); return; }
  if (key === 'j' || key === 'J') { event.preventDefault(); step(1); return; }
  if (key === 'k' || key === 'K') { event.preventDefault(); step(-1); return; }
  if (key === 'n' || key === 'N') { event.preventDefault(); openAddFeedModal(); return; }
  if (key === 'r') { event.preventDefault(); refreshAll({ force: false }); return; }
  if (key === 'R') { event.preventDefault(); refreshAll({ force: true }); return; }
  if (key === 'A') { event.preventDefault(); markAllRead(); return; }
  if (key === '-') { event.preventDefault(); adjustFontSize(-1); return; }
  if (key === '=' || key === '+') { event.preventDefault(); adjustFontSize(1); return; }
  if (key === '1') { selectView({ kind: 'smart', key: 'all' }); return; }
  if (key === '2') { selectView({ kind: 'smart', key: 'unread' }); return; }
  if (key === '3') { selectView({ kind: 'smart', key: 'starred' }); return; }

  if (key === 'Enter' && state.selectedId) { event.preventDefault(); openArticle(state.selectedId, { focus: true }); return; }

  if (!state.selectedId && (key === 'm' || key === 's' || key === 'o')) {
    // 没有选中项时，作用在列表第一篇文章上
    if (state.articles[0]) {
      state.selectedId = state.articles[0].id;
      els.articleList.querySelector(`[data-id="${state.selectedId}"]`)?.classList.add('selected');
    } else return;
  }

  if (key === 'm' || key === 'M') {
    const item = state.articles.find((a) => a.id === state.selectedId);
    if (item) { event.preventDefault(); setRead(item.id, !item.read); if (state.reader?.id === item.id) { state.reader.read = !item.read; renderReader(); } }
    return;
  }
  if (key === 's' || key === 'S') {
    const item = state.articles.find((a) => a.id === state.selectedId);
    if (item) { event.preventDefault(); setStarred(item.id, !item.starred); }
    return;
  }
  if (key === 'o' || key === 'O') {
    const item = state.articles.find((a) => a.id === state.selectedId);
    if (item?.link) { event.preventDefault(); window.open(item.link, '_blank', 'noopener'); }
  }
}

// ===========================================================================
// 启动
// ===========================================================================
async function boot() {
  const savedView = prefs.read('view', null);
  const savedSize = prefs.read('readSize', 17);
  document.documentElement.style.setProperty('--read-size', `${savedSize}px`);
  document.documentElement.dataset.theme = prefs.read('themeHint', 'auto');

  bindEvents();

  try {
    await refreshState();
    if (savedView && (savedView.kind === 'smart' || state.folders.some((f) => f.id === savedView.id) || state.feeds.some((f) => f.id === savedView.id))) {
      state.view = savedView;
      state.filter = savedView.kind === 'smart' ? SMART_VIEWS[savedView.key]?.filter || 'all' : 'all';
    }
    applyTheme();
    prefs.write('themeHint', state.settings.theme || 'auto');
    renderSidebar();
    renderFilterChips();
    await loadArticles();
    els.searchInput.placeholder = `搜索 ${state.stats.articles || 0} 篇文章…（按 / 聚焦）`;
  } catch (err) {
    reportError(err, '初始化失败');
    els.sidebarScroll.innerHTML = `<div class="empty-state"><h3>无法连接本地服务</h3>
      <p>请确认服务进程仍在运行，然后刷新页面。</p></div>`;
  }
}

boot();
