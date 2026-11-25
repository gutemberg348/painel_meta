import 'dotenv/config';
import { resolve } from 'node:path';

export function loadConfig(env = process.env) {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error(
      'Configure ADMIN_USERNAME, ADMIN_PASSWORD e SESSION_SECRET (32+ caracteres) no .env. Execute npm run setup.',
    );
  }
  if (env.NODE_ENV === 'production' && env.ADMIN_PASSWORD === 'troque-por-uma-senha-forte') {
    throw new Error('Altere a senha inicial antes de iniciar em produção.');
  }
  const apiBase = new URL(env.FLW_API_BASE_URL || 'https://api.wts.chat/chat');
  if (apiBase.protocol !== 'https:') throw new Error('FLW_API_BASE_URL deve usar HTTPS.');
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/$/, '');
  if (publicUrl && new URL(publicUrl).protocol !== 'https:') throw new Error('PUBLIC_URL deve usar HTTPS.');
  return {
    username: env.ADMIN_USERNAME,
    password: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    production: env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY === 'true',
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    databasePath: resolve(env.DATABASE_PATH || './data/totalk.sqlite'),
    apiBase: apiBase.toString().replace(/\/$/, ''),
    apiToken: env.FLW_API_TOKEN || '',
    sendInterval: Math.max(500, Number(env.SEND_INTERVAL_MS) || 1000),
    publicUrl,
    webhookSecret: env.WEBHOOK_SECRET || '',
  };
}
