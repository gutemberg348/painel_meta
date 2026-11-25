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
    CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS deliveries_campaign ON deliveries(campaign_id);
    CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(status);
  `);
  // Não repetir automaticamente uma requisição cujo resultado ficou desconhecido.
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
  touch(sid, value, callback) {
    this.set(sid, value, callback);
  }
}
