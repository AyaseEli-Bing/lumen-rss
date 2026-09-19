/**
 * HTTP 客户端封装（面向订阅源抓取）
 *
 * 稳定性要点：
 *  - 每次请求都有超时（AbortController），不会因为某个源挂起而拖住整个调度
 *  - 响应体按 maxBytes 截断读取，恶意/异常的超大响应不会吃光内存
 *  - 支持 ETag / Last-Modified 条件请求，304 直接跳过解析与写库
 *  - 对网络错误、408/425/429/5xx 做指数退避 + 抖动重试
 *  - 依据 Content-Type / XML 声明嗅探字符编码（中文源常见 GBK/GB18030）
 */

const DEFAULT_UA = 'LumenRSS/1.0 (+local reader; node-fetch)';
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509, 522, 524]);

export class FetchError extends Error {
  constructor(message, { code = 'FETCH_ERROR', status = null, retryable = false } = {}) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readCapped(response, maxBytes) {
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(Buffer.from(value).subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (truncated) { try { await reader.cancel(); } catch { /* 已中断 */ } }
  }
  return Buffer.concat(chunks);
}

/** 从 Content-Type 与 XML/HTML 声明里推断字符集。 */
export function detectCharset(buffer, contentType = '') {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1].toLowerCase();

  const head = buffer.subarray(0, 2048).toString('latin1');
  const fromXml = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
  if (fromXml) return fromXml[1].toLowerCase();
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (fromMeta) return fromMeta[1].toLowerCase();
  return 'utf-8';
}

export function decodeBuffer(buffer, contentType = '') {
  const charset = detectCharset(buffer, contentType);
  const normalized = /^(gb2312|gbk)$/i.test(charset) ? 'gb18030' : charset;
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

/**
 * 单次 GET（含超时与截断），不做重试。
 * @returns {Promise<{status:number, headers:Headers, buffer:Buffer, finalUrl:string, notModified:boolean}>}
 */
export async function httpGet(url, options = {}) {
  const {
    timeoutMs = 20000,
    maxBytes = 8 * 1024 * 1024,
    etag = null,
    lastModified = null,
    userAgent = DEFAULT_UA,
    accept = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    signal = null
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('请求超时'), { name: 'TimeoutError' })), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const headers = {
    'User-Agent': userAgent,
    Accept: accept,
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache'
  };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    });

    if (response.status === 304) {
      return { status: 304, headers: response.headers, buffer: Buffer.alloc(0), finalUrl: response.url || url, notModified: true };
    }

    const buffer = await readCapped(response, maxBytes);
    return { status: response.status, headers: response.headers, buffer, finalUrl: response.url || url, notModified: false };
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      const timedOut = name === 'TimeoutError';
      throw new FetchError(timedOut ? `请求超时（${timeoutMs}ms）` : '请求已取消', {
        code: timedOut ? 'TIMEOUT' : 'ABORTED',
        retryable: timedOut
      });
    }
    const cause = err?.cause?.code || err?.code || '';
    throw new FetchError(`网络错误：${err?.cause?.message || err?.message || cause || '未知'}`, {
      code: cause || 'NETWORK',
      retryable: true
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 带退避重试的抓取。
 * @returns {Promise<{notModified:boolean, body:string, etag:string, lastModified:string, status:number, finalUrl:string}>}
 */
export async function fetchFeedDocument(url, options = {}) {
  const { retries = 2, baseDelayMs = 800, maxDelayMs = 8000, onAttempt = null, ...rest } = options;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw new FetchError('请求已取消', { code: 'ABORTED' });

    try {
      const res = await httpGet(url, rest);
      onAttempt?.({ attempt, status: res.status });

      if (res.notModified) {
        return {
          notModified: true, body: '', status: 304, finalUrl: res.finalUrl,
          etag: res.headers.get('etag') || rest.etag || '',
          lastModified: res.headers.get('last-modified') || rest.lastModified || ''
        };
      }

      if (res.status < 200 || res.status >= 300) {
        const retryable = RETRYABLE_STATUS.has(res.status);
        const err = new FetchError(`服务端返回 HTTP ${res.status}`, { code: `HTTP_${res.status}`, status: res.status, retryable });
        if (retryable && attempt < retries) {
          await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, res.headers.get('retry-after')));
          lastError = err;
          continue;
        }
        throw err;
      }

      const contentType = res.headers.get('content-type') || '';
      const body = decodeBuffer(res.buffer, contentType);
      if (!body.trim()) {
        throw new FetchError('响应内容为空', { code: 'EMPTY_BODY', status: res.status, retryable: false });
      }

      return {
        notModified: false,
        body,
        status: res.status,
        finalUrl: res.finalUrl,
        etag: res.headers.get('etag') || '',
        lastModified: res.headers.get('last-modified') || ''
      };
    } catch (err) {
      lastError = err;
      const retryable = err instanceof FetchError ? err.retryable : true;
      if (!retryable || attempt >= retries) throw err;
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }

  throw lastError || new FetchError('未知抓取失败');
}

/** 指数退避 + 抖动；若服务端给了 Retry-After 则优先遵从。 */
export function backoffDelay(attempt, base = 800, max = 8000, retryAfter = null) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60000));
  }
  const exp = Math.min(max, base * 2 ** attempt);
  const jitter = exp * 0.3 * Math.random();
  return Math.round(exp - exp * 0.15 + jitter);
}

/** 失败次数 → 下次调度延迟：间隔 × 2^n，封顶 24 小时，避免对挂掉的源高频重试。 */
export function penaltyMinutes(errorCount, baseInterval) {
  if (errorCount <= 0) return baseInterval;
  return Math.min(baseInterval * 2 ** Math.min(errorCount, 20), 24 * 60);
}

export { DEFAULT_UA };
