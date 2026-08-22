/* ============================================================
   /api/chat —— 藏 key 的代理
   环境变量（在 Vercel 项目里设，绝不写进代码）：
     AI_API_KEY   必填
     ZZL_MODEL    可选，默认 gpt-5.6-sol
     ZZL_BASE     可选，默认 https://api.openai-next.com/v1
   换任何 OpenAI 协议的服务，只改这两个变量即可，代码不用动。
   ============================================================ */

const BASE  = process.env.ZZL_BASE  || 'https://api.openai-next.com/v1';
const MODEL = process.env.ZZL_MODEL || 'gpt-5.6-sol';

/* 轻量限流：单实例内存计数。挡不住分布式刷，但足够挡住手滑和脚本小子。 */
const HITS = new Map();
const WINDOW = 60_000, MAX_PER_WINDOW = 25;

function throttled(ip) {
  const now = Date.now();
  const rec = HITS.get(ip);
  if (!rec || now - rec.t > WINDOW) { HITS.set(ip, { t: now, n: 1 }); return false; }
  rec.n++;
  if (HITS.size > 2000) HITS.clear();
  return rec.n > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.AI_API_KEY || process.env.MINIMAX_API_KEY;
  if (!key) return res.status(500).json({ error: '服务端没配 AI_API_KEY' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (throttled(ip)) return res.status(429).json({ error: '慢一点，你已经很会拖了' });

  const { messages, schema, name } = req.body || {};
  if (!Array.isArray(messages) || !messages.length || messages.length > 20)
    return res.status(400).json({ error: 'bad messages' });

  const total = messages.reduce((n, m) => n + String(m?.content || '').length, 0);
  if (total > 12000) return res.status(400).json({ error: 'too long' });

  const clean = messages
    .filter(m => ['system', 'user', 'assistant'].includes(m.role))
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 6000) }));

  /* 这个中转会静默忽略 response_format:json_object，但严格执行 json_schema。
     所以首选 schema，失败再逐级降级，保证一局不会因为格式问题卡死。 */
  const base = { model: MODEL, temperature: 0.85, max_tokens: 900, messages: clean };
  const full = schema
    ? { ...base, response_format: { type: 'json_schema',
        json_schema: { name: String(name || 'out').slice(0, 40), strict: true, schema } } }
    : base;
  const loose   = { ...base, response_format: { type: 'json_object' } };
  const minimal = { model: MODEL, messages: clean };

  async function ask(payload, ms) {
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(kill); }
  }

  try {
    let r = await ask(full, 26_000);

    /* 上游嫌参数不合口味（400/422）时，退回最小请求体再试一次，别让一局卡死 */
    if (r.status === 400 || r.status === 422) {
      console.warn('[zzl] 上游拒绝 json_schema，降级到 json_object');
      r = await ask(loose, 26_000);
    }
    if (r.status === 400 || r.status === 422) {
      console.warn('[zzl] 上游还是拒绝，退回最小请求体');
      r = await ask(minimal, 26_000);
    }

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      console.error('[zzl] upstream', r.status, detail);
      return res.status(502).json({ error: 'upstream ' + r.status });
    }

    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content ?? '';
    if (!text) return res.status(502).json({ error: 'empty' });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ text });
  } catch (e) {
    console.error('[zzl] proxy', e?.name, e?.message);
    return res.status(502).json({ error: e?.name === 'AbortError' ? 'timeout' : 'proxy failed' });
  }
}
