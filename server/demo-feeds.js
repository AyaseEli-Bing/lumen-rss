/**
 * 内置示例订阅源（由本机服务直接提供）
 *
 * 目的：让应用在完全离线的环境下也能立刻看到完整的订阅 → 抓取 → 阅读链路，
 * 同时覆盖 RSS 2.0 / Atom 1.0 / RSS 1.0(RDF) 三种格式，验证解析器的兼容性。
 * 这些源可以随时在界面上删掉，不影响真实订阅。
 */
import { escapeXml } from './xml.js';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ago = (ms) => new Date(Date.now() - ms);

const TECH_ITEMS = [
  {
    offset: 35 * MINUTE,
    title: 'HTTP 条件请求在订阅抓取中的实际收益',
    author: '编辑部',
    summary: '我们统计了两千个 RSS 源，87% 的轮询其实什么都不会变。ETag 与 Last-Modified 能把无效传输和解析开销压到接近零。',
    html: `<p>订阅阅读器最常见的性能误区，是把它当成「定时下载」。</p>
<p>实际上<strong>绝大多数轮询的结果是「内容没变」</strong>。我们在两千个源上跑了一周的统计：87% 的请求返回的是与上次完全一致的内容，其中又有六成可以通过 <code>ETag</code> / <code>Last-Modified</code> 直接判定为未修改。</p>
<h3>三个层次的节省</h3>
<ul>
<li><strong>带宽</strong>：304 响应通常只有几百字节，对比动辄 200KB 的完整 Feed，节省率超过 99%。</li>
<li><strong>CPU</strong>：省掉的是整棵 XML 树的构建与 400 条条目的归一化，这是抓取里最贵的部分。</li>
<li><strong>数据库</strong>：跳过写库意味着没有事务、没有索引维护，也没有 WAL 增长。</li>
</ul>
<blockquote><p>经验法则：把「上一次的 ETag 与 Last-Modified 一起存下来」，比任何缓存策略都简单有效。</p></blockquote>
<h3>需要注意的坑</h3>
<p>部分站点会返回<em>错误的</em> ETag（比如把时间戳当 ETag 每次都变），这时条件请求会永远命中不了。做法是记录命中率，长期为 0 的源降级为按时间轮询。</p>`
  },
  {
    offset: 3 * HOUR + 20 * MINUTE,
    title: '并发抓取：为什么单域名限速比总并发数更重要',
    author: '编辑部',
    summary: '把 200 个源一把并发打出去，只会换来大批 429。真正决定稳定性的，是「同一个域名同时只发几个请求」。',
    html: `<p>很多人把并发理解成一个数字：越大越快。对订阅抓取来说这个直觉是错的。</p>
<p>真正的问题是<strong>请求分布极不均匀</strong>——用户往往会订阅同一站点的多个栏目，于是十几个请求同时砸向同一个域名。</p>
<h3>双层限流的做法</h3>
<ul>
<li>全局并发上限：保护本机出口与内存，一般 6~10 就够。</li>
<li>单域名并发上限：通常 2，这是多数站点能接受的礼貌值。</li>
</ul>
<p>实现上队列不能是严格 FIFO，否则队首的繁忙域名会把后面空闲域名全堵住。正确做法是<strong>按域名择先</strong>：队首域名满了就跳过，先执行后面能跑的。</p>
<pre><code>queue.findIndex(task =&gt; globalHasRoom &amp;&amp; hostHasRoom(task.host))</code></pre>
<p>这样既守住了限速，吞吐也不会塌。</p>`
  },
  {
    offset: 9 * HOUR,
    title: '幂等入库：让重复抓取永远不会弄坏数据',
    author: '架构组',
    summary: '抓取是「至少一次」的语义，同一条文章可能被抓十次。入库必须写成幂等操作，且绝不能覆盖用户的已读与收藏。',
    html: `<p>抓取任务天然是「至少一次」的：超时重试、进程被杀后重跑、手动刷新与定时任务撞车，都会让同一条文章被处理多次。</p>
<p>因此入库语句必须满足两个条件：</p>
<ol>
<li><strong>同一篇文章只有一行</strong>。用 <code>sha1(feedId + guid)</code> 做主键，加 <code>UNIQUE(feed_id, guid)</code> 约束兜底。</li>
<li><strong>更新时不触碰用户态字段</strong>。抓取语句里只出现标题、正文、发布时间，<code>read</code> 与 <code>starred</code> 永远不出现在 <code>DO UPDATE SET</code> 中。</li>
</ol>
<p>还有一个容易忽略的细节：统计「新增了几篇」不能用 <code>changes()</code>，因为 upsert 的插入和更新都返回 1。可靠办法是在事务里对 <code>COUNT(*)</code> 取前后差值。</p>`
  },
  {
    offset: 26 * HOUR,
    title: '摘要不是截断：正文抽取的三种策略',
    author: '编辑部',
    summary: '按字符数硬截断会在标签中间切断，产生破碎的 HTML。正确做法是先剥离标签，再按语义边界收敛。',
    html: `<p>列表页里的摘要如果直接在原始 HTML 上截断，很容易切在 <code>&lt;a hr</code> 这种位置，渲染出来就是一片乱码。</p>
<h3>可用的顺序</h3>
<ol>
<li>剥掉 <code>script</code> / <code>style</code> / 注释；</li>
<li>把 <code>br</code>、<code>p</code>、<code>li</code> 的边界转成换行；</li>
<li>再去掉剩余标签、解码实体、压缩空白；</li>
<li>最后才按长度收敛。</li>
</ol>
<p>按这个顺序处理，摘要永远是合法文本，不会出现半个标签。</p>`
  },
  {
    offset: 2 * DAY + 5 * HOUR,
    title: '浏览器内核的进程模型为什么还在演化',
    author: '编辑部',
    summary: '从单进程到多进程，再到按站点隔离，每一次变化背后都是同一个权衡：安全性与内存占用。',
    html: `<p>浏览器每开一个标签页就多一个进程，这在桌面端早已是常识，但它的代价是被反复讨论的。</p>
<p>按站点隔离（Site Isolation）之后，跨站 iframe 也会拿到独立进程，安全性显著提升，内存占用则进一步上升。近年来的方向是<strong>让进程按需回收</strong>，把长时间不活跃的渲染进程挂起，需要时再恢复。</p>
<ul>
<li>收益：地址空间隔离，一个站的漏洞无法直接读到另一个站的数据。</li>
<li>代价：常驻内存增加，进程启动开销变成交互延迟的一部分。</li>
</ul>
<p>这个权衡没有终点，只有随硬件演进不断移动的平衡点。</p>`
  },
  {
    offset: 3 * DAY + 11 * HOUR,
    title: '把 SQLite 当作本地应用的第一选择',
    author: '架构组',
    summary: '单文件、无服务、支持事务与全文检索。对本地优先的应用来说，它几乎总是比 JSON 文件更合适。',
    html: `<p>本地应用常见的两种持久化：写 JSON 文件，或者上 SQLite。很多人因为「依赖更少」选了前者，直到数据量上来。</p>
<h3>JSON 文件的问题</h3>
<p>全量重写意味着每次保存都要序列化整个数据集；一旦进程在写盘中途被杀，文件就损坏了。要做得稳，就得自己实现「写临时文件 + 原子重命名 + 备份」。</p>
<h3>SQLite 给出的东西</h3>
<ul>
<li>事务与崩溃恢复（WAL）；</li>
<li>唯一约束，替你把幂等逻辑兜住；</li>
<li>索引，让「按时间倒序取 40 条」始终是常数级开销；</li>
<li>外键级联，删源等于自动清理文章。</li>
</ul>
<p>当这些需求出现两个以上时，SQLite 就已经赢了。</p>`
  }
];

