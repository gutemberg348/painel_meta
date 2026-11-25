import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

if (existsSync('.env')) {
  console.log('.env já existe. Nenhuma configuração foi alterada.');
} else {
  const env = readFileSync('.env.example', 'utf8')
    .replace('SESSION_SECRET=', `SESSION_SECRET=${randomBytes(48).toString('hex')}`)
    .replace('WEBHOOK_SECRET=', `WEBHOOK_SECRET=${randomBytes(32).toString('hex')}`);
  writeFileSync('.env', env, { mode: 0o600 });
  console.log('.env criado. Configure ADMIN_PASSWORD e FLW_API_TOKEN antes de usar.');
}
