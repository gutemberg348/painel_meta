import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync } from 'node:fs';
import { fixture } from './helpers.js';

// Banco em memória e cliente FLW simulado: este teste nunca envia mensagens reais.
const f = fixture();
const server = f.app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let browser, page;
try {
  browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, locale: 'pt-BR' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security|Refused|Uncaught/.test(message.text()))
      errors.push(message.text());
  });
  mkdirSync('test-results', { recursive: true });
  await page.goto(`${url}/login`);
  await page.screenshot({ path: 'test-results/login-desktop.png', fullPage: true });
  await page.locator('[name=username]').fill('admin');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'Entrar no painel' }).click();
  await page.getByRole('heading', { name: 'Visão geral', level: 1 }).waitFor();
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });

  await page.locator('nav [data-page=lists]').click();
  await page.getByRole('button', { name: 'Nova lista', exact: true }).click();
  await page.locator('dialog [name=name]').fill('Clientes especiais');
  await page.locator('dialog [name=description]').fill('Pessoas que querem ficar por dentro das novidades.');
  await page.getByRole('button', { name: 'Criar lista', exact: true }).click();
  await page.getByRole('heading', { name: 'Clientes especiais', exact: true }).waitFor();
  console.log('OK: login e cadastro de lista');

  await page.locator('nav [data-page=contacts]').click();
  await page.getByRole('button', { name: 'Novo contato', exact: true }).click();
  await page.locator('dialog [name=name]').fill('Marina Oliveira');
  await page.locator('dialog [name=phone]').fill('5591999999999');
  await page.locator('dialog [name=email]').fill('marina@example.com');
  await page.locator('dialog [name=listIds]').check();
  await page.locator('dialog button[type=submit]').click();
  await page.locator('#contacts-table .table-primary').filter({ hasText: 'Marina Oliveira' }).waitFor();
  await page.getByRole('button', { name: 'Editar Marina Oliveira' }).click();
  await page.locator('dialog [name=name]').fill('Marina Souza');
  await page.locator('dialog [name=permission]').selectOption('1');
  await page.locator('dialog button[type=submit]').click();
  await page.locator('#contacts-table .table-primary').filter({ hasText: 'Marina Souza' }).waitFor();
  await page.getByRole('button', { name: 'Adicionar em lote', exact: true }).click();
  const savedListId = f.db.prepare('SELECT id FROM lists LIMIT 1').get().id;
  await page.locator('#import-destination').selectOption(savedListId);
  await page.locator('[data-source="file"]').click();
  await page.locator('dialog input[type=file]').setInputFiles({
    name: 'contatos.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('nome,telefone,email\nJoão Teste,5591888888888,joao@example.com'),
  });
  await page.locator('#audience-consent').check();
  await page.locator('dialog button[type=submit]').click();
  await page.locator('#contacts-table .table-primary').filter({ hasText: 'João Teste' }).waitFor();
  await page.screenshot({ path: 'test-results/contacts-desktop.png', fullPage: true });
  console.log('OK: contato, edição, associação e importação CSV');

  await page.locator('nav [data-page=campaigns]').click();
  await page.getByRole('button', { name: 'Nova campanha', exact: true }).click();
  await page.locator('dialog [name=name]').fill('Novidades de novembro');
  await page.locator('#easy-template option[value="' + f.templateId + '"]').waitFor({ state: 'attached' });
  await page.locator('#easy-template').selectOption(f.templateId);
  await page.locator('[data-param="1"]').fill('{{nome}}');
  await page.locator('[data-source="list"]').click();
  await page.locator('#audience-list').selectOption(savedListId);
  await page.screenshot({ path: 'test-results/campaign-compose-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Salvar e revisar envio', exact: true }).click();
  await page.getByRole('button', { name: 'Revisar e disparar', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar disparo', exact: true }).click();
  await page.locator('dialog').waitFor({ state: 'hidden' });
  await f.campaigns.tick();
  await f.campaigns.tick();
  await f.campaigns.tick();
  assert.equal(f.calls.length, 2);
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await page.getByText('Processada', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Ver campanha Novidades de novembro' }).click();
  await page.getByRole('button', { name: 'Atualizar entregas' }).click();
  await page.locator('dialog').getByText('Entregue', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Fechar janela' }).click();
  console.log('OK: rascunho, confirmação, fila simulada e status de entrega');

  await page.locator('nav [data-page=conversations]').click();
  await page.locator('.conversation-item').first().click();
  await page.locator('#messages').getByText('Olá, quero saber mais!', { exact: false }).waitFor();
  await page.locator('#reply-form textarea').fill('Olá, Marina! Como posso ajudar?');
  await page.getByRole('button', { name: 'Enviar resposta' }).click();
  await page.locator('#messages').getByText('Olá, Marina! Como posso ajudar?', { exact: false }).waitFor();
  await page.screenshot({ path: 'test-results/inbox-desktop.png', fullPage: true });
  await page.locator('nav [data-page=templates]').click();
  await page.getByRole('heading', { name: 'boas_vindas' }).waitFor();
  await page.locator('nav [data-page=settings]').click();
  await page.getByRole('button', { name: 'Testar conexão' }).click();
  await page.getByText('Conexão verificada', { exact: true }).waitFor();
  console.log('OK: conversa, resposta simulada, templates e conexão');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    'dashboard',
    'contacts',
    'lists',
    'campaigns',
    'templates',
    'settings',
    'conversations',
  ]) {
    await page.goto(`${url}/#${route}`);
    await page.locator('main h1').waitFor();
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, `Overflow horizontal na tela ${route}`);
    if (route === 'dashboard') {
      await page.locator('.toast').last().waitFor({ state: 'hidden', timeout: 10000 });
      await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
    }
  }
  if (await page.getByRole('button', { name: 'Voltar às conversas' }).isVisible())
    await page.getByRole('button', { name: 'Voltar às conversas' }).click();
  await page.locator('.conversation-item').first().click();
  await page.locator('#reply-form').waitFor();
  await page.locator('#reply-text').fill('Rascunho de atendimento');
  await page.getByRole('button', { name: 'Voltar às conversas' }).click();
  await page.locator('.conversation-list').waitFor({ state: 'visible' });
  await page.locator('.conversation-item').filter({ hasText: 'Rascunho de atendimento' }).click();
  await page.locator('#reply-text').waitFor();
  assert.equal(await page.locator('#reply-text').inputValue(), 'Rascunho de atendimento');
  await page.getByRole('button', { name: 'Voltar às conversas' }).click();
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page.locator('nav [data-page=dashboard]').click();
  await page.getByRole('heading', { name: 'Visão geral', level: 1 }).waitFor();
  assert.deepEqual(errors, []);
  console.log('OK: 7 telas responsivas, navegação mobile e nenhum erro JS/CSP');
  console.log('Capturas salvas em test-results/.');
} catch (error) {
  if (page) await page.screenshot({ path: 'test-results/failure.png', fullPage: true });
  throw error;
} finally {
  await browser?.close();
  f.campaigns.stop();
  await new Promise((resolve) => server.close(resolve));
  f.db.close();
}
