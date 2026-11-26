import { createHash } from 'node:crypto';

export function incomingEventId(id) {
  return createHash('sha256').update('MESSAGE_RECEIVED:' + id).digest('hex');
}
const visibleTypes = new Set(['TEXT', 'STICKER', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'CONTACT', 'LOCATION', 'LIST', 'BUTTONS']);
export const pushLifetime = 90000;
export function customerMessage(message) {
  return typeof message.id === 'string' && Boolean(message.id.trim()) && message.direction === 'FROM_HUB' &&
    visibleTypes.has(message.type) && !message.userId && !message.templateId &&
    !['FAILED', 'DELETED'].includes(message.status) &&
    !['BOT', 'API', 'CAMPAIGN', 'OFFICE_HOURS', 'PAYMENT'].includes(message.origin) &&
    (message.type !== 'TEXT' || Boolean(message.text?.trim()));
}

// O webhook e a consulta periódica podem encontrar a mesma mensagem.
export function recordPushEvent(db, eventId, type, messageTime, channel = null, sessionId = null) {
  return db.transaction(() => {
    const saved = db.prepare('INSERT OR IGNORE INTO webhook_events VALUES (?,?,?)')
      .run(eventId, type, new Date().toISOString());
    if (!saved.changes || !Number.isFinite(messageTime) || messageTime < Date.now() - pushLifetime || messageTime > Date.now() + 5000) return false;
    db.prepare(`INSERT INTO push_deliveries(endpoint,event_id,expires_at,channel,session_id,message_time)
      SELECT endpoint,?,?,?,?,? FROM push_subscriptions s WHERE subscribed_at<=? AND s.channel=? AND NOT EXISTS
      (SELECT 1 FROM inbox_reads r JOIN inbox_sessions i ON i.channel=r.channel AND i.peer=r.peer
       WHERE r.account=s.account_id AND i.channel=? AND i.id=? AND r.seen_at>=?)
      ON CONFLICT(endpoint) DO UPDATE SET event_id=excluded.event_id,expires_at=excluded.expires_at,
      channel=excluded.channel,session_id=excluded.session_id,message_time=excluded.message_time,
      next_attempt=0,attempts=0 WHERE excluded.expires_at >= push_deliveries.expires_at`)
      .run(eventId, messageTime + pushLifetime, channel, sessionId, messageTime, messageTime, channel, channel, sessionId, messageTime);
    return true;
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

export function startIncomingMonitor(db, flw, inboxChannels, config, inboxChanged) {
  let stopped = false;
  let busy = false;
  let retryAt = 0;
  const started = Date.now();
  const cursor = db.prepare('SELECT value FROM metadata WHERE key=?');
  const saveCursor = db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)');
  async function scan(channel, subscribedAt) {
    const key = 'pushCursor:' + channel.id;
    const until = Date.now();
    const since = Math.max(started, subscribedAt, until - pushLifetime, Number(cursor.get(key)?.value || 0) - 15000);
    const after = new Date(since - 1).toISOString();
    const before = new Date(until + 1).toISOString();
    const sessions = itemsByPage(page => flw.sessions(channel.id, after, page), () => stopped);
    for await (const session of sessions) {
      if (stopped) return;
      if (!session.id || session.channelId?.toLowerCase() !== channel.id.toLowerCase()) continue;
      if (Date.parse(session.lastMessageIn) < since) continue;
      const messages = itemsByPage(page => flw.messages(session.id, page, { after, before }), () => stopped);
      for await (const message of messages) {
        const time = Date.parse(message.timestamp || message.createdAt);
        if (customerMessage(message) && (!message.sessionId || message.sessionId === session.id) && time >= since && time <= until) {
          if (recordPushEvent(db, incomingEventId(message.id), 'MESSAGE_RECEIVED', time, channel.id, session.id)) inboxChanged(channel.id);
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
      const channels = await inboxChannels();
      if (channels.length === 1) db.prepare('UPDATE push_subscriptions SET channel=? WHERE channel IS NULL').run(channels[0].id);
      for (const channel of channels) {
        if (stopped) break;
        try {
          const channelsForDevice = db.prepare('SELECT 1 FROM push_subscriptions WHERE channel=? LIMIT 1').get(channel.id);
          if (!channelsForDevice) continue;
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
