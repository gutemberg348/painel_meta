import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { fixture, authenticate } from './helpers.js';
import { applyProviderStatus } from '../src/services/campaigns.js';
import { FlwClient } from '../src/services/flw.js';

let f, agent, csrf;
beforeEach(async () => {
  f = fixture();
  agent = request.agent(f.app);
  csrf = await authenticate(agent);
});
afterEach(() => {
  f.campaigns.stop();
  f.db.close();
});
const post = (path, body = {}) => agent.post(`/api${path}`).set('x-csrf-token', csrf).send(body);
async function addAudience(optedIn = true) {
  const list = (await post('/lists', { name: 'Clientes VIP' }).expect(201)).body;
  const contact = (
    await post('/contacts', {
      name: 'Marina',
      phone: '+55 (91) 99999-9999',
      email: '',
      optedIn,
      listIds: [list.id],
    }).expect(201)
  ).body;
  return { list, contact };
}
async function addCampaign(listId) {
  return (
    await post('/campaigns', {
      name: 'Campanha teste',
      listId,
      channelId: f.channelId,
      templateId: f.templateId,
      parameters: { 1: '{{nome}}' },
    }).expect(201)
  ).body;
}

test('login, sessão protegida, CSRF e segredos fora do navegador', async () => {
  await request(f.app).get('/api/contacts').expect(401);
  await agent.post('/api/lists').send({ name: 'Sem CSRF' }).expect(403);
  const settings = await agent.get('/api/settings').expect(200);
  assert.ok(!settings.text.includes(f.config.apiToken));
  assert.ok(!settings.text.includes(f.config.sessionSecret));
  const login = await request.agent(f.app).get('/login');
  assert.match(login.headers['content-security-policy'], /script-src 'self'/);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  assert.match(login.headers['set-cookie'][0], /SameSite=Lax/);
  const home = await agent.get('/');
  assert.ok(!home.text.includes(f.config.password));
  await agent.post('/logout').set('x-csrf-token', csrf).expect(302);
  await agent.get('/api/contacts').expect(401);
});

test('CRUD de contatos normaliza telefone, associa listas e rejeita duplicatas', async () => {
  const { list, contact } = await addAudience();
  let rows = (await agent.get('/api/contacts')).body;
  assert.equal(rows[0].phone, '5591999999999');
  assert.equal(rows[0].lists[0].id, list.id);
  await post('/contacts', { name: 'Duplicado', phone: '5591999999999', optedIn: true }).expect(409);
  await agent
    .put(`/api/contacts/${contact.id}`)
    .set('x-csrf-token', csrf)
    .send({ name: 'Marina editada', phone: '5591999999999', optedIn: false, listIds: [] })
    .expect(200);
  rows = (await agent.get('/api/contacts')).body;
  assert.equal(rows[0].opted_in, 0);
  assert.deepEqual(rows[0].lists, []);
  await agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', csrf).expect(200);
  assert.equal((await agent.get('/api/contacts')).body.length, 0);
});

