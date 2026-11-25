import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashPassword } from '../services/users.js';

const role = z.enum(['agent', 'sender']);
const password = z.string().min(10, 'Use pelo menos 10 caracteres na senha.').max(256);
const createSchema = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,80}$/, 'Use de 3 a 80 letras, números, pontos, hífens ou sublinhados no usuário.'),
  password,
  role,
}).strict();

export function usersRouter(db, config) {
  const router = Router();
  router.get('/', (req, res) => {
    const staff = db.prepare('SELECT id, username, role, active FROM staff_users ORDER BY username').all();
    res.json([{ id: 'manager', username: config.username, role: 'manager', active: 1 }, ...staff]);
  });
  router.post('/', async (req, res) => {
    const data = createSchema.parse(req.body);
    if (data.username.toLowerCase() === config.username.toLowerCase()) {
      return res.status(409).json({ error: 'Esse login já pertence ao gerente.' });
    }
    const passwordHash = await hashPassword(data.password);
    const id = randomUUID();
    const result = db.prepare('INSERT INTO staff_users(id,username,role,password_hash) VALUES (?,?,?,?) ON CONFLICT(username) DO NOTHING')
      .run(id, data.username, data.role, passwordHash);
    if (!result.changes) return res.status(409).json({ error: 'Esse login já está em uso.' });
    res.status(201).json({ id });
  });
  router.put('/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const data = z.object({ role, active: z.boolean(), password: password.optional() }).strict().parse(req.body);
    const hash = data.password ? await hashPassword(data.password) : null;
    const result = db.prepare('UPDATE staff_users SET role=?, active=?, password_hash=COALESCE(?,password_hash), version=version+1 WHERE id=?')
      .run(data.role, Number(data.active), hash, id);
    if (!result.changes) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ ok: true });
  });
  return router;
}
