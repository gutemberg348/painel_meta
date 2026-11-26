import { Router } from 'express';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audienceSchema, parseAudience, requireValidAudience, saveAudience } from '../services/audience.js';
import { now } from '../services/campaigns.js';
import { createInboxThreads, peerKey } from '../services/inbox-threads.js';
import { planDivision, partName } from '../../public/js/list-division.js';

const name = z.string().trim().min(1, 'Informe um nome.').max(120);
const id = z.string().uuid();
export const phoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s()+.\-]/g, ''))
  .pipe(
    z.string().regex(/^[1-9]\d{9,14}$/, 'Informe telefone com código do país e DDD (ex.: 5591999999999).'),
  );
const contactSchema = z.object({
  name,
  phone: phoneSchema,
  email: z.union([z.email(), z.literal('')]).default(''),
  optedIn: z.boolean().optional(),
  listIds: z.array(id).max(100).default([]),
});
const listSchema = z.object({
  name,
  description: z.string().trim().max(500).default(''),
  color: z.enum(['blue', 'purple', 'green', 'orange']).default('blue'),
});
const optionalListName = z.string().trim().max(120).optional();
const createListSchema = listSchema.extend({ name: optionalListName });
function resolveListName(value) {
  return value || `Lista ${randomBytes(5).toString('hex')}`;
}
const pageNumber = (value) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(value || 1);
const inboxPeriod = z.enum(['1', '7', '30', '90']).default('7');
function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function required(db, table, value) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id.parse(value));
  if (!row) fail('Registro não encontrado.', 404);
  return row;
}

