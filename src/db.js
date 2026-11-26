import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import session from 'express-session';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'blue', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL DEFAULT '', opted_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS list_contacts (
      list_id TEXT REFERENCES lists(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
      PRIMARY KEY(list_id, contact_id)
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
      list_name TEXT NOT NULL, template_id TEXT NOT NULL, template_name TEXT NOT NULL,
      template_text TEXT NOT NULL, channel_id TEXT NOT NULL, sender TEXT NOT NULL,
      parameters TEXT NOT NULL DEFAULT '{}', file_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, started_at TEXT
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      name TEXT NOT NULL, phone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      provider_id TEXT UNIQUE, session_id TEXT, error TEXT, updated_at TEXT NOT NULL,
      UNIQUE(campaign_id, phone)
    );
    CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);
    CREATE TABLE IF NOT EXISTS staff_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('agent','sender')),
      password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY, keys_json TEXT NOT NULL, account_id TEXT NOT NULL, sid TEXT NOT NULL,
      pending_event TEXT, next_attempt INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS push_deliveries (
      endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
      event_id TEXT NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(endpoint, event_id)
    );
    CREATE INDEX IF NOT EXISTS push_due ON push_deliveries(next_attempt);
    CREATE TABLE IF NOT EXISTS inbox_sessions (
      channel TEXT NOT NULL, id TEXT NOT NULL, peer TEXT NOT NULL, activity INTEGER NOT NULL,
      PRIMARY KEY(channel,id)
    );
    CREATE INDEX IF NOT EXISTS inbox_peer ON inbox_sessions(channel,peer,activity DESC);
    CREATE TABLE IF NOT EXISTS inbox_removals (
      channel TEXT NOT NULL, peer TEXT NOT NULL, removed_at INTEGER NOT NULL,
      PRIMARY KEY(channel,peer)
    );
    CREATE TABLE IF NOT EXISTS inbox_delivery_checks (
      channel TEXT NOT NULL, session_id TEXT NOT NULL, activity INTEGER NOT NULL,
      cutoff INTEGER NOT NULL, failed_only INTEGER NOT NULL, next_page INTEGER NOT NULL, check_after INTEGER NOT NULL,
      PRIMARY KEY(channel,session_id)
    );
    CREATE TABLE IF NOT EXISTS inbox_reads (
      account TEXT NOT NULL, channel TEXT NOT NULL, peer TEXT NOT NULL, seen_at INTEGER NOT NULL,
      PRIMARY KEY(account,channel,peer)
    );
    CREATE INDEX IF NOT EXISTS deliveries_campaign ON deliveries(campaign_id);
    CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(status);
  `);
  db.transaction(() => {
    if (!db.pragma('table_info(push_subscriptions)').some(column => column.name === 'subscribed_at')) {
      db.exec('ALTER TABLE push_subscriptions ADD COLUMN subscribed_at INTEGER NOT NULL DEFAULT 0');
      db.prepare('UPDATE push_subscriptions SET subscribed_at=?').run(Date.now());
      db.exec(`INSERT INTO push_deliveries(endpoint,event_id,next_attempt,attempts)
        SELECT endpoint,pending_event,next_attempt,attempts FROM push_subscriptions WHERE pending_event IS NOT NULL;
        UPDATE push_subscriptions SET pending_event=NULL WHERE pending_event IS NOT NULL`);
    }
  })();
  if (!db.pragma('table_info(push_deliveries)').some(column => column.name === 'expires_at')) {
    db.transaction(() => {
      // Os avisos da fila antiga não têm origem ou validade verificáveis.
      db.exec('ALTER TABLE push_deliveries ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE push_deliveries ADD COLUMN channel TEXT');
      db.exec('ALTER TABLE push_deliveries ADD COLUMN session_id TEXT');
      db.exec('ALTER TABLE push_deliveries ADD COLUMN message_time INTEGER');
      db.exec('ALTER TABLE push_subscriptions ADD COLUMN channel TEXT');
      db.exec('DELETE FROM push_deliveries WHERE expires_at=0');
      db.exec('CREATE UNIQUE INDEX push_device_pending ON push_deliveries(endpoint)');
    })();
  }
  // Não repetir automaticamente uma requisição cujo resultado ficou desconhecido.
  if (!db.pragma('table_info(staff_users)').some(column => column.name === 'channel_id')) {
    db.transaction(() => {
      db.exec('ALTER TABLE staff_users ADD COLUMN channel_id TEXT');
      db.exec("DELETE FROM push_subscriptions WHERE account_id IN (SELECT id FROM staff_users WHERE role='agent')");
    })();
  }
  db.prepare(
    "UPDATE deliveries SET status='unknown', error='Servidor reiniciado durante o envio. Confira na FLW antes de reenviar.' WHERE status='sending'",
  ).run();
  db.prepare("UPDATE campaigns SET status='paused' WHERE status='running'").run();
  return db;
}

export class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
  }
  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT data FROM sessions WHERE sid=? AND expires>?').get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (error) {
      callback(error);
    }
  }
  set(sid, value, callback = () => {}) {
    try {
      const expires = value.cookie.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 28800000;
      this.db
        .prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(value), expires);
      this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
      callback();
    } catch (error) {
      callback(error);
    }
  }
  destroy(sid, callback = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
      callback();
    } catch (error) {
      callback(error);
    }
  }
  touch(sid, value, callback = () => {}) {
    try {
      const expires = value.cookie.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 28800000;
      this.db.prepare('UPDATE sessions SET expires = MAX(expires, ?) WHERE sid=?').run(expires, sid);
      callback();
    } catch (error) {
      callback(error);
    }
  }
}
