import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { CampaignService } from '../src/services/campaigns.js';
import { createApp } from '../src/app.js';

export function fixture() {
  const config = {
    username: 'admin',
    password: 'test-password',
    sessionSecret: 'test-session-secret-with-at-least-32-characters',
    production: false,
    trustProxy: false,
    apiToken: 'fake-test-token',
    apiBase: 'https://api.wts.chat/chat',
    sendInterval: 500,
    publicUrl: 'https://example.test',
    webhookSecret: 'webhook-test-secret',
  };
  const channelId = randomUUID(),
    templateId = randomUUID(),
    sessionId = randomUUID();
  const calls = [];
  const messages = [
    {
      id: randomUUID(),
      text: 'Olá, quero saber mais!',
      direction: 'FROM_HUB',
      status: 'DELIVERED',
      createdAt: new Date().toISOString(),
      type: 'TEXT',
    },
  ];
  const conversations = [
    {
      id: sessionId,
      channelId,
      title: 'Marina Oliveira',
      number: '5591999999999',
      contactDetails: { name: 'Marina Oliveira' },
      lastMessageText: 'Olá, quero saber mais!',
      unreadCount: 1,
      windowStatus: 'ACTIVE',
      createdAt: new Date().toISOString(),
    },
  ];
  const flw = {
    channels: async () => [
      {
        id: channelId,
        active: true,
        type: 'CloudAPI_WhatsApp',
        number: '5591888888888',
        identity: { displayName: 'Totalk Teste' },
      },
    ],
    templates: async () => [
      {
        id: templateId,
        name: 'boas_vindas',
        text: 'Olá, {{1}}! Vamos conversar?',
        active: true,
        archived: false,
        status: 'Approved',
        channelId,
        params: [{ name: '1' }],
        fileType: 'UNDEFINED',
      },
    ],
    sendTemplate: async (body) => {
      calls.push(body);
      return { id: randomUUID(), sessionId, status: 'QUEUED' };
    },
    messageStatus: async (id) => ({ id, sessionId, status: 'DELIVERED' }),
    sessions: async () => ({ items: conversations, totalItems: conversations.length, hasMorePages: false }),
    session: async () => conversations[0],
    messages: async () => ({ items: messages, totalItems: messages.length, hasMorePages: false }),
    reply: async (id, text) => {
      const message = {
        id: randomUUID(),
        text,
        sessionId: id,
        direction: 'TO_HUB',
        status: 'QUEUED',
        createdAt: new Date().toISOString(),
        type: 'TEXT',
      };
      messages.push(message);
      return message;
    },
  };
  const db = openDatabase(':memory:');
  const campaigns = new CampaignService(db, flw, config);
  const app = createApp({ db, flw, campaigns, config });
  return { config, db, flw, campaigns, app, calls, channelId, templateId, sessionId, conversations };
}

export async function authenticate(agent, username = 'admin', password = 'test-password') {
  const login = await agent.get('/login');
  const csrf = login.text.match(/name="_csrf" value="([^"]+)"/)[1];
  await agent
    .post('/login')
    .type('form')
    .send({ username, password, _csrf: csrf })
    .expect(302);
  const home = await agent.get('/').expect(200);
  return home.text.match(/name="csrf-token" content="([^"]+)"/)[1];
}
