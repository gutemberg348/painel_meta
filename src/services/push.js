import { generateVAPIDKeys, sendNotification } from 'web-push';
import { ECDH } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

// O servidor envia requisições somente aos serviços de push dos navegadores.
const endpoint = z.url({ protocol: /^https$/ }).max(4096).refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const trusted = /^(?:fcm\.googleapis\.com|(?:[a-z0-9-]+\.)*push\.apple\.com|(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com|(?:[a-z0-9-]+\.)*notify\.windows\.com)$/;
  return trusted.test(url.hostname) && !url.port && !url.username && !url.password;
}, 'Serviço de notificações incompatível.');
const subscription = z.object({
  endpoint,
  keys: z.object({
    auth: z.string().regex(/^[\w-]{22}$/),
    p256dh: z.string().regex(/^[\w-]{87}$/).refine(value => {
      try {
        ECDH.convertKey(Buffer.from(value, 'base64url'), 'prime256v1');
        return true;
      } catch {
        return false;
      }
    }),
  }),
});

export function pushAvailable(config) {
  return Boolean(config.apiToken);
}

// Guardar apenas códigos de diagnóstico conhecidos. O corpo bruto pode conter a inscrição.
const providerReasons = new Set([
  'BadTtl', 'BadUrgency', 'BadWebPushRequest', 'BadWebPushTopic', 'VapidPkHashMismatch',
  'BadAuthorizationHeader', 'BadJwtToken', 'BadVapidPublicKey', 'BadPath', 'IdleTimeout',
  'MethodNotAllowed', 'PayloadTooLarge', 'TooManyRequests', 'InternalServerError', 'ServiceUnavailable',
  'Shutdown', 'INVALID_ARGUMENT', 'UNREGISTERED', 'NOT_FOUND', 'PERMISSION_DENIED', 'UNAUTHENTICATED',
]);
function pushFailure(error, endpoint) {
  const host = new URL(endpoint).hostname;
  const provider = host.endsWith('.apple.com') ? 'Apple' : host === 'fcm.googleapis.com' ? 'Google' :
    host.endsWith('.mozilla.com') ? 'Mozilla' : 'Web Push';
  let body;
  try { body = JSON.parse(error.body); } catch { /* Alguns serviços respondem sem JSON. */ }
  const code = body?.reason || body?.error?.status;
  const reason = providerReasons.has(code) ? code :
    provider === 'Mozilla' && Number.isInteger(body?.errno) ? 'errno ' + body.errno : 'motivo não identificado';
  return { at: Date.now(), code: Number(error.statusCode) || 0, provider, reason };
}

function signingKeys(db) {
  let row = db.prepare("SELECT value FROM metadata WHERE key='pushVapid'").get();
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO metadata VALUES ('pushVapid', ?)").run(JSON.stringify(generateVAPIDKeys()));
    row = db.prepare("SELECT value FROM metadata WHERE key='pushVapid'").get();
  }
  return JSON.parse(row.value);
}

