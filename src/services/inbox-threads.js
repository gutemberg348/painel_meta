import { captureIncoming } from './incoming-push.js';

const activity = s => Math.max(...[s.lastInteractionDate, s.createdAt, s.lastMessageIn, s.lastMessageOut]
  .map(value => Date.parse(value) || 0));
const more = (data, page) => Boolean(data.items?.length && (data.hasMorePages || data.totalPages > page));

export function peerKey(session) {
  const phone = String(session.contactDetails?.phonenumber || '').replace(/\D/g, '');
  if (phone) return 'phone:' + phone;
  const contact = session.contactId || session.contactDetails?.id;
  if (contact) return 'contact:' + contact;
  const number = String(session.number || '').replace(/[\s().+-]/g, '');
  return /^[1-9]\d{9,14}$/.test(number) ? 'phone:' + number : 'session:' + session.id;
}

export function createInboxThreads(db, flw, cache) {
  const remember = db.prepare(`INSERT INTO inbox_sessions(channel,id,peer,activity) VALUES (?,?,?,?)
    ON CONFLICT(channel,id) DO UPDATE SET peer=excluded.peer,activity=MAX(activity,excluded.activity)
    WHERE peer<>excluded.peer OR activity<excluded.activity`);
  const index = db.transaction((channel, sessions) => {
    for (const s of sessions) remember.run(channel, s.id, peerKey(s), activity(s));
  });
  const readMarker = db.prepare('SELECT seen_at FROM inbox_reads WHERE account=? AND channel=? AND peer=?');
  const removal = db.prepare('SELECT removed_at FROM inbox_removals WHERE channel=? AND peer=?');
  const removedAt = (channel, peer) => removal.get(channel, peer)?.removed_at || 0;
  function remove(channel, source) {
    db.prepare(`INSERT INTO inbox_removals VALUES (?,?,?) ON CONFLICT(channel,peer)
      DO UPDATE SET removed_at=MAX(removed_at,excluded.removed_at)`).run(channel, peerKey(source), Date.now());
    cache.inboxChanged(channel);
  }

  function loadMessages(channel, session, page, cutoff) {
    return cache.read(`thread:${channel}:${session}:raw:${page}:${cutoff}`, async () => {
      const history = await flw.messages(session, page, cutoff ? { after: new Date(cutoff).toISOString() } : undefined);
      if (page === 1 && db.prepare('SELECT 1 FROM push_subscriptions WHERE channel=? LIMIT 1').get(channel)) {
        for (const message of history.items || []) captureIncoming(db, message, channel, session);
      }
      if (!cutoff) return history;
      const items = (history.items || []).filter(m => Date.parse(m.createdAt || m.timestamp) > cutoff);
      return { items, hasMorePages: items.length === history.items?.length && more(history, page) };
    });
  }

  const lastCheck = db.prepare('SELECT * FROM inbox_delivery_checks WHERE channel=? AND session_id=?');
  const saveCheck = db.prepare('INSERT OR REPLACE INTO inbox_delivery_checks VALUES (?,?,?,?,?,?,?)');
  async function failedOnly(channel, s, cutoff, budget) {
    if (s.unreadCount > 0 || Date.parse(s.lastMessageIn) > cutoff || s.windowStatus === 'ACTIVE') return false;
    const stamp = activity(s);
    const saved = lastCheck.get(channel, s.id);
    const check = saved?.activity === stamp && saved.cutoff === cutoff ? saved : null;
    if (check && check.check_after > Date.now()) return !!check.failed_only;
    // A lista continua utilizável durante a classificação de uma campanha grande.
    if (!budget.left) return !!check?.failed_only;
    budget.left--;
    const page = check?.next_page || 1;
    return cache.read(`thread:${channel}:${s.id}:failure:${stamp}:${cutoff}:${page}`, async () => {
      let failed = false;
      let nextPage = 1;
      let delay = 120000;
      try {
        const batch = await loadMessages(channel, s.id, page, cutoff);
        if (batch.items?.length && batch.items.every(m =>
          m.direction === 'TO_HUB' && String(m.status).toUpperCase() === 'FAILED')) {
          failed = !more(batch, page);
          nextPage = failed ? 1 : page + 1;
          delay = failed ? 3600000 : 0;
        } else if (batch.items?.some(m => m.direction === 'FROM_HUB' || ['DELIVERED', 'READ'].includes(m.status))) {
          delay = 86400000;
        }
      } catch {
        // Sem confirmação da FLW, a conversa continua disponível.
      }
      saveCheck.run(channel, s.id, stamp, cutoff, Number(failed), nextPage, Date.now() + delay);
      return failed;
    });
  }
  async function list(channel, days, page, account, includePrevious = false) {
    const groups = new Map();
    const seen = new Set();
    const budget = { left: 3 };
    const after = new Date(Date.now() - days * 86400000).toISOString();
    let boundary = '';
    for (let rawPage = 1; ; rawPage++) {
      const data = await cache.read(`list:${channel}:${days}:${rawPage}:${boundary}`,
        () => flw.sessions(channel, after, rawPage), rawPage === 1 ? 4000 : 30000);
      boundary = data.items?.at(-1)?.id || '';
      const sessions = (data.items || []).filter(s => s.id && s.channelId?.toLowerCase() === channel.toLowerCase());
      index(channel, sessions);
      const hidden = new Set();
      await Promise.all(sessions.map(async s => {
        const cutoff = removedAt(channel, peerKey(s));
        if ((cutoff && activity(s) <= cutoff) || await failedOnly(channel, s, cutoff, budget)) hidden.add(s.id);
      }));
      for (const s of sessions) {
        if (seen.has(s.id) || hidden.has(s.id)) continue;
        seen.add(s.id);
        const key = peerKey(s);
        const cutoff = removedAt(channel, key);
        if (cutoff && activity(s) <= cutoff) continue;
        const previous = groups.get(key);
        const latest = !previous || activity(s) > activity(previous) ? s : previous;
        const incoming = Date.parse(s.lastMessageIn) || (s.unreadCount ? activity(s) : 0);
        const seenAt = Math.max(readMarker.get(account, channel, key)?.seen_at || 0, cutoff) || undefined;
        const unread = seenAt === undefined ? s.unreadCount || 0 : Number(incoming > seenAt);
        groups.set(key, { ...latest, peerKey: key, incomingAt: Math.max(previous?.incomingAt || 0, incoming),
          unreadCount: (previous?.unreadCount || 0) + unread });
      }
      if (groups.size > page * 20 || !more(data, rawPage)) break;
    }
    return { items: [...groups.values()].slice(includePrevious ? 0 : (page - 1) * 20, page * 20),
      hasMorePages: groups.size > page * 20 };
  }

  async function related(channel, source) {
    const peer = peerKey(source);
    index(channel, [source]);
    const contactId = source.contactId || source.contactDetails?.id;
    if (contactId) {
      await cache.read(`list:${channel}:peer:${contactId}`, async () => {
        for (let page = 1; ; page++) {
          const data = await flw.sessions(channel, undefined, page, contactId);
          index(channel, (data.items || []).filter(s => s.id && s.channelId?.toLowerCase() === channel.toLowerCase() &&
            (s.contactId || s.contactDetails?.id) === contactId));
          if (!more(data, page)) break;
        }
        return true;
      }, 60000);
    }
    return db.prepare('SELECT id,activity FROM inbox_sessions WHERE channel=? AND peer=? ORDER BY activity DESC,id').all(channel, peer);
  }

  async function history(channel, sessions, page, removed = 0) {
    const load = (session, n) => loadMessages(channel, session, n, removed);
    if (sessions.length === 1) return load(sessions[0].id, page);
    const end = page * 25;
    const messages = new Map();
    let remaining = false;
    let cutoff;
    const recentFirst = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || String(a.id).localeCompare(String(b.id));
    for (const session of sessions) {
      if (session.activity && session.activity < cutoff) { remaining = true; break; }
      for (let n = 1; ; n++) {
        const data = await load(session.id, n);
        for (const message of data.items || []) messages.set(message.id, message);
        if (!more(data, n)) break;
        if (n >= page) { remaining = true; break; }
      }
      if (messages.size >= end) cutoff = Date.parse([...messages.values()].sort(recentFirst)[end - 1].createdAt);
    }
    const ordered = [...messages.values()].sort(recentFirst);
    return { items: ordered.slice(end - 25, end), hasMorePages: remaining || ordered.length > end };
  }
  return { list, related, history, remove, removedAt };
}