const DESIGN_ITEMS = [
  {
    offset: 55 * MINUTE,
    title: 'Reading interfaces should disappear',
    author: 'Mira Chen',
    summary: 'A reader’s job is to get out of the way. Every control that stays visible must earn its place by being used more than once a session.',
    html: `<p>A reading interface has one primary job: <strong>make the text reachable</strong>. Everything else is overhead.</p>
<p>That is why the strongest reading apps converge on a similar shape — a narrow list, a wide column, and almost nothing else.</p>
<h3>What earns permanence</h3>
<ul>
<li>Unread state, because it is the only navigation model that survives a week away.</li>
<li>Search, because memory is unreliable and archives grow.</li>
<li>Save for later, because attention is not always available.</li>
</ul>
<p>Anything beyond that — tag clouds, reading statistics, social counters — is better hidden behind a shortcut than shown by default.</p>`
  },
  {
    offset: 7 * HOUR,
    title: 'The quiet cost of infinite scroll',
    author: 'Mira Chen',
    summary: 'Losing your place is not a rendering bug. It is a navigation model that has no concept of position.',
    html: `<p>Infinite scroll optimises for one thing: never letting the user reach a boundary. The cost is that there is no <em>place</em> to return to.</p>
<p>Paginated lists are slower to consume, but they give something scroll cannot: a stable address for "where I was".</p>
<blockquote><p>If you cannot answer "which page was I on", you do not have navigation — you have a treadmill.</p></blockquote>
<p>Our compromise: an explicit "load more" plus a remembered anchor offset, so position is always reconstructable.</p>`
  },
  {
    offset: 2 * DAY + 2 * HOUR,
    title: 'Density is a feature, not a compromise',
    author: 'Mira Chen',
    summary: 'Spacious layouts photograph well. Dense ones get used. Information products should optimise for the second.',
    html: `<p>Marketing pages and information tools want opposite things. In a tool, whitespace is a tax paid on every scan.</p>
<p>Three densities, chosen explicitly rather than guessed:</p>
<ul>
<li><strong>Comfortable</strong> — titles wrap to two lines, generous padding.</li>
<li><strong>Compact</strong> — single-line titles, metadata on the right.</li>
<li><strong>Ultra</strong> — author and time folded into a tooltip.</li>
</ul>
<p>Keyboard shortcuts let a user switch without hunting through settings.</p>`
  },
  {
    offset: 4 * DAY + 6 * HOUR,
    title: 'Why we ship a local-first reader',
    author: 'Meridian Studio',
    summary: 'Your reading history is one of the most revealing datasets you own. It should not require an account.',
    html: `<p>A subscription list is a portrait: what you follow, when you read, what you save. Hosting that in someone else's database is a choice, and often an unnecessary one.</p>
<p>Local-first means the data lives in a single file on your disk, works offline, and survives the product being discontinued.</p>
<p>Export is not a feature bolted on for compliance — it is the architecture. OPML out, SQLite file in.</p>`
  }
];