export function apiRouter(db, flw, campaigns, config, inboxChannels, chatCache) {
  const router = Router();
  const threads = createInboxThreads(db, flw, chatCache);
  const lastReplies = new Map();
  const activeReplies = new Set();
  const revisionSecret = randomBytes(32);
  async function inboxScope(requestedId, account) {
    const rawId = requestedId === undefined ? undefined : id.parse(requestedId).toLowerCase();
    const channels = await inboxChannels(account);
    if (!rawId) return { channels, channelId: channels.length === 1 ? channels[0].id : undefined };
    const channelId = channels.find((item) => item.id.toLowerCase() === rawId)?.id;
    if (rawId && !channelId) fail('Este canal não está disponível nesta caixa de entrada.', 403);
    return { channels, channelId };
  }
  async function scopedConversation(sessionId, channelId) {
    if (!channelId) fail('Selecione um canal WhatsApp antes de abrir a conversa.');
    const conversation = await flw.session(sessionId);
    if (conversation.channelId?.toLowerCase() !== channelId.toLowerCase()) {
      fail('Conversa indisponível neste canal.', 404);
    }
    return conversation;
  }
  const campaignRows = () =>
    db
      .prepare(
        `SELECT c.*, COUNT(d.id) AS total,
    COALESCE(SUM(d.status IN ('processing','saved','queued','sent','delivered','read','wait_reply')),0) AS accepted,
    COALESCE(SUM(d.status IN ('delivered','read')),0) AS delivered,
    COALESCE(SUM(d.status='read'),0) AS read,
    COALESCE(SUM(d.status IN ('failed','unknown')),0) AS failed,
    COALESCE(SUM(d.status='pending'),0) AS pending
    FROM campaigns c LEFT JOIN deliveries d ON d.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`,
      )
      .all();
  router.get('/overview', (req, res) => {
    const totals = db
      .prepare(
        `SELECT COUNT(*) total,
      COALESCE(SUM(status IN ('processing','saved','queued','sent','delivered','read','wait_reply')),0) accepted,
      COALESCE(SUM(status IN ('delivered','read')),0) delivered,
      COALESCE(SUM(status='read'),0) read,
      COALESCE(SUM(status IN ('failed','unknown')),0) failed FROM deliveries`,
      )
      .get();
    const activity = db
      .prepare(
        `SELECT substr(updated_at,1,10) day, COUNT(*) total,
      SUM(status IN ('delivered','read')) delivered FROM deliveries WHERE updated_at>=? GROUP BY day ORDER BY day`,
      )
      .all(new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10));
    res.json({
      totals,
      activity,
      contacts: db.prepare('SELECT COUNT(*) n FROM contacts').get().n,
      lists: db.prepare('SELECT COUNT(*) n FROM lists').get().n,
      campaigns: campaignRows(),
      configured: Boolean(config.apiToken),
    });
  });
  router.get('/settings', (req, res) =>
    res.json({
      username: config.username,
      configured: Boolean(config.apiToken),
      apiBase: config.apiBase,
      inboxChannelId: config.inboxChannelId || '',
      sendInterval: config.sendInterval,
      webhookConfigured: Boolean(config.publicUrl && config.webhookSecret),
      lastWebhook: db.prepare("SELECT value FROM metadata WHERE key='lastWebhook'").get()?.value || null,
    }),
  );
  router.post('/connection/test', async (req, res) => {
    const channels = await flw.channels();
    res.json({
      ok: true,
      count: channels.length,
      message: `Conexão confirmada. ${channels.length} canal(is) encontrado(s).`,
    });
  });
  router.get('/lists', (req, res) =>
    res.json(
      db
        .prepare(
          `SELECT l.*, COUNT(lc.contact_id) contact_count,
    COALESCE(SUM(c.opted_in),0) opted_in_count FROM lists l LEFT JOIN list_contacts lc ON lc.list_id=l.id
    LEFT JOIN contacts c ON c.id=lc.contact_id GROUP BY l.id ORDER BY l.created_at DESC, l.name COLLATE NOCASE`,
        )
        .all(),
    ),
  );
  router.post('/lists', (req, res) => {
    const data = createListSchema.parse(req.body);
    const newId = randomUUID();
    const listName = resolveListName(data.name);
    db.prepare('INSERT INTO lists VALUES (?,?,?,?,?)').run(
      newId,
      listName,
      data.description,
      data.color,
      now(),
    );
    res.status(201).json({ id: newId, name: listName });
  });
  router.post('/lists/:id/split', (req, res) => {
    const { mode, value, baseName, expectedTotal } = z.object({
      mode: z.enum(['size', 'parts']),
      value: z.number().int().positive(),
      baseName: name,
      expectedTotal: z.number().int().min(2),
    }).parse(req.body);
    const created = db.transaction(() => {
      const source = required(db, 'lists', req.params.id);
      const members = db.prepare('SELECT contact_id FROM list_contacts WHERE list_id=? ORDER BY rowid').all(source.id);
      if (members.length !== expectedTotal) fail('A quantidade de contatos mudou. Atualize a página para conferir a nova divisão.', 409);
      const plan = planDivision(members.length, mode, value);
      if (!plan) fail('Escolha uma divisão que forme ao menos duas listas com contatos.');

      const existingNames = new Set(db.prepare('SELECT name FROM lists').all().map(row => row.name.toLowerCase()));
      const insertList = db.prepare('INSERT INTO lists (id,name,description,color,created_at) VALUES (?,?,?,?,?)');
      const linkContact = db.prepare('INSERT INTO list_contacts (list_id,contact_id) VALUES (?,?)');
      const createdAt = now();
      let position = 0;
      for (let index = 0; index < plan.count; index++) {
        const listName = partName(baseName, index, plan.count);
        if (existingNames.has(listName.toLowerCase())) fail(`Já existe uma lista chamada “${listName}”. Escolha outro nome base.`, 409);
        const listId = randomUUID();
        insertList.run(listId, listName, source.description, source.color, createdAt);
        const end = position + plan.sizeAt(index);
        while (position < end) {
          linkContact.run(listId, members[position].contact_id);
          position++;
        }
      }
      return plan.count;
    }).immediate();
    res.status(201).json({ created });
  });
  router.put('/lists/:id', (req, res) => {
    required(db, 'lists', req.params.id);
    const data = listSchema.parse(req.body);
    db.prepare('UPDATE lists SET name=?,description=?,color=? WHERE id=?').run(
      data.name,
      data.description,
      data.color,
      req.params.id,
    );
    res.json({ ok: true });
  });
  router.delete('/lists/:id', (req, res) => {
    required(db, 'lists', req.params.id);
    if (
      db
        .prepare("SELECT id FROM campaigns WHERE list_id=? AND status IN ('draft','running','paused')")
        .get(req.params.id)
    )
      fail('Esta lista está vinculada a uma campanha ativa ou rascunho.', 409);
    db.prepare('DELETE FROM lists WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });
  router.get('/contacts', (req, res) => {
    const search = String(req.query.search || '').slice(0, 120);
    const listId = req.query.listId ? id.parse(req.query.listId) : null;
    const rows = db
      .prepare(
        `SELECT c.* FROM contacts c WHERE (name LIKE ? OR phone LIKE ? OR email LIKE ?)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM list_contacts WHERE contact_id=c.id AND list_id=?)) ORDER BY created_at DESC`,
      )
      .all(`%${search}%`, `%${search}%`, `%${search}%`, listId, listId);
    const memberships = db.prepare(
      'SELECT l.id,l.name FROM lists l JOIN list_contacts lc ON lc.list_id=l.id WHERE lc.contact_id=?',
    );
    res.json(rows.map((c) => ({ ...c, lists: memberships.all(c.id) })));
  });
  function saveContact(data, contactId, currentPermission = 0) {
    for (const listId of data.listIds) required(db, 'lists', listId);
    const duplicate = db
      .prepare('SELECT id FROM contacts WHERE phone=? AND id!=?')
      .get(data.phone, contactId);
    if (duplicate) fail('Este telefone já está cadastrado.', 409);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO contacts VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
        phone=excluded.phone,email=excluded.email,opted_in=excluded.opted_in`,
      ).run(contactId, data.name, data.phone, data.email, Number(data.optedIn ?? currentPermission), now());
      db.prepare('DELETE FROM list_contacts WHERE contact_id=?').run(contactId);
      const insert = db.prepare('INSERT INTO list_contacts VALUES (?,?)');
      for (const listId of new Set(data.listIds)) insert.run(listId, contactId);
    })();
  }
  router.post('/contacts', (req, res) => {
    const newId = randomUUID();
    saveContact(contactSchema.parse(req.body), newId);
    res.status(201).json({ id: newId });
  });
  router.put('/contacts/:id', (req, res) => {
    const contact = required(db, 'contacts', req.params.id);
    saveContact(contactSchema.parse(req.body), req.params.id, contact.opted_in);
    res.json({ ok: true });
  });
  router.delete('/contacts/:id', (req, res) => {
    required(db, 'contacts', req.params.id);
    db.prepare('DELETE FROM contacts WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });
  router.post('/contacts/preview', (req, res) => {
    const result = parseAudience(req.body, db);
    res.json({ ...result, contacts: result.contacts.slice(0, 8) });
  });
  router.post('/contacts/import', (req, res) => {
    const body = z
      .object({
        csv: z.string().min(1).max(900000).optional(),
        audience: audienceSchema.optional(),
        listId: id.optional(),
        listName: optionalListName,
        optedIn: z.literal(true, { error: 'Confirme a autorização dos contatos.' }),
      })
      .parse(req.body);
    if (!body.csv && !body.audience) fail('Selecione um arquivo ou cole seus números.');
    const result = parseAudience(body.audience || { text: body.csv, format: 'csv' }, db);
    requireValidAudience(result);
    const list = body.listId ? required(db, 'lists', body.listId) : null;
    const listId = list?.id || randomUUID();
    const listName = list?.name ?? resolveListName(body.listName);
    const saved = db.transaction(() => {
      if (!list)
        db.prepare('INSERT INTO lists VALUES (?,?,?,?,?)').run(
          listId,
          listName,
          'Adicionada pelo painel',
          'blue',
          now(),
        );
      return saveAudience(db, listId, result.contacts);
    })();
    res.json({
      ...saved,
      listId,
      listName,
      total: result.total,
      duplicates: result.duplicates,
      blocked: result.blocked,
      excluded: result.excluded,
    });
  });
  router.get('/channels', async (req, res) => res.json(await flw.channels()));
  router.get('/templates', async (req, res) =>
    res.json(await flw.templates(req.query.channelId ? id.parse(req.query.channelId) : undefined)),
  );
  router.get('/campaigns', (req, res) => res.json(campaignRows()));
  router.post('/campaigns', async (req, res) => {
    const data = z
      .object({
        name,
        listId: id.optional(),
        audience: audienceSchema.optional(),
        optedIn: z.boolean().optional(),
        templateId: id,
        channelId: id,
        parameters: z.record(z.string().max(100), z.string().max(2000)).default({}),
        fileUrl: z
          .union([
            z.url().refine((v) => v.startsWith('https://'), 'Use URL HTTPS para a mídia.'),
            z.literal(''),
          ])
          .default(''),
      })
      .parse(req.body);
    if (Boolean(data.listId) === Boolean(data.audience)) fail('Escolha uma lista OU adicione novos números.');
    let list = data.listId ? required(db, 'lists', data.listId) : null;
    const audience = data.audience ? parseAudience(data.audience, db) : null;
    if (audience) {
      if (!data.optedIn) fail('Confirme a autorização dos contatos.');
      requireValidAudience(audience);
      if (!audience.eligible) fail('Nenhum contato com autorização disponível para esta campanha.');
    }
    const channels = await flw.channels();
    const channel = channels.find(
      (c) => c.id === data.channelId && c.active && /cloudapi|dialog360/i.test(c.type),
    );
    if (!channel?.number) fail('Selecione um canal oficial WhatsApp ativo com número configurado.');
    const templates = await flw.templates(data.channelId);
    const template = templates.find(
      (t) =>
        t.id === data.templateId &&
        String(t.status).toUpperCase() === 'APPROVED' &&
        t.active &&
        !t.archived &&
        t.channelId === data.channelId,
    );
    if (!template) fail('O template deve estar aprovado e pertencer ao canal selecionado.');
    for (const param of template.params || [])
      if (param.name && !data.parameters[param.name]?.trim()) fail(`Preencha a variável ${param.name}.`);
    if (template.fileType && template.fileType !== 'UNDEFINED' && !data.fileUrl)
      fail('Este template exige uma URL pública de mídia.');
    const newId = randomUUID();
    db.transaction(() => {
      if (audience) {
        list = { id: randomUUID(), name: data.name };
        db.prepare('INSERT INTO lists VALUES (?,?,?,?,?)').run(
          list.id,
          list.name,
          'Contatos desta campanha',
          'blue',
          now(),
        );
        saveAudience(db, list.id, audience.contacts);
      }
      db.prepare(
        `INSERT INTO campaigns (id,name,list_id,list_name,template_id,template_name,template_text,channel_id,sender,parameters,file_url,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        newId,
        data.name,
        list.id,
        list.name,
        template.id,
        template.name,
        template.text || '',
        channel.id,
        channel.number,
        JSON.stringify(data.parameters),
        data.fileUrl,
        now(),
      );
    })();
    res.status(201).json({ id: newId });
  });
  router.get('/campaigns/:id', (req, res) => {
    const campaign = required(db, 'campaigns', req.params.id);
    res.json({
      ...campaign,
      deliveries: db.prepare('SELECT * FROM deliveries WHERE campaign_id=? ORDER BY rowid').all(campaign.id),
    });
  });
  router.post('/campaigns/:id/start', (req, res) => {
    z.object({ confirmed: z.literal(true) }).parse(req.body);
    campaigns.start(id.parse(req.params.id));
    res.json({ ok: true });
  });
  router.post('/campaigns/:id/pause', (req, res) => {
    required(db, 'campaigns', req.params.id);
    if (
      !db.prepare("UPDATE campaigns SET status='paused' WHERE id=? AND status='running'").run(req.params.id)
        .changes
    )
      fail('A campanha não está em execução.', 409);
    res.json({ ok: true });
  });
  router.post('/campaigns/:id/cancel', (req, res) => {
    required(db, 'campaigns', req.params.id);
    db.transaction(() => {
      db.prepare(
        "UPDATE campaigns SET status='cancelled' WHERE id=? AND status IN ('draft','paused','running')",
      ).run(req.params.id);
      db.prepare(
        "UPDATE deliveries SET status='skipped',updated_at=? WHERE campaign_id=? AND status='pending'",
      ).run(now(), req.params.id);
    })();
    res.json({ ok: true });
  });
  router.post('/campaigns/:id/sync', async (req, res) => {
    required(db, 'campaigns', req.params.id);
    res.json({ synced: await campaigns.sync(req.params.id) });
  });
  router.get('/conversations', async (req, res) => {
    const page = pageNumber(req.query.page);
    const days = Number(inboxPeriod.parse(req.query.days));
    const { channels, channelId } = await inboxScope(req.query.channelId, res.locals.account);
    const scope = {
      channelId: channelId || '',
      channels: channels.map((channel) => ({
        id: channel.id,
        name: channel.identity?.displayName || channel.name || 'WhatsApp',
        number: channel.numberFormatted || channel.number || '',
      })),
    };
    if (!channelId) return res.json({ ...scope, items: [], hasMorePages: false });
    res.json({ ...scope, ...await threads.list(channelId, days, page, req.session.accountId || 'manager') });
  });
  router.get('/conversations/events', async (req, res) => {
    const { channelId } = await inboxScope(req.query.channelId, res.locals.account);
    if (!channelId) fail('Selecione um canal WhatsApp.');
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write(': conectado\n\n');
    const notify = channel => {
      if (channel !== channelId) return;
      if (res.locals.account.role !== 'manager' && !db.prepare('SELECT 1 FROM staff_users WHERE id=? AND active=1 AND version=?')
        .get(req.session.accountId, req.session.accountVersion)) return res.end();
      res.write('data: atualizar\n\n');
    };
    chatCache.listeners.add(notify);
    // Reconectar periodicamente revalida a sessão e o acesso ao canal.
    const timeout = setTimeout(() => res.end(), 55000);
    res.on('close', () => { clearTimeout(timeout); chatCache.listeners.delete(notify); });
  });
  router.get('/conversations/:id/messages', async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const page = pageNumber(req.query.page);
    const { channelId } = await inboxScope(req.query.channelId, res.locals.account);
    if (!channelId) fail('Selecione um canal WhatsApp antes de abrir a conversa.');
    const detail = id => chatCache.read(`thread:${channelId}:${id}:detail`, () => scopedConversation(id, channelId));
    const source = await detail(sessionId);
    const sessions = await threads.related(channelId, source);
    const latest = await detail(sessions[0].id);
    const replyVersion = lastReplies.get(`thread:${channelId}:${latest.id}:`) || '0';
    const messages = await threads.history(channelId, sessions, page);
    const visibleMessages = messages.items || [];
    const lastMessage = visibleMessages.reduce((last, message) =>
      !last || Date.parse(message.createdAt) > Date.parse(last.createdAt) ? message : last, null);
    let seenAt = Math.max(0, ...visibleMessages.map(message => Math.max(Date.parse(message.createdAt) || 0, Date.parse(message.timestamp) || 0)));
    if (page === 1 && lastMessage?.direction === 'FROM_HUB' && lastMessage.text && lastMessage.text === latest.lastMessageText) {
      seenAt = Math.max(seenAt, Date.parse(latest.lastMessageIn) || 0);
    }
    const data = { ...messages, seenAt, sessionId: latest.id, windowStatus: latest.windowStatus, replyVersion };
    const revision = createHmac('sha256', revisionSecret).update(JSON.stringify(data)).digest('base64url');
    if (page === 1 && req.query.since === revision) return res.json({ unchanged: true });
    res.json({ ...data, revision });
  });
  router.post('/conversations/:id/read', async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const { channelId } = await inboxScope(req.query.channelId, res.locals.account);
    const { seenAt } = z.object({ seenAt: z.number().int().positive() }).parse(req.body);
    const source = await chatCache.read(`thread:${channelId}:${sessionId}:detail`, () => scopedConversation(sessionId, channelId));
    const account = req.session.accountId || 'manager';
    const peer = peerKey(source);
    const until = Math.min(seenAt, Date.now());
    db.transaction(() => {
      db.prepare(`INSERT INTO inbox_reads VALUES (?,?,?,?) ON CONFLICT(account,channel,peer)
        DO UPDATE SET seen_at=MAX(seen_at,excluded.seen_at)`).run(account, channelId, peer, until);
      db.prepare(`DELETE FROM push_deliveries WHERE channel=? AND message_time<=? AND session_id IN
        (SELECT id FROM inbox_sessions WHERE channel=? AND peer=?) AND endpoint IN
        (SELECT endpoint FROM push_subscriptions WHERE account_id=?)`).run(channelId, until, channelId, peer, account);
    })();
    res.json({ seenAt: until });
  });
  async function conversationTemplates(channelId) {
    const templates = await flw.templates(channelId);
    return templates.filter(t => t.channelId?.toLowerCase() === channelId.toLowerCase() &&
      t.active && !t.archived && String(t.status).toUpperCase() === 'APPROVED');
  }
  router.get('/conversations/:id/templates', async (req, res) => {
    const { channelId } = await inboxScope(req.query.channelId, res.locals.account);
    await scopedConversation(id.parse(req.params.id), channelId);
    res.json(await conversationTemplates(channelId));
  });
  router.post('/conversations/:id/reply', async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const version = z.string().max(64).optional();
    const body = z.union([
      z.strictObject({ text: z.string().trim().min(1).max(4096), replyVersion: version }),
      z.strictObject({ templateId: id, parameters: z.record(z.string(), z.string().trim().min(1).max(2000)),
        fileUrl: z.url().startsWith('https://').optional(), replyVersion: version }),
    ]).parse(req.body);
    const { replyVersion } = body;
    const { channelId } = await inboxScope(req.query.channelId, res.locals.account);
    const conversation = await scopedConversation(sessionId, channelId);
    const sessions = await threads.related(channelId, conversation);
    if (sessions[0].id !== sessionId) fail('Chegou uma continuação desta conversa. Atualize as mensagens antes de responder.', 409);
    if ('text' in body && conversation.windowStatus !== 'ACTIVE')
      fail('A janela de atendimento está fechada. Inicie uma nova conversa com um template aprovado.');
    let templateMessage;
    if ('templateId' in body) {
      const template = (await conversationTemplates(channelId)).find(t => t.id === body.templateId);
      if (!template) fail('Escolha um modelo aprovado deste canal.');
      const keys = (template.params || []).map(p => p.name).filter(Boolean);
      if (keys.some(key => !Object.hasOwn(body.parameters, key)) ||
          Object.keys(body.parameters).some(key => !keys.includes(key))) fail('Confira os campos do modelo.');
      if (template.fileType && template.fileType !== 'UNDEFINED' && !body.fileUrl) fail('Informe a mídia do modelo.');
      templateMessage = { templateId: template.id, parameters: body.parameters };
      if (body.fileUrl) templateMessage.fileUrl = body.fileUrl;
      const phone = String(conversation.contactDetails?.phonenumber || '').replace(/\D/g, '');
      if (phone && db.prepare('SELECT 1 FROM contacts WHERE phone=? AND opted_in=0').get(phone))
        fail('Este contato está sem autorização de envio no painel.', 409);
    }
    const key = `thread:${channelId}:${sessionId}:`;
    if (activeReplies.has(key) || (replyVersion !== undefined && replyVersion !== (lastReplies.get(key) || '0'))) {
      fail('A equipe respondeu ou está enviando uma resposta. Atualize as mensagens e revise seu rascunho.', 409);
    }
    activeReplies.add(key);
    try {
      res.json(templateMessage ? await flw.sessionMessage(sessionId, templateMessage) : await flw.reply(sessionId, body.text));
    } finally {
      activeReplies.delete(key);
      chatCache.invalidate(key);
      chatCache.invalidate(`list:${channelId}:`);
      lastReplies.delete(key);
      if (lastReplies.size >= 512) lastReplies.delete(lastReplies.keys().next().value);
      lastReplies.set(key, randomUUID());
    }
  });
  return router;
}
