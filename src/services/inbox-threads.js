const activity = s => Date.parse(s.lastInteractionDate || s.createdAt) || 0;
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
  async function list(channel, days, page, account) {
    const groups = new Map();
    const seen = new Set();
    const after = new Date(Date.now() - days * 86400000).toISOString();
    for (let rawPage = 1; ; rawPage++) {
      const data = await cache.read(`list:${channel}:${days}:${rawPage}`, () => flw.sessions(channel, after, rawPage));
      const sessions = (data.items || []).filter(s => s.id && s.channelId?.toLowerCase() === channel.toLowerCase());
      index(channel, sessions);
      for (const s of sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const key = peerKey(s);
        const previous = groups.get(key);
        const latest = !previous || activity(s) > activity(previous) ? s : previous;
        const incoming = Date.parse(s.lastMessageIn) || (s.unreadCount ? activity(s) : 0);
        const seenAt = readMarker.get(account, channel, key)?.seen_at;
        const unread = seenAt === undefined ? s.unreadCount || 0 : Number(incoming > seenAt);
        groups.set(key, { ...latest, peerKey: key, incomingAt: Math.max(previous?.incomingAt || 0, incoming),
          unreadCount: (previous?.unreadCount || 0) + unread });
      }
      if (groups.size > page * 20 || !more(data, rawPage)) break;
    }
    return { items: [...groups.values()].slice((page - 1) * 20, page * 20), hasMorePages: groups.size > page * 20 };
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

  async function history(channel, sessions, page) {
    const load = (session, n) => cache.read(`thread:${channel}:${session}:raw:${n}`, () => flw.messages(session, n));
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
  return { list, related, history };
}