const DATA_ITEMS = [
  {
    offset: 25 * MINUTE,
    title: '本周数据：抓取成功率与重试次数的关系',
    author: '数据组',
    summary: '把重试次数从 0 提到 2，成功率从 91.4% 提升到 98.7%；再往上加几乎没有边际收益。',
    html: `<p>我们对近一周的抓取日志做了归因分析，重点关注重试次数与最终成功率的关系。</p>
<table>
<thead><tr><th>重试次数</th><th>成功率</th><th>平均耗时</th></tr></thead>
<tbody>
<tr><td>0</td><td>91.4%</td><td>620ms</td></tr>
<tr><td>1</td><td>96.1%</td><td>1.4s</td></tr>
<tr><td>2</td><td>98.7%</td><td>2.6s</td></tr>
<tr><td>3</td><td>98.9%</td><td>5.1s</td></tr>
</tbody>
</table>
<p><strong>结论</strong>：2 次重试是拐点。第 3 次仅带来 0.2 个百分点的提升，却让平均耗时翻倍。</p>
<p>另外，失败里约 4 成是永久性的（404、域名失效、返回 HTML 页面），这类重试毫无意义，应当直接判失败并进入长退避。</p>`
  },
  {
    offset: 6 * HOUR + 40 * MINUTE,
    title: '失败退避：把无效请求压掉 73%',
    author: '数据组',
    summary: '对连续失败的源按 2 的幂放大轮询间隔，一周内有问题的源请求量下降七成，恢复正常的速度几乎没变。',
    html: `<p>固定间隔轮询对故障源非常不友好：一个挂了的站点会被每 30 分钟敲门一次，持续一整周。</p>
<p>改为指数退避后（<code>间隔 × 2^n</code>，上限 24 小时）：</p>
<ul>
<li>故障源的无效请求量下降 73%；</li>
<li>源恢复后的平均发现延迟从 32 分钟变为 19 分钟——因为多数源在进入长退避前就已经恢复。</li>
</ul>
<p>关键细节：<strong>一旦成功立即清零失败计数</strong>，否则一个偶发抖动会把源永久打进慢速通道。</p>`
  },
  {
    offset: 30 * HOUR,
    title: '用户行为：未读数是阅读器的核心指标',
    author: '产品分析',
    summary: '会话时长其实没什么参考价值，未读数的变化趋势才真正反映订阅列表是「在服务用户」还是「在堆积」。',
    html: `<p>我们跟踪了三类指标：会话时长、点击深度、未读数变化。</p>
<p>长期来看，只有未读数变化具备解释力。当未读持续单调增长时，用户通常在两到三周内放弃整理，随后停止打开应用。</p>
<h3>产品上的启示</h3>
<ul>
<li>把「全部标为已读」放在够顺手的位置，它不是作弊，是清理工具。</li>
<li>提供按文件夹、按源两种清理粒度。</li>
<li>收藏与未读必须解耦：收藏是长期资产，未读是待办队列。</li>
</ul>`
  },
  {
    offset: 6 * DAY + 3 * HOUR,
    title: '月度回顾：订阅源的平均寿命是 14 个月',
    author: '数据组',
    summary: '在一年的观测里，约 22% 的订阅源会停止更新或被删除。定期体检比事后清理更省力。',
    html: `<p>我们统计了每个源从添加到「连续 90 天无新文章」的间隔，中位数为 14 个月。</p>
<p>这意味着一个 100 源的订阅列表，每年约有 20 个源会实质失效。</p>
<p>因此我们建议每季度做一次体检：</p>
<ul>
<li>按「最后成功抓取时间」排序，找出长期失败的源；</li>
<li>对长期零新增的源降低轮询频率到 24 小时；</li>
<li>对彻底失效的源导出 OPML 备份后移除。</li>
</ul>`
  }
];

