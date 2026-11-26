import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, options);
  return salt + ':' + hash.toString('hex');
}

export async function verifyPassword(password, record) {
  const [salt, hex] = (record || '').split(':');
  const hash = await derive(password, salt || 'vieira-link-login', 64, options);
  const expected = Buffer.from(hex || '', 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export const roleNames = { manager: 'Gerente', agent: 'Atendente', sender: 'Enviador' };
export const landingPage = { manager: 'dashboard', agent: 'conversations', sender: 'campaigns' };

const senderResources = new Set(['campaigns', 'contacts', 'lists', 'templates', 'channels']);
export function canUseApi(role, path) {
  if (role === 'manager') return true;
  const resource = (path.split('/')[1] || '').toLowerCase();
  if (resource === 'conversations' || resource === 'push') return role === 'agent' || role === 'sender';
  return role === 'sender' && senderResources.has(resource);
}
