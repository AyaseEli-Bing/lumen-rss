/** XML 解析器与订阅源归一化测试 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, children, firstChild, childText, textOf, stripHtml, decodeEntities, attrValue } from '../server/xml.js';
import { parseFeed, parseDate, resolveUrl, MAX_ITEMS_PER_FETCH } from '../server/feed-parser.js';

test('XML：基础元素、属性与嵌套', () => {
  const doc = parseXml('<a x="1"><b>hi</b><c y=\'2\'/></a>');
  const root = children(doc)[0];
  assert.equal(root.name, 'a');
  assert.equal(root.attrs.x, '1');
  assert.equal(childText(root, 'b'), 'hi');
  assert.equal(attrValue(firstChild(root, 'c'), 'y'), '2');
});

test('XML：CDATA 原样保留且不解码', () => {
  const doc = parseXml('<d><![CDATA[<p>a & b</p>]]></d>');
  assert.equal(textOf(children(doc)[0]), '<p>a & b</p>');
});

test('XML：实体与数字实体解码', () => {
  assert.equal(decodeEntities('a&amp;b&lt;c&gt;d&#233;&#x4e2d;'), 'a&b<c>d\u00e9\u4e2d');
  const doc = parseXml('<t>Tom &amp; Jerry &mdash; ok</t>');
  assert.equal(textOf(children(doc)[0]), 'Tom & Jerry \u2014 ok');
});

test('XML：命名空间前缀被忽略，local name 可比对', () => {
  const doc = parseXml('<rdf:RDF xmlns:rdf="x"><dc:creator>张三</dc:creator></rdf:RDF>');
  const root = children(doc)[0];
  assert.equal(root.local, 'rdf');
  assert.equal(childText(root, 'creator'), '张三');
});

test('XML：注释、处理指令、DOCTYPE 不影响解析', () => {
  const doc = parseXml('<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "y">]><!-- c --><rss><channel><title>T</title></channel></rss>');
  const root = children(doc)[0];
  assert.equal(root.name, 'rss');
  assert.equal(childText(firstChild(root, 'channel'), 'title'), 'T');
});

test('XML：标签未闭合时仍能取到已解析内容（容错）', () => {
  const doc = parseXml('<a><b>1</b><c>2');
  const root = children(doc)[0];
  assert.equal(childText(root, 'b'), '1');
  assert.equal(childText(root, 'c'), '2');
});

test('XML：保留文本与子节点顺序', () => {
  const doc = parseXml('<d>前<b>中</b>后</d>');
  assert.equal(textOf(children(doc)[0]), '前中后');
});

test('stripHtml：剥离标签、保留可读文本', () => {
  const html = '<div><script>bad()</script><p>Hello <b>world</b></p><p>第二段</p></div>';
  const text = stripHtml(html);
  assert.ok(!text.includes('bad()'));
  assert.ok(text.includes('Hello world'));
  assert.ok(text.includes('第二段'));
});

test('stripHtml：把块级标签边界转成换行', () => {
  assert.equal(stripHtml('<p>a</p><p>b</p>'), 'a\nb');
});

test('parseDate：RFC822 / ISO8601 / 无时区格式', () => {
  assert.equal(parseDate('Tue, 03 Jun 2003 09:39:21 GMT'), Date.UTC(2003, 5, 3, 9, 39, 21));
  assert.equal(parseDate('2003-06-03T09:39:21Z'), Date.UTC(2003, 5, 3, 9, 39, 21));
  assert.equal(parseDate('Mon, 05 Jan 2026 10:00:00 +0800'), Date.UTC(2026, 0, 5, 2, 0, 0));
  assert.equal(parseDate('24 Jan 2026 10:00:00 +0800'), Date.UTC(2026, 0, 24, 2, 0, 0));
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('not a date'), null);
});

test('parseDate：拒绝明显越界的时间（防止脏数据污染排序）', () => {
  assert.equal(parseDate('Mon, 01 Jan 1601 00:00:00 GMT'), null);
  assert.equal(parseDate(new Date(Date.now() + 400 * 86400000).toUTCString()), null);
});

test('resolveUrl：相对地址与协议相对地址', () => {
  assert.equal(resolveUrl('https://a.com/feed.xml', '/x/y'), 'https://a.com/x/y');
  assert.equal(resolveUrl('https://a.com/f/', 'p.html'), 'https://a.com/f/p.html');
  assert.equal(resolveUrl('https://a.com/', 'https://b.com/z'), 'https://b.com/z');
  assert.equal(resolveUrl('https://a.com/', ''), '');
});

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>科技观察</title>
    <link>https://example.com/</link>
    <description>每日技术摘要</description>
    <image><url>https://example.com/logo.png</url></image>
    <ttl>20</ttl>
    <item>
      <title>第一篇文章</title>
      <link>https://example.com/a</link>
      <guid isPermaLink="false">tag:a</guid>
      <pubDate>Tue, 03 Jun 2025 09:39:21 GMT</pubDate>
      <dc:creator>张三</dc:creator>
      <category>技术</category>
      <description><![CDATA[<p>摘要 <b>内容</b></p>]]></description>
      <content:encoded><![CDATA[<h1>正文</h1><p>完整内容</p>]]></content:encoded>
    </item>
    <item>
      <title>第二篇</title>
      <link>/rel/path</link>
      <guid>tag:b</guid>
      <pubDate>Wed, 04 Jun 2025 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

test('parseFeed：RSS 2.0 完整字段归一化', () => {
  const feed = parseFeed(RSS2, 'https://example.com/feed.xml');
  assert.equal(feed.format, 'rss');
  assert.equal(feed.title, '科技观察');
  assert.equal(feed.siteUrl, 'https://example.com/');
  assert.equal(feed.iconUrl, 'https://example.com/logo.png');
  assert.equal(feed.ttlMinutes, 20);
  assert.equal(feed.items.length, 2);

  const [first, second] = feed.items;
  assert.equal(first.guid, 'tag:a');
  assert.equal(first.title, '第一篇文章');
  assert.equal(first.author, '张三');
  assert.equal(first.link, 'https://example.com/a');
  assert.equal(first.publishedAt, Date.UTC(2025, 5, 3, 9, 39, 21));
  assert.ok(first.contentHtml.includes('<h1>正文</h1>'));
  assert.equal(first.summary, '正文\n完整内容');
  assert.deepEqual(first.categories, ['技术']);
  // 相对链接按 feed 地址解析
  assert.equal(second.link, 'https://example.com/rel/path');
});

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Meridian Notes</title>
  <subtitle>Design writing</subtitle>
  <link rel="self" type="application/atom+xml" href="https://d.example/atom.xml"/>
  <link rel="alternate" type="text/html" href="https://d.example/"/>
  <icon>https://d.example/icon.png</icon>
  <entry>
    <title type="html">Density &amp; rhythm</title>
    <id>urn:uuid:1</id>
    <link rel="alternate" type="text/html" href="https://d.example/p/1"/>
    <published>2025-07-01T08:00:00Z</published>
    <updated>2025-07-02T08:00:00Z</updated>
    <author><name>Mira</name></author>
    <summary type="text">Short summary</summary>
    <content type="html">&lt;p&gt;Body &lt;em&gt;text&lt;/em&gt;&lt;/p&gt;</content>
  </entry>
  <entry>
    <title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">XHTML <b>title</b></div></title>
    <id>urn:uuid:2</id>
    <link href="https://d.example/p/2"/>
    <updated>2025-07-03T08:00:00Z</updated>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Inline <strong>html</strong></p></div></content>
  </entry>
</feed>`;

test('parseFeed：Atom 1.0（含 html/xhtml 类型字段）', () => {
  const feed = parseFeed(ATOM, 'https://d.example/atom.xml');
  assert.equal(feed.format, 'atom');
  assert.equal(feed.title, 'Meridian Notes');
  assert.equal(feed.siteUrl, 'https://d.example/');
  assert.equal(feed.iconUrl, 'https://d.example/icon.png');
  assert.equal(feed.items.length, 2);

  const [first, second] = feed.items;
  assert.equal(first.guid, 'urn:uuid:1');
  assert.equal(first.title, 'Density & rhythm');
  assert.equal(first.link, 'https://d.example/p/1');
  assert.equal(first.author, 'Mira');
  assert.ok(first.contentHtml.includes('<em>text</em>'));
  assert.equal(first.publishedAt, Date.UTC(2025, 6, 1, 8, 0, 0));

  // xhtml 标题需要还原为纯文本，正文需要还原为 HTML
  assert.equal(second.title, 'XHTML title');
  assert.ok(second.contentHtml.includes('<strong>html</strong>'));
  assert.equal(second.publishedAt, Date.UTC(2025, 6, 3, 8, 0, 0));
});

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://r.example/feed">
    <title>RDF 源</title>
    <link>https://r.example/</link>
    <description>RSS 1.0</description>
  </channel>
  <item rdf:about="https://r.example/1">
    <title>RDF 条目</title>
    <link>https://r.example/1</link>
    <dc:date>2025-08-01T12:00:00Z</dc:date>
    <dc:creator>李四</dc:creator>
    <description>条目摘要</description>
  </item>
</rdf:RDF>`;

test('parseFeed：RSS 1.0 (RDF) 结构', () => {
  const feed = parseFeed(RDF, 'https://r.example/feed');
  assert.equal(feed.format, 'rdf');
  assert.equal(feed.title, 'RDF 源');
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].guid, 'https://r.example/1');
  assert.equal(feed.items[0].author, '李四');
  assert.equal(feed.items[0].publishedAt, Date.UTC(2025, 7, 1, 12, 0, 0));
});

test('parseFeed：同 guid 条目去重，保留信息更完整的一条', () => {
  const xml = `<rss><channel><title>T</title>
    <item><guid>same</guid><title>旧</title><description>简短</description></item>
    <item><guid>same</guid><title>新</title><description>更完整的描述</description></item>
  </channel></rss>`;
  const feed = parseFeed(xml, 'https://x.com/feed');
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].title, '新');
});

test('parseFeed：缺少 guid 时回退到 link', () => {
  const xml = '<rss><channel><title>T</title><item><title>A</title><link>https://x.com/1</link></item></channel></rss>';
  const feed = parseFeed(xml, 'https://x.com/feed');
  assert.equal(feed.items[0].guid, 'https://x.com/1');
});

test('parseFeed：单次抓取的条目数量有上限（防止超大源拖垮内存）', () => {
  const items = Array.from({ length: MAX_ITEMS_PER_FETCH + 60 }, (_, i) =>
    `<item><guid>g${i}</guid><title>t${i}</title></item>`).join('');
  const feed = parseFeed(`<rss><channel><title>T</title>${items}</channel></rss>`, 'https://x.com/feed');
  assert.equal(feed.items.length, MAX_ITEMS_PER_FETCH);
});

test('parseFeed：HTML 页面会抛出可识别的错误', () => {
  assert.throws(() => parseFeed('<!doctype html><html><body><h1>Not a feed</h1></body></html>', 'https://x.com/'),
    (err) => err.code === 'PARSE_UNKNOWN' || err.code === 'PARSE_EMPTY');
});
