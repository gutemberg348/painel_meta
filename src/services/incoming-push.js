import { createHash } from 'node:crypto';

export function incomingEventId(id) {
  return createHash('sha256').update('MESSAGE_RECEIVED:' + id).digest('hex');
}

// O webhook e a consulta periódica podem encontrar a mesma mensagem.
export function recordPushEvent(db, eventId, type, messageTime) {
  db.transaction(() => {
    const saved = db.prepare('INSERT OR IGNORE INTO webhook_events VALUES (?,?,?)')
      .run(eventId, type, new Date().toISOString());
    if (saved.changes && Number.isFinite(messageTime)) {
      db.prepare(`INSERT INTO push_deliveries(endpoint,event_id)
        SELECT endpoint,? FROM push_subscriptions WHERE subscribed_at<=?`).run(eventId, messageTime);
    }
  })();
}

async function* itemsByPage(load, stopped) {
  for (let page = 1; !stopped(); page++) {
    const data = await load(page);
    if (!Array.isArray(data.items)) throw new Error('Página de mensagens inválida.');
    yield* data.items;
    if (!data.items.length || !(data.hasMorePages || data.totalPages > page)) return;
  }
}

export function startIncomingMonitor(db, flw, inboxChannels, config) {
  let stopped = false;
  let busy = false;
  let retryAt = 0;
  const cursor = db.prepare('SELECT value FROM metadata WHERE key=?');
  const saveCursor = db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)');
  async function scan(channel, subscribedAt) {
    const key = 'pushCursor:' + channel.id;
    const until = Date.now();
    // Sobreposição para mensagens indexadas com atraso. Após uma parada longa,
    // recupera avisos recentes, dentro do prazo de entrega do Web Push.
    const since = Math.max(subscribedAt, until - 3600000, Number(cursor.get(key)?.value || 0) - 15000);
    const after = new Date(since - 1).toISOString();
    const before = new Date(until + 1).toISOString();
    const sessions = itemsByPage(page => flw.sessions(channel.id, after, page), () => stopped);
    for await (const session of sessions) {
      if (stopped) return;
      if (!session.id || session.channelId?.toLowerCase() !== channel.id.toLowerCase()) continue;
      if (Date.parse(session.lastMessageIn) < since) continue;
      const messages = itemsByPage(page => flw.messages(session.id, page, { after, before }), () => stopped);
      for await (const message of messages) {
        const time = Date.parse(message.createdAt);
        if (message.direction === 'FROM_HUB' && message.id && time >= since && time <= until) {
          recordPushEvent(db, incomingEventId(message.id), 'MESSAGE_RECEIVED', time);
        }
      }
    }
    if (!stopped) saveCursor.run(key, String(until));
  }
  async function poll() {
    if (busy || stopped || !config.apiToken || Date.now() < retryAt) return;
    const first = db.prepare('SELECT MIN(subscribed_at) AS started FROM push_subscriptions').get().started;
    if (first === null) return;
    busy = true;
    try {
      for (const channel of await inboxChannels()) {
        if (stopped) break;
        try {
          await scan(channel, first);
        } catch (error) {
          if (error.status === 429) throw error;
          console.warn('Consulta de novas mensagens pendente neste canal. Código:', error.status || 'rede');
        }
      }
    } catch (error) {
      retryAt = Date.now() + 60000;
      console.warn('Consulta de notificações será retomada em um minuto. Código:', error.status || 'rede');
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(poll, 20000);
  timer.unref();
  return { stop() { stopped = true; clearInterval(timer); }, get busy() { return busy; } };
}