export const DEMO_SOURCES = [
  {
    key: 'tech',
    path: '/demo/tech.xml',
    format: 'rss',
    title: '科技观察（示例源）',
    folder: '示例订阅',
    intervalMin: 15,
    description: '工程实践与技术观察，本地示例源，用于演示 RSS 2.0 解析',
    siteUrl: '/demo/tech-site.html',
    items: TECH_ITEMS
  },
  {
    key: 'design',
    path: '/demo/design.atom',
    format: 'atom',
    title: 'Meridian Design Notes（示例源）',
    folder: '示例订阅',
    intervalMin: 30,
    description: 'Interface writing, local sample feed demonstrating Atom 1.0 parsing',
    siteUrl: '/demo/design-site.html',
    items: DESIGN_ITEMS
  },
  {
    key: 'data',
    path: '/demo/data.rdf',
    format: 'rdf',
    title: '增长数据周报（示例源）',
    folder: '示例订阅',
    intervalMin: 60,
    description: '数据分析与产品指标，本地示例源，用于演示 RSS 1.0 (RDF) 解析',
    siteUrl: '/demo/data-site.html',
    items: DATA_ITEMS
  }
];

function rfc822(date) {
  return date.toUTCString().replace('GMT', '+0000');
}

function renderRss(source, origin) {
  const items = source.items.map((item) => {
    const pub = ago(item.offset);
    return [
      '    <item>',
      `      <title>${escapeXml(item.title)}</title>`,
      `      <link>${origin}${source.path}#item-${encodeURIComponent(item.title).slice(0, 24)}</link>`,
      `      <guid isPermaLink="false">lumen-demo:${source.key}:${Buffer.from(item.title).toString('hex').slice(0, 20)}</guid>`,
      `      <pubDate>${rfc822(pub)}</pubDate>`,
      `      <dc:creator>${escapeXml(item.author)}</dc:creator>`,
      `      <category>示例</category>`,
      `      <description><![CDATA[${item.html}]]></description>`,
      '    </item>'
    ].join('\n');
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(source.title)}</title>
    <link>${origin}${source.siteUrl}</link>
    <description>${escapeXml(source.description)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${rfc822(new Date())}</lastBuildDate>
    <ttl>${source.intervalMin}</ttl>
${items}
  </channel>
</rss>`;
}

function renderAtom(source, origin) {
  const entries = source.items.map((item) => {
    const pub = ago(item.offset).toISOString();
    const link = `${origin}${source.path}#entry-${encodeURIComponent(item.title).slice(0, 24)}`;
    return [
      '  <entry>',
      `    <title type="text">${escapeXml(item.title)}</title>`,
      `    <id>lumen-demo:${source.key}:${Buffer.from(item.title).toString('hex').slice(0, 20)}</id>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(link)}"/>`,
      `    <published>${pub}</published>`,
      `    <updated>${pub}</updated>`,
      '    <author><name>Mira Chen</name></author>',
      `    <summary type="text">${escapeXml(item.summary)}</summary>`,
      `    <content type="html">${escapeXml(item.html)}</content>`,
      '  </entry>'
    ].join('\n');
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(source.title)}</title>
  <subtitle>${escapeXml(source.description)}</subtitle>
  <link rel="self" type="application/atom+xml" href="${origin}${source.path}"/>
  <link rel="alternate" type="text/html" href="${origin}${source.siteUrl}"/>
  <updated>${new Date().toISOString()}</updated>
  <id>lumen-demo:${source.key}</id>
  <icon>${origin}/favicon.svg</icon>
${entries}
</feed>`;
}

function renderRdf(source, origin) {
  const items = source.items.map((item, index) => {
    const rdfAbout = `${origin}${source.path}#item-${index}`;
    const pub = ago(item.offset).toISOString();
    return [
      '  <item rdf:about="' + rdfAbout + '">',
      `    <title>${escapeXml(item.title)}</title>`,
      `    <link>${rdfAbout}</link>`,
      `    <dc:date>${pub}</dc:date>`,
      `    <dc:creator>${escapeXml(item.author)}</dc:creator>`,
      `    <description><![CDATA[${item.summary}]]></description>`,
      `    <content:encoded><![CDATA[${item.html}]]></content:encoded>`,
      '  </item>'
    ].join('\n');
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/"
         xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel rdf:about="${origin}${source.path}">
    <title>${escapeXml(source.title)}</title>
    <link>${origin}${source.siteUrl}</link>
    <description>${escapeXml(source.description)}</description>
    <items>
      <rdf:Seq>
${source.items.map((_, i) => `        <rdf:li resource="${origin}${source.path}#item-${i}"/>`).join('\n')}
      </rdf:Seq>
    </items>
  </channel>
${items}
</rdf:RDF>`;
}

/** 渲染示例源正文。 */
export function renderDemoFeed(key, origin) {
  const source = DEMO_SOURCES.find((s) => s.key === key);
  if (!source) return null;
  if (source.format === 'atom') return { body: renderAtom(source, origin), contentType: 'application/atom+xml; charset=utf-8' };
  if (source.format === 'rdf') return { body: renderRdf(source, origin), contentType: 'application/rss+xml; charset=utf-8' };
  return { body: renderRss(source, origin), contentType: 'application/rss+xml; charset=utf-8' };
}

/** 首次启动时写入示例订阅（幂等：已存在则跳过）。 */
export function seedDemoSubscriptions(store, origin, logger = console) {
  let created = 0;
  let folderId = null;
  const existingFolders = store.listFolders();
  const demoFolder = existingFolders.find((f) => f.name === '示例订阅');
  folderId = demoFolder ? demoFolder.id : null;

  for (const source of DEMO_SOURCES) {
    const url = `${origin}${source.path}`;
    if (store.findByUrl(url)) continue;
    if (!folderId) {
      folderId = store.createFolder(source.folder).id;
    }
    const feed = store.addFeed({
      url,
      title: source.title,
      siteUrl: origin + source.siteUrl,
      description: source.description,
      folderId,
      intervalMin: source.intervalMin
    });
    created += 1;
    logger.log?.(`[seed] 已添加示例源：${source.title}`);
  }
  return { created, folderId };
}
