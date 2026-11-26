import { createHash } from 'node:crypto';

export function incomingEventId(id) {
  return createHash('sha256').update('MESSAGE_RECEIVED:' + id).digest('hex');
}
const visibleTypes = new Set(['TEXT', 'STICKER', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'CONTACT', 'LOCATION', 'LIST', 'BUTTONS']);
export const pushLifetime = 90000;
const processStart = Date.now();
const enumValue = value => String(value || '').toUpperCase();
const messageDate = m => Date.parse(m.createdAt) || Date.parse(m.timestamp);
export function customerMessage(message) {
  const type = enumValue(message.type);
  return typeof message.id === 'string' && Boolean(message.id.trim()) && enumValue(message.direction) === 'FROM_HUB' &&
    visibleTypes.has(type) && !message.templateId &&
    !['FAILED', 'DELETED'].includes(enumValue(message.status)) &&
    !['BOT', 'CAMPAIGN', 'OFFICE_HOURS', 'PAYMENT'].includes(enumValue(message.origin)) &&
    (type !== 'TEXT' || Boolean(message.text?.trim()));
}

// O webhook e a consulta periódica podem encontrar a mesma mensagem.
export function recordPushEvent(db, eventId, type, messageTime, channel = null, sessionId = null) {
  if (type === 'MESSAGE_RECEIVED' && (!Number.isFinite(messageTime) || messageTime < Date.now() - pushLifetime || messageTime > Date.now() + 5000)) return false;
  return db.transaction(() => {
    const saved = db.prepare('INSERT OR IGNORE INTO webhook_events VALUES (?,?,?)')
      .run(eventId, type, new Date().toISOString());
    if (!saved.changes || type !== 'MESSAGE_RECEIVED') return false;
    const queued = db.prepare(`INSERT INTO push_deliveries(endpoint,event_id,expires_at,channel,session_id,message_time)
      SELECT endpoint,?,?,?,?,? FROM push_subscriptions s WHERE subscribed_at<=? AND s.channel=?
      ON CONFLICT(endpoint) DO UPDATE SET event_id=excluded.event_id,expires_at=excluded.expires_at,
      channel=excluded.channel,session_id=excluded.session_id,message_time=excluded.message_time,
      next_attempt=0,attempts=0 WHERE excluded.expires_at >= push_deliveries.expires_at`)
      .run(eventId, messageTime + pushLifetime, channel, sessionId, messageTime, messageTime, channel);
    if (queued.changes) db.prepare("INSERT OR REPLACE INTO metadata VALUES ('pushLastQueued', ?)").run(String(Date.now()));
    return true;
  })();
}

async function* pages(load, stopped) {
  for (let page = 1; !stopped(); page++) {
    const data = await load(page);
    if (!Array.isArray(data.items)) throw new Error('Página de mensagens inválida.');
    yield data.items;
    if (!data.items.length || !(data.hasMorePages || data.totalPages > page)) return;
  }
}

// O histórico aberto, o monitor em segundo plano e o webhook usam a mesma chave.
export function captureIncoming(db, message, channelId, sessionId, since = processStart) {
  const time = messageDate(message);
  if (!Number.isFinite(time) || time < Math.max(since, Date.now() - pushLifetime) || time > Date.now() + 5000) return 'outsideWindow';
  if ((message.sessionId && sessionId && message.sessionId !== sessionId) || !customerMessage(message)) return 'filtered';
  return recordPushEvent(db, incomingEventId(message.id), 'MESSAGE_RECEIVED', time, channelId, sessionId) ? 'detected' : 'duplicate';
}

export async function scanIncoming(db, flw, channel, since, stopped, inboxChanged) {
  const stats = { at: Date.now(), sessions: 0, messages: 0, outsideWindow: 0, filtered: 0, detected: 0, duplicate: 0 };
  // Mesma listagem ordenada da caixa de entrada. A FLW pode indexar uma sessão depois da mensagem.
  const sessionCutoff = since - 60000;
  const period = new Date(sessionCutoff).toISOString();
  for await (const batch of pages(page => flw.sessions(channel.id, period, page), stopped)) {
    let pastWindow = false;
    for (const session of batch) {
      if (stopped()) return stats;
      if (!session.id || session.channelId?.toLowerCase() !== channel.id.toLowerCase()) continue;
      const activity = Date.parse(session.lastInteractionDate);
      const incoming = Date.parse(session.lastMessageIn);
      if (activity < sessionCutoff && !(incoming >= since)) {
        pastWindow = true;
        continue;
      }
      stats.sessions++;
      for await (const history of pages(page => flw.messages(session.id, page), stopped)) {
        for (const message of history) {
          stats.messages++;
          const result = captureIncoming(db, message, channel.id, session.id, since);
          stats[result]++;
          if (result === 'detected') inboxChanged(channel.id);
        }
        if (history.some(m => messageDate(m) < since)) break;
      }
    }
    if (pastWindow) break;
  }
  return stats;
}

export function startIncomingMonitor(db, flw, inboxChannels, config, inboxChanged) {
  let stopped = false;
  let busy = false;
  let retryAt = 0;
  const saveCursor = db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)');
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
          const sub = db.prepare('SELECT MIN(subscribed_at) AS first FROM push_subscriptions WHERE channel=?').get(channel.id);
          if (sub.first === null) continue;
          const since = Math.max(processStart, sub.first, Date.now() - pushLifetime);
          const stats = await scanIncoming(db, flw, channel, since, () => stopped, inboxChanged);
          if (!stopped) {
            saveCursor.run('pushCursor:' + channel.id, String(Date.now()));
            saveCursor.run('pushScan:' + channel.id, JSON.stringify(stats));
          }
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