test('CSV é atômico, aceita BOM e ponto e vírgula, não duplica nem reativa opt-out', async () => {
  const { list } = await addAudience(false);
  await post('/contacts/import', {
    listId: list.id,
    optedIn: true,
    csv: 'nome,telefone,email\nJoão,5591888888888,\nInválido,abc,',
  }).expect(400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM contacts').get().n, 1);
  const result = await post('/contacts/import', {
    listId: list.id,
    optedIn: true,
    csv: '\uFEFFnome;telefone;email\nMarina;5591999999999;\nJoão;5591888888888;joao@example.com\nJoão;5591888888888;joao@example.com',
  }).expect(200);
  assert.equal(result.body.created, 1);
  assert.equal(f.db.prepare('SELECT opted_in FROM contacts WHERE phone=?').get('5591999999999').opted_in, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM list_contacts').get().n, 2);
});

test('campanha exige confirmação, só inclui autorizados e não repete disparo', async () => {
  const { list } = await addAudience();
  await post('/contacts', {
    name: 'Sem permissão',
    phone: '5591777777777',
    optedIn: false,
    listIds: [list.id],
  });
  const campaign = await addCampaign(list.id);
  await post(`/campaigns/${campaign.id}/start`).expect(400);
  await post(`/campaigns/${campaign.id}/start`, { confirmed: true }).expect(200);
  await post(`/campaigns/${campaign.id}/start`, { confirmed: true }).expect(409);
  await Promise.all([f.campaigns.tick(), f.campaigns.tick()]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].parameters['1'], 'Marina');
  assert.equal(f.calls[0].to, '5591999999999');
  assert.equal(f.calls[0].from, '5591888888888');
  assert.ok(f.calls[0].callbackUrl.endsWith(f.config.webhookSecret));
  await f.campaigns.tick();
  assert.equal(f.db.prepare('SELECT status FROM campaigns').get().status, 'completed');
  await post(`/campaigns/${campaign.id}/sync`).expect(200);
  assert.equal(f.db.prepare('SELECT status FROM deliveries').get().status, 'delivered');
});

test('autorização revogada após confirmação impede o envio pendente', async () => {
  const { list, contact } = await addAudience();
  const campaign = await addCampaign(list.id);
  await post(`/campaigns/${campaign.id}/start`, { confirmed: true });
  f.db.prepare('UPDATE contacts SET opted_in=0 WHERE id=?').run(contact.id);
  await f.campaigns.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.prepare('SELECT status FROM deliveries').get().status, 'skipped');
});

test('timeout fica indeterminado e nunca é repetido automaticamente', async () => {
  const { list } = await addAudience();
  const campaign = await addCampaign(list.id);
  let attempts = 0;
  f.flw.sendTemplate = async () => {
    attempts++;
    throw Object.assign(new Error('Tempo esgotado'), { uncertain: true });
  };
  await post(`/campaigns/${campaign.id}/start`, { confirmed: true });
  await f.campaigns.tick();
  await f.campaigns.tick();
  assert.equal(attempts, 1);
  assert.equal(f.db.prepare('SELECT status FROM deliveries').get().status, 'unknown');
});

test('limite 429 pausa a fila, mantendo o destinatário pendente', async () => {
  const { list } = await addAudience();
  const campaign = await addCampaign(list.id);
  f.flw.sendTemplate = async () => {
    throw Object.assign(new Error('Limite da API'), { status: 429 });
  };
  await post(`/campaigns/${campaign.id}/start`, { confirmed: true });
  await f.campaigns.tick();
  assert.equal(f.db.prepare('SELECT status FROM deliveries').get().status, 'pending');
  assert.equal(f.db.prepare('SELECT status FROM campaigns').get().status, 'paused');
});

test('webhook exige segredo e confirma status na API; leitura não retrocede', async () => {
  const { list } = await addAudience();
  const campaign = await addCampaign(list.id);
  await post(`/campaigns/${campaign.id}/start`, { confirmed: true });
  await f.campaigns.tick();
  const delivery = f.db.prepare('SELECT * FROM deliveries').get();
  await request(f.app).post('/webhooks/flw/errado').send({ id: delivery.provider_id }).expect(401);
  const body = { eventType: 'MESSAGE_UPDATE', content: { id: delivery.provider_id, status: 'READ' } };
  await request(f.app).post(`/webhooks/flw/${f.config.webhookSecret}`).send(body).expect(200);
  assert.equal(f.db.prepare('SELECT status FROM deliveries').get().status, 'delivered');
  await request(f.app).post(`/webhooks/flw/${f.config.webhookSecret}`).send(body).expect(200);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM webhook_events').get().n, 1);
  applyProviderStatus(f.db, delivery.id, { id: delivery.provider_id, status: 'READ' });
  applyProviderStatus(f.db, delivery.id, { id: delivery.provider_id, status: 'SENT' });
  assert.equal(f.db.prepare('SELECT status FROM deliveries').get().status, 'read');
});

test('resposta exige janela ativa e preserva o texto', async () => {
  f.conversations[0].windowStatus = 'EXPIRED';
  await post(`/conversations/${f.sessionId}/reply`, { text: 'Oi' }).expect(400);
  f.conversations[0].windowStatus = 'ACTIVE';
  const result = await post(`/conversations/${f.sessionId}/reply`, { text: 'Olá, Marina!' }).expect(200);
  assert.equal(result.body.text, 'Olá, Marina!');
  assert.equal(result.body.status, 'QUEUED');
});

