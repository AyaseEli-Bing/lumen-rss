/** 后端 API 封装：统一错误处理 + SSE 事件订阅 */

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body = null, options = {}) {
  const init = {
    method,
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  };
  if (body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    throw new ApiError('无法连接到本地服务，请确认服务仍在运行', 0, 'NETWORK');
  }

  const isJson = (response.headers.get('content-type') || '').includes('json');
  const payload = isJson ? await response.json().catch(() => ({})) : await response.text();

  if (!response.ok) {
    const message = (payload && payload.error) || `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status, payload?.code);
  }
  return payload;
}

export const api = {
  snapshot: () => request('GET', '/api/snapshot'),
  state: () => request('GET', '/api/state'),

  listArticles: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== '') qs.set(key, value);
    }
    return request('GET', `/api/articles?${qs.toString()}`);
  },
  getArticle: (id) => request('GET', `/api/articles/${id}`),
  patchArticle: (id, patch) => request('PATCH', `/api/articles/${id}`, patch),
  markAll: (payload) => request('POST', '/api/articles/mark-all', payload),

  addFeed: (payload) => request('POST', '/api/feeds', payload),
  updateFeed: (id, patch) => request('PATCH', `/api/feeds/${id}`, patch),
  deleteFeed: (id) => request('DELETE', `/api/feeds/${id}`),
  discoverFeed: (url) => request('POST', '/api/feeds/discover', { url }),
  reorderFeeds: (ids) => request('POST', '/api/feeds/reorder', { ids }),
  demoSources: () => request('GET', '/api/demo-sources'),

  listFolders: () => request('GET', '/api/folders'),
  createFolder: (name) => request('POST', '/api/folders', { name }),
  updateFolder: (id, patch) => request('PATCH', `/api/folders/${id}`, patch),
  deleteFolder: (id, moveTo = null) =>
    request('DELETE', `/api/folders/${id}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`),

  refresh: (payload = {}) => request('POST', '/api/refresh', payload),
  refreshFeed: (id) => request('POST', `/api/feeds/${id}/refresh`, {}),

  getSettings: () => request('GET', '/api/settings'),
  updateSettings: (patch) => request('PATCH', '/api/settings', patch),
  getLog: (limit = 30) => request('GET', `/api/log?limit=${limit}`),

  importOpml: (opml) => request('POST', '/api/opml', { opml }),
  opmlExportUrl: '/api/opml'
};

/** 订阅服务端事件流，返回关闭函数。断线由 EventSource 自动重连。 */
export function connectEvents(handlers = {}) {
  let source = null;
  let closed = false;
  let retryTimer = null;

  const open = () => {
    if (closed) return;
    source = new EventSource('/api/events');

    source.addEventListener('open', () => {
      handlers.onOpen?.();
    });

    const types = [
      'hello', 'feed:start', 'feed:done', 'feed:error',
      'batch:start', 'batch:progress', 'batch:done',
      'feeds:changed', 'folders:changed', 'articles:changed', 'settings:changed'
    ];
    for (const type of types) {
      source.addEventListener(type, (event) => {
        let data = {};
        try { data = JSON.parse(event.data); } catch { /* 忽略非 JSON 负载 */ }
        handlers.onEvent?.(type, data);
      });
    }

    source.addEventListener('error', () => {
      handlers.onError?.();
      // EventSource 自带重连，但本地服务重启后需要重建连接
      if (source.readyState === EventSource.CLOSED && !closed) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(open, 3000);
      }
    });
  };

  open();

  return () => {
    closed = true;
    clearTimeout(retryTimer);
    source?.close();
  };
}
