/* ============================================================
   《在做啦》共享排行榜 · 独立服务
   跑在 111.228.10.194:4680，由 pm2 守护。

   为什么不用 Redis：单进程 Node 的事件循环天然把写串行化了，
   不存在并发竞争。一个 JSONL 追加文件就够，还能直接 cat 看、直接备份。
   （机器上的 Redis 是空的，将来要多进程再说。）

   为什么不挂 nginx：这台机器上有十几个服务在 nginx 后面，
   而且没有 default_server，加 server block 会改变未匹配域名的落点。
   独立端口对现有服务零影响。

   写接口要 x-zzl-secret 头；读接口公开。
   ============================================================ */

import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';

const PORT   = Number(process.env.ZZL_PORT || 4680);
const DIR    = process.env.ZZL_DIR || '/opt/zzl-board';
const FILE   = path.join(DIR, 'board.jsonl');
const SECRET = process.env.ZZL_SECRET || '';

const CTRL  = new RegExp('[\\u0000-\\u001f\\u007f<>]', 'g');
const clean = (v, max) => String(v == null ? '' : v).replace(CTRL, '').trim().slice(0, max);
const int = (v, lo, hi, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/* ---------- 落盘 ---------- */
fs.mkdirSync(DIR, { recursive: true });
let rows = [];
try {
  rows = fs.readFileSync(FILE, 'utf8').split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch (e) { return null } })
    .filter(Boolean);
} catch (e) { /* 首次启动没有文件，正常 */ }
console.log(`[zzl-board] 载入 ${rows.length} 条记录`);

const append = rec => {
  rows.push(rec);
  fs.appendFileSync(FILE, JSON.stringify(rec) + '\n');
};

/* ---------- 统计 ---------- */
function tally(list) {
  const total = list.reduce((a, r) => a + (r.score || 0), 0);
  const by = {};
  list.forEach(r => { if (r.scenario) by[r.scenario] = (by[r.scenario] || 0) + 1; });
  const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  return {
    players:     list.length,
    totalScore:  total,
    maxScore:    list.length ? Math.max(...list.map(r => r.score || 0)) : 0,
    avgScore:    list.length ? Math.round(total / list.length) : 0,
    totalDays:   list.reduce((a, r) => a + (r.days || 0), 0),
    totalPits:   list.reduce((a, r) => a + (r.pits || 0), 0),
    topScenario: top ? top[0] : '—',
  };
}

/* ---------- 限流 ---------- */
const HITS = new Map();
function throttled(k, max, win) {
  const now = Date.now(), r = HITS.get(k);
  if (!r || now - r.t > win) { HITS.set(k, { t: now, n: 1 }); return false; }
  r.n++;
  if (HITS.size > 5000) HITS.clear();
  return r.n > max;
}

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-zzl-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

const server = http.createServer((req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (url.pathname === '/health') return send(res, 200, { ok: true, rows: rows.length, up: process.uptime() | 0 });

  if (url.pathname !== '/board') return send(res, 404, { error: 'not found' });

  /* ----- 读榜 ----- */
  if (req.method === 'GET') {
    if (throttled('g:' + ip, 120, 60000)) return send(res, 429, { error: '慢一点' });
    const limit = int(url.searchParams.get('limit'), 1, 200, 50);
    const sorted = rows.slice().sort((a, b) => (b.score || 0) - (a.score || 0) || (b.avg || 0) - (a.avg || 0));
    return send(res, 200, { source: 'server', rows: sorted.slice(0, limit), stats: tally(sorted) });
  }

  /* ----- 上榜 ----- */
  if (req.method === 'POST') {
    if (SECRET && req.headers['x-zzl-secret'] !== SECRET) return send(res, 401, { error: 'unauthorized' });
    if (throttled('p:' + ip, 30, 60000)) return send(res, 429, { error: '你已经很会拖了，慢点' });

    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 4096) { req.destroy(); }
    });
    req.on('end', () => {
      let b;
      try { b = JSON.parse(raw) } catch (e) { return send(res, 400, { error: 'bad json' }) }

      const score = int(b.score, 0, 9999999, 0);
      const days  = int(b.days, 0, 9999, 0);
      /* 分数和天数得对得上，挡掉直接 POST 天文数字刷榜的 */
      if (score > days * 2000 + 1500) return send(res, 400, { error: '这个分数和天数对不上' });

      const rec = {
        nick:     clean(b.nick, 12) || '匿名鸽子',
        scenario: clean(b.scenario, 10),
        who:      clean(b.who, 8),
        score, days,
        pits:   int(b.pits, 1, 30, 1),
        title:  clean(b.title, 10),
        cause:  clean(b.cause, 40),
        legend: Boolean(b.legend),
        avg:    Math.round((Number(b.avg) || 0) * 10) / 10,
        at:     Date.now(),
      };
      append(rec);
      console.log(`[zzl-board] +1 ${rec.nick} ${rec.score} 分 / ${rec.days} 天 (共 ${rows.length})`);
      const rank = rows.slice().sort((a, b) => b.score - a.score).findIndex(r => r.at === rec.at && r.nick === rec.nick) + 1;
      return send(res, 200, { ok: true, rank, total: rows.length });
    });
    return;
  }

  return send(res, 405, { error: 'GET or POST only' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`[zzl-board] 监听 0.0.0.0:${PORT}`));