test('cliente FLW usa Bearer, parâmetros documentados e páginas completas', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const page = new URL(url).searchParams.get('PageNumber');
    return new Response(
      JSON.stringify({ items: [{ id: page }], totalPages: 2, hasMorePages: page === '1' }),
      { status: 200 },
    );
  };
  try {
    const client = new FlwClient(f.config);
    const items = await client.templates(f.channelId);
    assert.equal(items.length, 2);
    assert.match(calls[0].url, /ApprovedOnly=true/);
    assert.match(calls[0].url, /IncludeDetails=All/);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer fake-test-token');
    await client.reply(f.sessionId, 'Texto');
    assert.deepEqual(JSON.parse(calls[2].options.body), { text: 'Texto' });
  } finally {
    globalThis.fetch = previous;
  }
});

test('resposta inválida após POST é tratada como resultado indeterminado', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response('resposta inválida', { status: 200 });
  try {
    await assert.rejects(new FlwClient(f.config).sendTemplate({ to: '5591999999999' }), (error) => {
      assert.equal(error.uncertain, true);
      assert.equal(error.status, 502);
      return true;
    });
  } finally {
    globalThis.fetch = previous;
  }
});

test('prévia de números colados normaliza DDI, remove duplicados e não salva contatos', async () => {
  const result = await post('/contacts/preview', {
    format: 'paste',
    countryCode: '55',
    text: 'Provedor Alfa;91999999999\n5591999999999\ninválido',
  }).expect(200);
  assert.equal(result.body.unique, 1);
  assert.equal(result.body.duplicates, 1);
  assert.equal(result.body.errors.length, 1);
  assert.equal(result.body.contacts[0].phone, '5591999999999');
  assert.equal(result.body.contacts[0].name, 'Provedor Alfa');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM contacts').get().n, 0);
});

test('TXT pode criar uma lista; importação preserva contato existente sem autorização', async () => {
  await addAudience(false);
  const result = await post('/contacts/import', {
    listName: 'Lista de arquivo',
    optedIn: true,
    audience: { format: 'txt', countryCode: '', text: '5591999999999\nProvedor Beta;5591888888888' },
  }).expect(200);
  assert.equal(result.body.created, 1);
  assert.equal(result.body.linked, 2);
  assert.equal(result.body.blocked, 1);
  assert.equal(
    f.db.prepare('SELECT name FROM lists WHERE id=?').get(result.body.listId).name,
    'Lista de arquivo',
  );
  assert.equal(f.db.prepare('SELECT opted_in FROM contacts WHERE phone=?').get('5591999999999').opted_in, 0);
});

test('campanha aceita APPROVED e parâmetros entre colchetes, criando audiência sem disparar', async () => {
  const originalTemplates = f.flw.templates;
  f.flw.templates = async () =>
    (await originalTemplates()).map((template) => ({
      ...template,
      status: 'APPROVED',
      text: 'Olá, [nome_provedor]! Somos da [nome_empresa].',
      params: [{ name: '[nome_provedor]' }, { name: '[nome_empresa]' }],
    }));
  const body = {
    name: 'Provedores',
    channelId: f.channelId,
    templateId: f.templateId,
    optedIn: true,
    parameters: { '[nome_provedor]': '{{nome}}', '[nome_empresa]': 'Totalk' },
    audience: { format: 'paste', countryCode: '55', text: 'Provedor Alfa;91999999999' },
  };
  await post('/campaigns', { ...body, parameters: {} }).expect(400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lists').get().n, 0);
  await post('/campaigns', { ...body, optedIn: false }).expect(400);
  const result = await post('/campaigns', body).expect(201);
  const campaign = f.db.prepare('SELECT * FROM campaigns WHERE id=?').get(result.body.id);
  assert.equal(campaign.status, 'draft');
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM list_contacts WHERE list_id=?').get(campaign.list_id).n,
    1,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM deliveries').get().n, 0);
});
