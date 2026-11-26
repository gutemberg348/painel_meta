import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashPassword } from '../services/users.js';

const role = z.enum(['agent', 'sender']);
const channelId = z.uuid().transform(value => value.toLowerCase()).optional();
const password = z.string().min(10, 'Use pelo menos 10 caracteres na senha.').max(256);
const createSchema = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,80}$/, 'Use de 3 a 80 letras, números, pontos, hífens ou sublinhados no usuário.'),
  password,
  role,
  channelId,
}).strict();

export function usersRouter(db, config, inboxChannels) {
  const router = Router();
  const assignableChannels = async () => (await inboxChannels()).filter(c => c.active !== false);
  async function assignment(data, previous) {
    if (data.role !== 'agent') return null;
    if (data.active === false) return previous?.channel_id || null;
    if (!data.channelId) throw Object.assign(new Error('Selecione o número de WhatsApp do atendente.'), { status: 400 });
    if (!(await assignableChannels()).some(c => c.id.toLowerCase() === data.channelId)) {
      throw Object.assign(new Error('Escolha um número de WhatsApp ativo disponível no painel.'), { status: 400 });
    }
    return data.channelId;
  }
  router.get('/channels', async (req, res) => res.json((await assignableChannels()).map(c => ({
    id: c.id.toLowerCase(), name: c.identity?.displayName || c.name || 'WhatsApp', number: c.numberFormatted || c.number || '',
  }))));
  router.get('/', (req, res) => {
    const staff = db.prepare('SELECT id, username, role, active, channel_id AS channelId FROM staff_users ORDER BY username').all();
    res.json([{ id: 'manager', username: config.username, role: 'manager', active: 1 }, ...staff]);
  });
  router.post('/', async (req, res) => {
    const data = createSchema.parse(req.body);
    if (data.username.toLowerCase() === config.username.toLowerCase()) {
      return res.status(409).json({ error: 'Esse login já pertence ao gerente.' });
    }
    const channel = await assignment(data);
    const passwordHash = await hashPassword(data.password);
    const id = randomUUID();
    const result = db.prepare('INSERT INTO staff_users(id,username,role,password_hash,channel_id) VALUES (?,?,?,?,?) ON CONFLICT(username) DO NOTHING')
      .run(id, data.username, data.role, passwordHash, channel);
    if (!result.changes) return res.status(409).json({ error: 'Esse login já está em uso.' });
    res.status(201).json({ id });
  });
  router.put('/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const data = z.object({ role, active: z.boolean(), password: password.optional(), channelId }).strict().parse(req.body);
    const previous = db.prepare('SELECT channel_id FROM staff_users WHERE id=?').get(id);
    if (!previous) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const channel = await assignment(data, previous);
    const hash = data.password ? await hashPassword(data.password) : null;
    db.transaction(() => {
      // Preservar os aparelhos quando o gerente salva o mesmo vínculo de atendimento.
      const current = db.prepare('SELECT role, channel_id FROM staff_users WHERE id=?').get(id);
      if (!data.active || hash || current.role !== data.role || current.channel_id !== channel) {
        db.prepare('DELETE FROM push_subscriptions WHERE account_id=?').run(id);
      }
      db.prepare('UPDATE staff_users SET role=?, active=?, channel_id=?, password_hash=COALESCE(?,password_hash), version=version+1 WHERE id=?')
        .run(data.role, Number(data.active), channel, hash, id);
    })();
    res.json({ ok: true });
  });
  return router;
}
