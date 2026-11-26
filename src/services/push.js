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
  return Boolean(config.publicUrl && config.webhookSecret && config.apiToken);
}

function signingKeys(db) {
  let row = db.prepare("SELECT value FROM metadata WHERE key='pushVapid'").get();
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO metadata VALUES ('pushVapid', ?)").run(JSON.stringify(generateVAPIDKeys()));
    row = db.prepare("SELECT value FROM metadata WHERE key='pushVapid'").get();
  }
  return JSON.parse(row.value);
}

export function pushRouter(db, config) {
  const router = Router();
  router.get('/', (req, res) => res.json({ publicKey: pushAvailable(config) ? signingKeys(db).publicKey : null }));
  router.put('/', rateLimit({ windowMs: 60000, limit: 40 }), (req, res) => {
    if (!pushAvailable(config)) return res.status(503).json({ error: 'Configure a integração de notificações na VPS.' });
    const sub = subscription.parse(req.body);
    db.prepare(`INSERT INTO push_subscriptions(endpoint,keys_json,account_id,sid) VALUES (?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET keys_json=excluded.keys_json, sid=excluded.sid,
      pending_event=CASE WHEN account_id=excluded.account_id THEN pending_event END, account_id=excluded.account_id`)
      .run(sub.endpoint, JSON.stringify(sub.keys), req.session.accountId || 'manager', req.sessionID);
    res.json({ ok: true });
  });
  router.delete('/', (req, res) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND account_id=?')
      .run(endpoint.parse(req.body.endpoint), req.session.accountId || 'manager');
    res.json({ ok: true });
  });
  return router;
}

// Cada aparelho precisa de apenas um aviso pendente para abrir a caixa de entrada.
export function startPushWorker(db, config) {
  let busy = false;
  async function deliver(row) {
    try {
      await sendNotification({ endpoint: row.endpoint, keys: JSON.parse(row.keys_json) }, 'inbox', {
        vapidDetails: { subject: config.publicUrl, ...signingKeys(db) }, TTL: 3600, timeout: 8000,
      });
      db.prepare('UPDATE push_subscriptions SET pending_event=NULL WHERE endpoint=? AND pending_event=?')
        .run(row.endpoint, row.pending_event);
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND keys_json=?').run(row.endpoint, row.keys_json);
      } else {
        const delay = Math.min(300000, 10000 * 2 ** Math.min(row.attempts, 5));
        db.prepare(`UPDATE push_subscriptions SET attempts=attempts+1, next_attempt=?,
          pending_event=CASE WHEN attempts < 10 THEN pending_event END WHERE endpoint=? AND pending_event=?`)
          .run(Date.now() + delay, row.endpoint, row.pending_event);
        console.warn('Falha na entrega de push. Código:', error.statusCode || 'rede');
      }
    }
  }
  const timer = setInterval(async () => {
    if (busy || !pushAvailable(config)) return;
    busy = true;
    try {
      const due = db.prepare('SELECT * FROM push_subscriptions WHERE pending_event IS NOT NULL AND next_attempt<=? ORDER BY next_attempt LIMIT 16').all(Date.now());
      await Promise.all(due.map(deliver));
    } finally {
      busy = false;
    }
  }, 5000);
  timer.unref();
  return { stop: () => clearInterval(timer), get busy() { return busy; } };
}
