// WEF Handoff backend — Vercel serverless function.
// Storage: Upstash Redis (free tier ~10k req/day, ~256MB). Each message keyed by message_id; per-recipient index.
// Auth: per-user bearer tokens stored in env (WEF_HANDOFF_TOKEN_IMANI / WEF_HANDOFF_TOKEN_TERESA).
// 2026-05-26 — first cut.
import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';

export const config = { runtime: 'nodejs' };

// Defensive: support any of the common Vercel-Upstash env var name patterns.
// Lazy so the diag endpoint still works even before storage is connected.
let _kv = null;
function kv() {
  if (_kv) return _kv;
  const url = process.env.kv_KV_REST_API_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.STORAGE_REST_API_URL || process.env.STORAGE_URL;
  const token = process.env.kv_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.STORAGE_REST_API_TOKEN || process.env.STORAGE_TOKEN;
  if (!url || !token) {
    throw new Error('Redis not configured. Expected KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_/STORAGE_ equivalents).');
  }
  _kv = new Redis({ url, token });
  return _kv;
}

const TOKENS = {
  imani: process.env.WEF_HANDOFF_TOKEN_IMANI,
  teresa: process.env.WEF_HANDOFF_TOKEN_TERESA,
  kori: process.env.WEF_HANDOFF_TOKEN_KORI,
};

function authenticate(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  const user = req.headers['x-wef-user'] || req.headers['X-Wef-User'];
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!user || !TOKENS[user]) return null;
  if (TOKENS[user] !== token) return null;
  return user;
}

const VALID_USERS = ['imani', 'teresa', 'kori'];

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.query?.diag === '1') {
    return res.status(200).json({
      env_keys_present: {
        WEF_HANDOFF_TOKEN_IMANI: !!process.env.WEF_HANDOFF_TOKEN_IMANI,
        WEF_HANDOFF_TOKEN_IMANI_len: (process.env.WEF_HANDOFF_TOKEN_IMANI || '').length,
        WEF_HANDOFF_TOKEN_TERESA: !!process.env.WEF_HANDOFF_TOKEN_TERESA,
        WEF_HANDOFF_TOKEN_KORI: !!process.env.WEF_HANDOFF_TOKEN_KORI,
        UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
        KV_REST_API_URL: !!process.env.KV_REST_API_URL,
      },
      tokens_loaded: { imani: !!TOKENS.imani, teresa: !!TOKENS.teresa, kori: !!TOKENS.kori, imani_len: (TOKENS.imani || '').length },
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const me = authenticate(req);
  if (!me) return res.status(401).json({ error: 'auth failed — check WEF_HANDOFF_TOKEN + x-wef-user header' });

  const { action, ...payload } = req.body || {};

  try {
    if (action === 'send') {
      const { to, subject, body, urgency = 'normal', ref } = payload;
      if (!VALID_USERS.includes(to)) return res.status(400).json({ error: `invalid 'to' — must be one of: ${VALID_USERS.join(', ')}` });
      if (to === me) return res.status(400).json({ error: 'cannot send to yourself' });
      if (!subject || subject.length > 200) return res.status(400).json({ error: 'subject required, ≤200 chars' });
      if (!body || body.length > 50000) return res.status(400).json({ error: 'body required, ≤50KB' });
      if (!['fyi', 'normal', 'urgent'].includes(urgency)) return res.status(400).json({ error: 'urgency: fyi | normal | urgent' });

      const id = randomUUID();
      const now = new Date().toISOString();
      const msg = { id, from: me, to, subject, body, urgency, ref: ref || null, created_at: now, read: false, read_at: null };

      // Store the message + add to recipient's inbox index (sorted set keyed by timestamp)
      const r = kv();
      await r.set(`msg:${id}`, msg);
      await r.zadd(`inbox:${to}`, { score: Date.now(), member: id });
      await r.zadd(`unread:${to}`, { score: Date.now(), member: id });
      return res.status(200).json({ ok: true, id });
    }

    if (action === 'debug') {
      const r = kv();
      const unreadByIdx = await r.zrange(`unread:${me}`, 0, -1);
      const inboxByIdx = await r.zrange(`inbox:${me}`, 0, -1);
      const unreadCount = await r.zcard(`unread:${me}`);
      return res.status(200).json({ me, unread_zrange_by_idx: unreadByIdx, inbox_zrange_by_idx: inboxByIdx, unread_zcard: unreadCount });
    }

    if (action === 'inbox') {
      const { unread_only = true, since, limit = 20 } = payload;
      const key = unread_only ? `unread:${me}` : `inbox:${me}`;
      const minScore = since ? new Date(since).getTime() : 0;
      const r = kv();
      // Upstash zrange wants numeric min/max for byScore. With rev:true, max/min args SWAP order.
      const maxScore = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year ahead
      const ids = await r.zrange(key, maxScore, minScore, { byScore: true, rev: true, count: Math.min(limit, 100), offset: 0 });
      if (!ids?.length) return res.status(200).json({ messages: [] });
      const messages = await Promise.all(ids.map(id => r.get(`msg:${id}`)));
      return res.status(200).json({ messages: messages.filter(Boolean) });
    }

    if (action === 'read') {
      const { message_id } = payload;
      if (!message_id) return res.status(400).json({ error: 'message_id required' });
      const msg = await kv().get(`msg:${message_id}`);
      if (!msg) return res.status(404).json({ error: 'message not found' });
      if (msg.to !== me && msg.from !== me) return res.status(403).json({ error: 'not your message' });
      return res.status(200).json({ message: msg });
    }

    if (action === 'ack') {
      const { message_id } = payload;
      if (!message_id) return res.status(400).json({ error: 'message_id required' });
      const r = kv();
      const msg = await r.get(`msg:${message_id}`);
      if (!msg) return res.status(404).json({ error: 'message not found' });
      if (msg.to !== me) return res.status(403).json({ error: 'can only ack messages sent to you' });
      msg.read = true;
      msg.read_at = new Date().toISOString();
      await r.set(`msg:${message_id}`, msg);
      await r.zrem(`unread:${me}`, message_id);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
