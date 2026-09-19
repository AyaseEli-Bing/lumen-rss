/** 并发池、退避策略与 HTTP 客户端测试（含本地 mock 服务器） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createPool, hostOf, runAll } from '../server/pool.js';
import { backoffDelay, penaltyMinutes, fetchFeedDocument, httpGet, detectCharset, decodeBuffer, FetchError } from '../server/http.js';

test('并发池：全局并发上限被严格遵守', async () => {
  const pool = createPool({ limit: 3, perHost: 10 });
  let active = 0;
  let peak = 0;

  await Promise.all(Array.from({ length: 30 }, () => pool.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 8));
    active -= 1;
  }, 'a.com')));

  assert.ok(peak <= 3, `峰值并发 ${peak} 超过了上限 3`);
  assert.equal(pool.active, 0);
  assert.equal(pool.pending, 0);
});

test('并发池：单域名并发上限生效', async () => {
  const pool = createPool({ limit: 10, perHost: 2 });
  const perHostActive = new Map();
  let peakSameHost = 0;

  await Promise.all(Array.from({ length: 20 }, (_, i) => pool.run(async () => {
    const host = i % 2 === 0 ? 'busy.com' : 'other.com';
    const current = (perHostActive.get(host) || 0) + 1;
    perHostActive.set(host, current);
    if (host === 'busy.com') peakSameHost = Math.max(peakSameHost, current);
    await new Promise((r) => setTimeout(r, 6));
    perHostActive.set(host, perHostActive.get(host) - 1);
  }, i % 2 === 0 ? 'busy.com' : 'other.com')));

  assert.ok(peakSameHost <= 2, `同一域名峰值并发 ${peakSameHost} 超过上限 2`);
});

test('并发池：繁忙域名不会阻塞空闲域名的任务（按域名择先）', async () => {
  const pool = createPool({ limit: 2, perHost: 1 });
  const finished = [];

  const tasks = [
    pool.run(async () => { await new Promise((r) => setTimeout(r, 40)); finished.push('slow-busy'); }, 'busy.com'),
    pool.run(async () => { await new Promise((r) => setTimeout(r, 40)); finished.push('slow-busy-2'); }, 'busy.com'),
    pool.run(async () => { finished.push('fast-free'); }, 'free.com')
  ];

  await Promise.all(tasks);
  // 空闲域名的任务应当先于第二个 busy 任务完成
  assert.ok(finished.indexOf('fast-free') < finished.indexOf('slow-busy-2'));
});

test('并发池：单个任务抛错不会影响其它任务，也不会卡住队列', async () => {
  const pool = createPool({ limit: 2, perHost: 2 });
  const results = await runAll(pool, [
    async () => { throw new Error('boom'); },
    async () => 'ok-1',
    async () => 'ok-2'
  ], (t) => 'x.com');

  assert.ok(results[0].__error instanceof Error);
  assert.equal(results[1], 'ok-1');
  assert.equal(results[2], 'ok-2');
  assert.equal(pool.active, 0);
});

test('并发池：drain 能等到队列排空', async () => {
  const pool = createPool({ limit: 2, perHost: 1 });
  let done = 0;
  for (let i = 0; i < 6; i++) pool.run(async () => { await new Promise((r) => setTimeout(r, 5)); done += 1; }, 'h.com');
  await pool.drain();
  assert.equal(done, 6);
});

test('hostOf：域名解析与非法输入', () => {
  assert.equal(hostOf('https://Example.com/a/b'), 'example.com');
  assert.equal(hostOf('not a url'), '');
});

test('退避：指数增长且带抖动，并遵从 Retry-After', () => {
  const d0 = backoffDelay(0, 1000, 10000);
  const d3 = backoffDelay(3, 1000, 10000);
  assert.ok(d0 > 0 && d0 <= 1000 * 1.15);
  assert.ok(d3 > d0);
  assert.equal(backoffDelay(0, 1000, 10000, '3'), 3000);
  assert.ok(backoffDelay(0, 1000, 10000, new Date(Date.now() + 5000).toUTCString()) > 0);
});

test('退避：连续失败的源调度延迟被放大且有上限', () => {
  assert.equal(penaltyMinutes(0, 30), 30);
  assert.equal(penaltyMinutes(1, 30), 60);
  assert.equal(penaltyMinutes(2, 30), 120);
  assert.equal(penaltyMinutes(10, 30), 24 * 60);
});

test('字符集嗅探：Content-Type 优先，其次 XML 声明', () => {
  assert.equal(detectCharset(Buffer.from('<a/>'), 'text/xml; charset=gbk'), 'gbk');
  assert.equal(detectCharset(Buffer.from('<?xml version="1.0" encoding="GB2312"?><a/>'), ''), 'gb2312');
  assert.equal(detectCharset(Buffer.from('<a/>'), ''), 'utf-8');
});

test('字符集解码：GBK 中文源能被正确还原', () => {
  const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // "中文" 的 GBK 编码
  const decoded = decodeBuffer(gbkBytes, 'text/xml; charset=gbk');
  assert.equal(decoded, '中文');
});

// ---------------------------------------------------------------------------
// mock 订阅源服务
// ---------------------------------------------------------------------------
function startMockServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const FEED_BODY = '<rss version="2.0"><channel><title>Mock</title><item><guid>1</guid><title>A</title></item></channel></rss>';

test('HTTP：304 条件请求被识别，不再读取正文', async () => {
  let seenInm = null;
  const mock = await startMockServer((req, res) => {
    seenInm = req.headers['if-none-match'];
    if (seenInm === '"v1"') { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml', ETag: '"v1"' });
    res.end(FEED_BODY);
  });

  const first = await fetchFeedDocument(`${mock.base}/feed`, { retries: 0 });
  assert.equal(first.notModified, false);
  assert.equal(first.etag, '"v1"');

  const second = await fetchFeedDocument(`${mock.base}/feed`, { retries: 0, etag: first.etag });
  assert.equal(second.notModified, true);
  assert.equal(second.status, 304);
  assert.equal(second.body, '');

  await mock.close();
});

test('HTTP：gzip 响应被正确解压', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml', 'Content-Encoding': 'gzip' });
    res.end(gzipSync(Buffer.from(FEED_BODY)));
  });
  const result = await fetchFeedDocument(`${mock.base}/feed`, { retries: 0 });
  assert.ok(result.body.includes('<title>A</title>'));
  await mock.close();
});

test('HTTP：超过 maxBytes 的响应被截断，不会无限制读取', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(Buffer.alloc(200_000, 0x61));
  });
  const result = await httpGet(`${mock.base}/big`, { maxBytes: 10_000, timeoutMs: 5000 });
  assert.equal(result.buffer.length, 10_000);
  await mock.close();
});

test('HTTP：5xx 会重试并在恢复后成功', async () => {
  let attempts = 0;
  const mock = await startMockServer((req, res) => {
    attempts += 1;
    if (attempts < 3) { res.writeHead(503); res.end('busy'); return; }
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(FEED_BODY);
  });
  const result = await fetchFeedDocument(`${mock.base}/feed`, { retries: 3, baseDelayMs: 10, maxDelayMs: 30 });
  assert.equal(attempts, 3);
  assert.ok(result.body.includes('Mock'));
  await mock.close();
});

test('HTTP：404 属于永久失败，不重试', async () => {
  let attempts = 0;
  const mock = await startMockServer((req, res) => { attempts += 1; res.writeHead(404); res.end('nope'); });
  await assert.rejects(
    () => fetchFeedDocument(`${mock.base}/feed`, { retries: 3, baseDelayMs: 10 }),
    (err) => err instanceof FetchError && err.status === 404 && err.code === 'HTTP_404'
  );
  assert.equal(attempts, 1);
  await mock.close();
});

test('HTTP：请求超时被中断并归类为可重试错误', async () => {
  const mock = await startMockServer(() => { /* 故意不响应 */ });
  const started = Date.now();
  await assert.rejects(
    () => fetchFeedDocument(`${mock.base}/hang`, { retries: 0, timeoutMs: 120 }),
    (err) => err.code === 'TIMEOUT'
  );
  assert.ok(Date.now() - started < 2000);
  await mock.close();
});

test('HTTP：响应体为空时抛出可识别错误', async () => {
  const mock = await startMockServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end('   '); });
  await assert.rejects(
    () => fetchFeedDocument(`${mock.base}/empty`, { retries: 0 }),
    (err) => err.code === 'EMPTY_BODY'
  );
  await mock.close();
});

test('HTTP：域名无法解析时归类为网络错误且可重试', async () => {
  await assert.rejects(
    () => fetchFeedDocument('http://this-domain-should-not-exist.invalid/feed', { retries: 1, baseDelayMs: 10 }),
    (err) => err instanceof FetchError && err.retryable === true
  );
});
