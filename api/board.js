/* ============================================================
   /api/board —— 共享排行榜的前置代理

   真正的数据在 111 服务器上（/opt/zzl-board，pm2 进程 zzl-board），
   经 Cloudflare Tunnel 暴露为 https://zaizuola-api.zhangrg.top。

   为什么中间要隔一层 Vercel 函数，而不是浏览器直连：
     · 同源，不用处理 CORS 和预检
     · 写接口的密钥能真的当密钥用（放浏览器里等于公开）
     · 换后端只改环境变量，前端一行不动

   环境变量：
     ZZL_BOARD_URL      默认 https://zaizuola-api.zhangrg.top
     ZZL_BOARD_SECRET   写接口密钥，和服务器上 pm2 的 ZZL_SECRET 一致
   ============================================================ */

export const config = { maxDuration: 15 };

const UPSTREAM = process.env.ZZL_BOARD_URL || 'https://zaizuola-api.zhangrg.top';
const SECRET   = process.env.ZZL_BOARD_SECRET || '';

async function call(path, init, ms) {
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(UPSTREAM + path, { ...init, signal: ctrl.signal });
  } finally { clearTimeout(kill); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit, 10) || 50));
      const r = await call(`/board?limit=${limit}`, { headers: { accept: 'application/json' } }, 12000);
      if (!r.ok) throw new Error('upstream ' + r.status);
      return res.status(200).json(await r.json());
    }

    if (req.method === 'POST') {
      const r = await call('/board', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SECRET ? { 'x-zzl-secret': SECRET } : {}),
        },
        body: JSON.stringify(req.body || {}),
      }, 12000);
      const d = await r.json().catch(() => ({ error: 'bad upstream response' }));
      return res.status(r.status).json(d);
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    console.error('[zzl/board]', e?.name, e?.message);
    /* 排行榜挂了不能影响游戏——前端拿到非 2xx 会自动退回 localStorage */
    return res.status(503).json({ error: 'board unavailable' });
  }
}
