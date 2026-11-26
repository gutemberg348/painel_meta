// Uma instância por integração. A promessa também é compartilhada durante a leitura.
export class ChatCache {
  entries = new Map();
  listeners = new Set();

  read(key, load, ttl = 4000) {
    const cached = this.entries.get(key);
    if (cached && cached.until > Date.now()) return cached.result;
    this.entries.delete(key);
    if (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value);
    const entry = { until: Infinity };
    entry.result = Promise.resolve().then(load).then((value) => {
      entry.until = Date.now() + ttl;
      return value;
    }).catch((error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.result;
  }

  invalidate(prefix) {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
  inboxChanged(channel) {
    this.invalidate(`thread:${channel}:`);
    this.invalidate(`list:${channel}:`);
    for (const notify of this.listeners) notify(channel);
  }
}