export function pushRouter(db, config, inboxChannels) {
  const router = Router();
  router.get('/', async (req, res) => {
    if (!pushAvailable(config)) return res.json({ publicKey: null, channels: [] });
    const channels = (await inboxChannels(res.locals.account)).map(c => ({ id: c.id, name: c.identity?.displayName || c.name || 'WhatsApp', number: c.numberFormatted || c.number || '' }));
    res.json({ publicKey: signingKeys(db).publicKey, channels });
  });
  router.put('/', rateLimit({ windowMs: 60000, limit: 40 }), async (req, res) => {
    if (!pushAvailable(config)) return res.status(503).json({ error: 'Conecte a conta FLW para receber avisos de mensagens.' });
    const sub = subscription.parse(req.body);
    const account = req.session.accountId || 'manager';
    const channels = await inboxChannels(res.locals.account);
    const channel = req.body.channelId ? channels.find(c => c.id === req.body.channelId) : channels.length === 1 && channels[0];
    if (!channel) return res.status(400).json({ error: 'Selecione o WhatsApp que deseja acompanhar.' });
    if (account !== 'manager' && !db.prepare('SELECT 1 FROM staff_users WHERE id=? AND active=1 AND version=?')
      .get(account, req.session.accountVersion)) return res.status(401).json({ error: 'Faça login novamente.' });
    db.transaction(() => {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND (account_id<>? OR channel IS NOT ?)').run(sub.endpoint, account, channel.id);
      db.prepare(`INSERT INTO push_subscriptions(endpoint,keys_json,account_id,sid,subscribed_at,channel) VALUES (?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET keys_json=excluded.keys_json, sid=excluded.sid`)
        .run(sub.endpoint, JSON.stringify(sub.keys), account, req.sessionID, Date.now(), channel.id);
    })();
    res.json({ ok: true });
  });
  router.delete('/', (req, res) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND account_id=?')
      .run(endpoint.parse(req.body.endpoint), req.session.accountId || 'manager');
    res.json({ ok: true });
  });
  return router;
}

export function startPushWorker(db, config) {
  let busy = false;
  const saveResult = db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)');
  async function deliver(row) {
    // Uma tentativa sem confirmação pode já ter chegado ao telefone.
    const claim = db.prepare('DELETE FROM push_deliveries WHERE endpoint=? AND event_id=?').run(row.endpoint, row.event_id);
    if (!claim.changes) return;
    try {
      const response = await sendNotification({ endpoint: row.endpoint, keys: JSON.parse(row.keys_json) }, row.event_id, {
        vapidDetails: { subject: config.publicUrl || 'https://totalk.testes-techcode.shop', ...signingKeys(db) },
        TTL: Math.max(0, Math.floor((row.expires_at - Date.now()) / 1000)), timeout: 8000,
      });
      saveResult.run('pushLastAccepted', JSON.stringify({ at: Date.now(), code: response.statusCode }));
    } catch (error) {
      const failure = pushFailure(error, row.endpoint);
      saveResult.run('pushLastFailure', JSON.stringify(failure));
      console.warn('Falha na entrega de push:', failure.provider, failure.code || 'rede', failure.reason);
      if ([404, 410].includes(error.statusCode)) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND keys_json=?').run(row.endpoint, row.keys_json);
      } else {
        const delay = Math.min(300000, 10000 * 2 ** Math.min(row.attempts, 5));
        if ((error.statusCode === 429 || error.statusCode >= 500) && Date.now() + delay < row.expires_at) {
          db.prepare(`INSERT OR IGNORE INTO push_deliveries(endpoint,event_id,next_attempt,attempts,expires_at,channel,session_id,message_time)
            SELECT endpoint,?,?,?,?,?,?,? FROM push_subscriptions WHERE endpoint=? AND keys_json=? AND channel=? AND subscribed_at<=?`)
            .run(row.event_id, Date.now() + delay, row.attempts + 1, row.expires_at, row.channel, row.session_id, row.message_time,
              row.endpoint, row.keys_json, row.channel, row.message_time);
        }
      }
    }
  }
  const timer = setInterval(async () => {
    if (busy || !pushAvailable(config)) return;
    busy = true;
    try {
      db.prepare('DELETE FROM push_deliveries WHERE expires_at<=?').run(Date.now());
      const due = db.prepare(`SELECT d.*, s.keys_json FROM push_deliveries d JOIN push_subscriptions s USING(endpoint)
        LEFT JOIN staff_users u ON u.id=s.account_id
        WHERE d.next_attempt<=? AND d.channel=s.channel AND (s.account_id='manager' OR
        (u.active=1 AND (u.role='sender' OR u.channel_id=lower(d.channel))))
        ORDER BY d.next_attempt, d.rowid LIMIT 16`).all(Date.now());
      await Promise.all(due.map(deliver));
    } finally {
      busy = false;
    }
  }, 5000);
  timer.unref();
  return { stop: () => clearInterval(timer), get busy() { return busy; } };
}
