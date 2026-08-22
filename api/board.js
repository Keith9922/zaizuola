/* ============================================================
   /api/board —— 共享排行榜（Cloudflare KV）

   环境变量（Vercel 项目里设）：
     CF_ACCOUNT_ID     Cloudflare 账号 ID
     CF_KV_TOKEN       带 Workers KV Storage · Edit 权限的 API token
     CF_KV_NAMESPACE   namespace ID

   没配这三个 → 返回 503 + not_configured，前端自动退回 localStorage，
   游戏照常能玩，只是各玩各的。

   Key 设计：e:{9999999-拖延值 补零7位}:{随机id}
   KV 的 list 按字典序升序返回，所以这样排出来正好是拖延值降序，
   一次 list 就能拿到 Top N，不用逐条 GET。记录本体放在 key 的 metadata 里。
   ============================================================ */

export const config = { maxDuration: 15 };

const ACCT  = process.env.CF_ACCOUNT_ID;
const TOKEN = process.env.CF_KV_TOKEN;
const NS    = process.env.CF_KV_NAMESPACE;
const API   = 'https://api.cloudflare.com/client/v4';

const ready = () => Boolean(ACCT && TOKEN && NS);
const base  = () => `${API}/accounts/${ACCT}/storage/kv/namespaces/${NS}`;
const auth  = () => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });

const SCORE_CAP = 9999999;
const rankKey = score => String(SCORE_CAP - Math.min(Math.max(score, 0), SCORE_CAP)).padStart(7, '0');

/* 粗暴限流：单实例内存计数，挡手滑和脚本小子 */
const HITS = new Map();
function throttled(ip, max, windowMs) {
  const now = Date.now();
  const r = HITS.get(ip);
  if (!r || now - r.t > windowMs) { HITS.set(ip, { t: now, n: 1 }); return false; }
  r.n++;
  if (HITS.size > 3000) HITS.clear();
  return r.n > max;
}

/* 外来输入一律当敌意处理：去控制字符和尖括号、限长 */
const CTRL = new RegExp('[\\u0000-\\u001f\\u007f<>]', 'g');
const clean = (v, max) => String(v == null ? '' : v).replace(CTRL, '').trim().slice(0, max);
const int = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!ready()) {
    return res.status(503).json({
      error: 'not_configured',
      hint: '缺 CF_ACCOUNT_ID / CF_KV_TOKEN / CF_KV_NAMESPACE',
    });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  try {
    if (req.method === 'GET')  return await list(req, res, ip);
    if (req.method === 'POST') return await submit(req, res, ip);
    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    console.error('[zzl/board]', e && e.name, e && e.message);
    return res.status(502).json({ error: 'board unavailable' });
  }
}

/* ---------- 读榜 + 统计 ---------- */
async function list(req, res, ip) {
  if (throttled('g:' + ip, 60, 60000)) return res.status(429).json({ error: '慢一点' });

  const limit = int(req.query && req.query.limit, 1, 200, 50);

  /* 最多翻 3 页（3000 条）算统计，超过就只统计这些——派对场景远够 */
  let cursor = '', rows = [], pages = 0;
  do {
    const url = `${base()}/keys?limit=1000&prefix=e%3A` +
                (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const r = await fetch(url, { headers: auth() });
    if (!r.ok) throw new Error('kv list ' + r.status);
    const d = await r.json();
    if (!d.success) throw new Error('kv list failed');
    for (const k of d.result || []) if (k.metadata) rows.push(k.metadata);
    cursor = (d.result_info && d.result_info.cursor) || '';
    pages++;
  } while (cursor && pages < 3);

  /* KV 的 list 已按 key 升序 = 拖延值降序，这里只做兜底再排一次 */
  rows.sort((a, b) => (b.p || 0) - (a.p || 0) || (b.d || 0) - (a.d || 0));

  const total = rows.reduce((a, r) => a + (r.p || 0), 0);
  const byScenario = {};
  rows.forEach(r => { if (r.s) byScenario[r.s] = (byScenario[r.s] || 0) + 1; });
  const top = Object.entries(byScenario).sort((a, b) => b[1] - a[1])[0];

  return res.status(200).json({
    source: 'kv',
    rows: rows.slice(0, limit),
    stats: {
      players:     rows.length,
      totalScore:  total,
      maxScore:    rows.length ? rows[0].p || 0 : 0,
      avgScore:    rows.length ? Math.round(total / rows.length) : 0,
      totalDays:   rows.reduce((a, r) => a + (r.d || 0), 0),
      totalPits:   rows.reduce((a, r) => a + (r.k || 0), 0),
      topScenario: top ? top[0] : '',
      truncated:   Boolean(cursor),
    },
  });
}

/* ---------- 上榜 ---------- */
async function submit(req, res, ip) {
  if (throttled('p:' + ip, 12, 60000)) return res.status(429).json({ error: '你已经很会拖了，慢点' });

  const b = req.body || {};
  const score = int(b.score, 0, SCORE_CAP, 0);
  const days  = int(b.days, 0, 9999, 0);

  /* 拖延值和天数得对得上——挡掉直接 POST 一个天文数字的。
     每天基础 10 + 借口最多 30，宽放到 2000/天，另给开坑留 1500 起底。 */
  if (score > days * 2000 + 1500) {
    return res.status(400).json({ error: '这个分数和天数对不上' });
  }

  /* metadata 上限 1024 字节，字段名用单字母，长文本截断 */
  const meta = {
    n:  clean(b.nick, 12) || '匿名鸽子',
    s:  clean(b.scenario, 10),
    w:  clean(b.who, 8),
    p:  score,
    d:  days,
    k:  int(b.pits, 1, 30, 1),
    t:  clean(b.title, 10),
    c:  clean(b.cause, 40),
    g:  b.legend ? 1 : 0,
    a:  Math.round((Number(b.avg) || 0) * 10) / 10,
    ts: Date.now(),
  };
  if (JSON.stringify(meta).length > 1000) meta.c = meta.c.slice(0, 16);

  const id  = Math.random().toString(36).slice(2, 9);
  const key = `e:${rankKey(score)}:${id}`;

  const r = await fetch(`${base()}/bulk`, {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify([{ key, value: '1', metadata: meta }]),
  });
  if (!r.ok) throw new Error('kv write ' + r.status);
  const d = await r.json();
  if (!d.success) throw new Error('kv write failed');

  return res.status(200).json({ ok: true, key });
}
