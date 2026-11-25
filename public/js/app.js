/* Totalk Studio — interface sem build. Cada operação é validada pelo servidor. */
const $ = (selector, root = document) => root.querySelector(selector);
const main = $('#main');
const modal = $('#modal');
const csrf = $('meta[name="csrf-token"]').content;
const state = {
  page: '',
  lists: [],
  contacts: [],
  campaigns: [],
  templates: [],
  channels: [],
  conversations: [],
  selectedConversation: null,
  conversationPage: 1,
  messagePage: 1,
  campaignFilter: 'all',
  contactList: '',
  search: '',
};
let navigation = 0;
let refreshBusy = false;
const titles = {
  dashboard: 'Visão geral',
  campaigns: 'Campanhas',
  conversations: 'Caixa de entrada',
  contacts: 'Contatos',
  lists: 'Listas de contatos',
  templates: 'Templates',
  settings: 'Configurações',
};
const icons = () => lucide.createIcons();
const icon = (name) => `<i data-lucide="${name}"></i>`;
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const number = (value) => Number(value || 0).toLocaleString('pt-BR');
const date = (value) =>
  value ? new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : '—';
const time = (value) =>
  value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
const initials = (value) =>
  String(value || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((v) => v[0])
    .join('')
    .toUpperCase();
const phone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 13 && digits.startsWith('55')
    ? `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`
    : `+${digits}`;
};
const statusMap = {
  draft: ['Rascunho', ''],
  running: ['Em andamento', 'blue'],
  paused: ['Pausada', 'orange'],
  completed: ['Processada', 'green'],
  cancelled: ['Cancelada', ''],
  pending: ['Pendente', ''],
  sending: ['Enviando', 'blue'],
  queued: ['Na fila FLW', 'blue'],
  processing: ['Processando', 'blue'],
  saved: ['Aceita pela FLW', 'blue'],
  sent: ['Enviada', 'blue'],
  delivered: ['Entregue', 'green'],
  read: ['Lida', 'purple'],
  failed: ['Falhou', 'red'],
  unknown: ['Verificar na FLW', 'orange'],
  skipped: ['Ignorada', ''],
  deleted: ['Excluída', ''],
  wait_reply: ['Aguardando resposta', 'blue'],
};
function badge(status) {
  const [label, color] = statusMap[String(status).toLowerCase()] || [status, ''];
  return `<span class="badge ${color}">${escape(label)}</span>`;
}
function button(label, action, glyph = 'plus', variant = 'primary', attrs = '') {
  return `<button type="button" class="button ${variant}" data-action="${action}" ${attrs}>${icon(glyph)}${label}</button>`;
}
function pageHeading(title, subtitle, actions = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function empty(title, description, action = '', glyph = 'inbox', compact = false) {
  return `<div class="empty-state ${compact ? 'compact' : ''}"><span class="empty-icon">${icon(glyph)}</span><h3>${title}</h3><p>${description}</p>${action}</div>`;
}
const loading = () => '<div class="loading-state"><span class="spinner"></span>Carregando...</div>';

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 401) {
    window.location.href = '/login';
    throw new Error('Sua sessão expirou.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      [data.error || 'Não foi possível concluir a operação.', ...(data.details || [])].join('\n'),
    );
  return data;
}
function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast ${error ? 'error' : ''}`;
  element.innerHTML = `${icon(error ? 'circle-alert' : 'circle-check')}<span>${escape(message)}</span>`;
  $('#toasts').append(element);
  icons();
  setTimeout(() => element.remove(), error ? 9000 : 5000);
}
function connectionBanner() {
  return `<div class="alert">${icon('plug-zap')}<span>Conecte sua conta FLW para carregar canais, templates e conversas. Configure o token no <strong>.env</strong> e reinicie o servidor. <a href="#settings">Ver configuração</a></span></div>`;
}

async function renderPage(silent = false) {
  const page = window.location.hash.slice(1).split('?')[0] || 'dashboard';
  state.page = titles[page] ? page : 'dashboard';
  const current = ++navigation;
  $('#breadcrumb-title').textContent = titles[state.page];
  document.title = `${titles[state.page]} · Totalk Studio`;
  document.querySelectorAll('[data-page]').forEach((link) => {
    const currentPage = link.dataset.page === state.page;
    link.classList.toggle('active', currentPage);
    if (currentPage) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (!silent) setMenuOpen(false);
  if (!silent) main.innerHTML = loading();
  try {
    const html = await pages[state.page]();
    if (current !== navigation) return;
    main.innerHTML = html;
    icons();
    if (state.page === 'conversations' && state.selectedConversation)
      await openConversation(state.selectedConversation.id, false);
  } catch (error) {
    if (current !== navigation) return;
    main.innerHTML =
      pageHeading(titles[state.page], 'Seu workspace, sempre conectado.') +
      `<div class="panel">${empty('Não foi possível carregar', escape(error.message), button('Tentar novamente', 'refresh', 'refresh-cw'), 'cloud-off')}</div>`;
    icons();
  }
}

function chart(activity) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 6 + i);
    const key = d.toISOString().slice(0, 10);
    return {
      label: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }),
      ...(activity.find((a) => a.day === key) || { total: 0, delivered: 0 }),
    };
  });
  const max = Math.max(4, ...days.map((d) => d.total));
  const points = days.map((d, i) => `${45 + i * 70},${125 - (d.total / max) * 100}`);
  const delivered = days.map((d, i) => `${45 + i * 70},${125 - (d.delivered / max) * 100}`);
  return `<svg class="chart-svg" viewBox="0 0 490 160" role="img" aria-label="Atividade de envios nos últimos sete dias. ${number(days.reduce((s, d) => s + d.total, 0))} registros atualizados.">
    <defs><linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#76b1fa" stop-opacity=".2"/><stop offset="100%" stop-color="#76b1fa" stop-opacity="0"/></linearGradient></defs>
    ${[0, 1, 2, 3, 4].map((i) => `<line class="chart-grid" x1="40" y1="${25 + i * 25}" x2="478" y2="${25 + i * 25}"/><text x="0" y="${29 + i * 25}">${Math.round(max * (1 - i / 4))}</text>`).join('')}
    <path class="chart-area" d="M45,125 L${points.join(' L')} L465,125 Z"/><polyline class="chart-line" points="${points.join(' ')}"/><polyline class="chart-delivered" points="${delivered.join(' ')}" fill="none" stroke-width="2"/>
    ${days.map((d, i) => `<text x="${45 + i * 70}" y="151" text-anchor="middle">${d.label}</text>`).join('')}</svg>`;
}
function campaignTable(rows, compact = false) {
  if (!rows.length)
    return empty(
      'Nenhuma campanha para exibir',
      'Crie uma campanha com um template aprovado e uma lista de destinatários.',
      button('Criar primeira campanha', 'new-campaign', 'plus', 'primary small'),
      'send',
      compact,
    );
  return `<div class="table-wrap"><table><thead><tr><th>Campanha</th><th>Status</th><th>Destinatários</th><th>Entregues</th><th>Criada em</th><th></th></tr></thead><tbody>${rows
    .map(
      (c) => `<tr>
    <td><div class="cell-title"><span class="row-icon">${icon('send')}</span><div class="table-primary">${escape(c.name)}<small>${escape(c.list_name)}</small></div></div></td><td>${badge(c.status)}</td><td>${number(c.total)}</td><td>${number(c.delivered)} <span class="muted">/ ${number(c.total)}</span></td><td>${date(c.created_at)}</td><td><button class="icon-button" data-action="campaign-details" data-id="${c.id}" title="Ver campanha" aria-label="Ver campanha ${escape(c.name)}">${icon('ellipsis')}</button></td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}
const pages = {
  async dashboard() {
    const data = await api('/overview');
    state.configured = data.configured;
    state.campaigns = data.campaigns;
    updateConnection(data.configured);
    const ready = [data.configured, data.contacts > 0, data.lists > 0, data.campaigns.length > 0];
    const activityCount = data.activity.reduce((sum, day) => sum + day.total, 0);
    const readyCount = ready.filter(Boolean).length;
    const deliveryShare = data.totals.total
      ? `${Math.round((data.totals.delivered / data.totals.total) * 100)}% dos destinatários`
      : 'Sem destinatários ainda';
    const metrics = [
      ['Envios aceitos', data.totals.accepted, 'send', '', 'Recebidos pela FLW'],
      ['Entregues', data.totals.delivered, 'check-check', 'green', deliveryShare],
      ['Mensagens lidas', data.totals.read, 'eye', 'purple', 'Leituras confirmadas'],
      ['Contatos', data.contacts, 'users-round', 'orange', `${number(data.lists)} ${data.lists === 1 ? 'lista cadastrada' : 'listas cadastradas'}`],
    ];
    const steps = [
      ['Configurar integração', 'settings'],
      ['Adicionar contatos', 'contacts'],
      ['Organizar uma lista', 'lists'],
      ['Criar primeira campanha', 'campaigns'],
    ];
    return pageHeading(
      'Visão geral',
      'Acompanhe os envios e a atividade do seu WhatsApp.',
      button('Nova campanha', 'new-campaign'),
    ) + `
      <section class="stats-grid" aria-label="Indicadores acumulados">
        ${metrics.map(([label, value, glyph, color, foot]) => `
          <article class="stat-card">
            <div class="stat-top"><h2>${label}</h2><span class="stat-icon ${color}">${icon(glyph)}</span></div>
            <div class="stat-value">${number(value)}</div><div class="stat-foot">${foot}</div>
          </article>`).join('')}
      </section>
      <div class="dashboard-grid">
        <section class="panel activity-panel">
          <div class="panel-head">
            <h2>Atividade de mensagens</h2>
            <span class="period-label">${icon('calendar-days')}Últimos 7 dias</span>
          </div>
          <div class="chart">
            <div class="chart-summary"><strong>${number(activityCount)}</strong><span>destinatários com atualização no período (UTC)</span></div>
            ${chart(data.activity)}
            <div class="chart-legend"><span><i class="legend-line"></i>Destinatários</span><span><i class="legend-line pale"></i>Entregues</span></div>
          </div>
        </section>
        <section class="panel shortcuts">
          <div class="panel-head"><h2>Ações rápidas</h2></div>
          <button class="shortcut" data-action="import-contacts"><span>${icon('file-up')}</span><span><strong>Importar números</strong><small>Cole contatos ou carregue CSV e TXT</small></span></button>
          <a class="shortcut" href="#conversations"><span>${icon('inbox')}</span><span><strong>Abrir caixa de entrada</strong><small>Ler e responder conversas</small></span></a>
          <a class="shortcut" href="#templates"><span>${icon('panels-top-left')}</span><span><strong>Consultar templates</strong><small>Ver modelos aprovados para envio</small></span></a>
        </section>
      </div>
      <section class="panel"><div class="panel-head"><h2>Campanhas recentes</h2><a href="#campaigns" class="button ghost">Ver todas</a></div>${campaignTable(data.campaigns.slice(0, 4), true)}</section>
      ${readyCount < steps.length ? `<section class="panel setup-panel"><div class="panel-head"><h2>Configuração inicial</h2><span class="period-label">${readyCount} de ${steps.length} etapas</span></div>
        <div class="setup-list">${steps.map(([label, route], index) => `<a class="setup-step" href="#${route}"><span class="step-number ${ready[index] ? 'done' : ''}">${icon(ready[index] ? 'check' : 'circle')}</span><strong>${label}</strong><span class="sr-only">${ready[index] ? 'Concluída' : 'Pendente'}</span></a>`).join('')}</div></section>` : ''}`;
  },
  async campaigns() {
    state.campaigns = await api('/campaigns');
    return (
      pageHeading(
        'Campanhas',
        'Crie, acompanhe e gerencie suas campanhas de WhatsApp.',
        button('Nova campanha', 'new-campaign'),
      ) +
      `<div class="toolbar"><div class="tabs">${[
        ['all', 'Todas'],
        ['draft', 'Rascunhos'],
        ['running', 'Em andamento'],
        ['paused', 'Pausadas'],
        ['completed', 'Processadas'],
      ]
        .map(
          ([key, label]) =>
            `<button class="tab ${state.campaignFilter === key ? 'active' : ''}" data-action="filter-campaigns" data-filter="${key}">${label}</button>`,
        )
        .join(
          '',
        )}</div>${button('Atualizar', 'refresh', 'refresh-cw', '')}</div><div class="panel" id="campaign-table">${campaignTable(state.campaigns.filter((c) => state.campaignFilter === 'all' || c.status === state.campaignFilter))}</div>`
    );
  },
  async lists() {
    state.lists = await api('/lists');
    return (
      pageHeading(
        'Listas de contatos',
        'Organize sua audiência em listas e personalize suas campanhas.',
        button('Nova lista', 'new-list', 'folder-plus'),
      ) +
      `<div class="list-grid">${state.lists.map((list) => `<article class="list-card"><div class="list-card-top"><span class="folder-icon ${list.color}">${icon('folder-open')}</span><div class="card-actions"><button class="icon-button" data-action="edit-list" data-id="${list.id}" aria-label="Editar lista ${escape(list.name)}">${icon('pencil')}</button><button class="icon-button" data-action="delete-list" data-id="${list.id}" aria-label="Excluir lista ${escape(list.name)}">${icon('trash-2')}</button></div></div><h3>${escape(list.name)}</h3><p>${escape(list.description || 'Uma lista pronta para novas conexões.')}</p><div class="list-card-footer"><span class="list-count"><strong>${number(list.contact_count)}</strong> contatos</span><button class="button ghost" data-action="list-contacts" data-id="${list.id}">Ver contatos</button></div><small class="muted">${number(list.opted_in_count)} com autorização de envio</small></article>`).join('')}<button class="list-card-new" data-action="new-list">${icon('folder-plus')}Criar uma nova lista</button></div>`
    );
  },
  async contacts() {
    [state.contacts, state.lists] = await Promise.all([api('/contacts'), api('/lists')]);
    return (
      pageHeading(
        'Contatos',
        `${number(state.contacts.length)} contatos cadastrados no painel.`,
        button('Adicionar em lote', 'import-contacts', 'upload', '') +
          button('Novo contato', 'new-contact', 'user-plus'),
      ) +
      `<div class="toolbar"><div class="toolbar-left"><div class="search-field">${icon('search')}<input id="contact-search" placeholder="Buscar nome, telefone ou e-mail..." aria-label="Buscar contatos" value="${escape(state.search)}"></div><select id="contact-list-filter" aria-label="Filtrar por lista"><option value="">Todas as listas</option>${state.lists.map((l) => `<option value="${l.id}" ${state.contactList === l.id ? 'selected' : ''}>${escape(l.name)}</option>`).join('')}</select></div><span class="badge blue">${icon('shield-check')}Autorização por contato</span></div><div class="panel" id="contacts-table">${contactsTable()}</div>`
    );
  },
  async templates() {
    const settings = await api('/settings');
    if (!settings.configured)
      return (
        pageHeading(
          'Templates de mensagem',
          'Seus templates aprovados, prontos para iniciar uma conversa.',
        ) +
        connectionBanner() +
        `<div class="panel">${empty('Seus templates aparecerão aqui', 'Conecte sua conta para consultar os modelos aprovados na FLW.', '<a class="button primary" href="#settings">Configurar integração</a>', 'panels-top-left')}</div>`
      );
    state.templates = await api('/templates');
    return (
      pageHeading(
        'Templates de mensagem',
        'Templates aprovados e sincronizados com sua conta FLW.',
        button('Sincronizar templates', 'refresh', 'refresh-cw', ''),
      ) +
      `<div class="alert">${icon('info')}<span>A criação e a aprovação dos modelos são feitas na plataforma FLW/Meta. Aqui você escolhe os modelos aprovados para suas campanhas.</span></div>` +
      (state.templates.length
        ? `<div class="list-grid">${state.templates.map((t) => `<article class="template-card"><span class="badge green">${icon('check-check')}Aprovado</span><h3>${escape(t.name)}</h3><div class="message-preview">${escape(t.text || 'Template com mídia ou conteúdo interativo.')}</div><div class="template-card-footer"><span>${number(t.params?.length)} variáveis · ${escape(t.fileType && t.fileType !== 'UNDEFINED' ? t.fileType.toLowerCase() : 'texto')}</span><button class="button ghost" data-action="use-template" data-id="${escape(t.id)}">Usar template</button></div></article>`).join('')}</div>`
        : `<div class="panel">${empty('Nenhum template aprovado', 'Crie um modelo na FLW e aguarde a aprovação para começar os disparos.', '', 'panels-top-left')}</div>`)
    );
  },
  async conversations() {
    const settings = await api('/settings');
    if (!settings.configured)
      return (
        pageHeading('Caixa de entrada', 'Acompanhe suas conversas e continue de onde parou.') +
        connectionBanner() +
        `<div class="panel">${empty('Sua caixa de entrada, conectada', 'As conversas reais da sua conta aparecerão aqui assim que a integração estiver configurada.', '<a class="button primary" href="#settings">Configurar integração</a>', 'messages-square')}</div>`
      );
    const data = await api(`/conversations?page=${state.conversationPage}`);
    state.conversations = data.items || [];
    return (
      pageHeading(
        'Caixa de entrada',
        'Conversas da sua conta FLW · atualização automática a cada 15 segundos.',
        button('Atualizar', 'refresh', 'refresh-cw', ''),
      ) +
      `<div class="inbox" id="inbox"><section class="conversation-list"><div class="conversation-list-head"><h3>Conversas <span class="badge blue">${number(data.totalItems)}</span></h3><div class="search-field">${icon('search')}<input id="conversation-search" placeholder="Buscar nesta página..." aria-label="Buscar conversas nesta página"></div></div><div class="conversation-items" id="conversation-items">${conversationItems()}</div><div class="pagination"><button class="icon-button" data-action="conversation-prev" ${state.conversationPage <= 1 ? 'disabled' : ''} aria-label="Página anterior">${icon('chevron-left')}</button>Página ${state.conversationPage}<button class="icon-button" data-action="conversation-next" ${!data.hasMorePages ? 'disabled' : ''} aria-label="Próxima página">${icon('chevron-right')}</button></div></section><section class="conversation-thread" id="conversation-thread"><div class="thread-empty">${empty('Selecione uma conversa', 'Selecione um contato ao lado para visualizar as mensagens e responder.', '', 'messages-square')}</div></section></div>`
    );
  },
  async settings() {
    const data = await api('/settings');
    updateConnection(data.configured);
    return (
      pageHeading(
        'Configurações',
        'Gerencie a integração e confira as configurações do workspace.',
      ) +
      `<div class="settings-grid"><section class="panel"><div class="panel-head"><div><h2>Integração FLW Chat</h2><p>Seus canais e mensagens em um só lugar.</p></div><span class="stat-icon">${icon('plug-zap')}</span></div><div class="settings-body"><div class="settings-row"><div><strong>Token da API</strong><small>${data.configured ? 'Token configurado no servidor. Teste para validar.' : 'Adicione seu token permanente no arquivo .env.'}</small></div><span class="badge ${data.configured ? 'blue' : 'orange'}">${data.configured ? 'Configurado' : 'Não configurado'}</span></div><div class="settings-row"><div><strong>Endereço da API</strong><small>Servidor usado nas requisições</small></div><code>${escape(data.apiBase)}</code></div><div class="settings-row"><div><strong>Intervalo entre envios</strong><small>Fila persistente com processamento individual</small></div><span class="badge blue">${data.sendInterval / 1000}s / contato</span></div><div class="settings-row"><div><strong>Callbacks de entrega</strong><small>${data.webhookConfigured ? `Último evento: ${data.lastWebhook ? date(data.lastWebhook) + ' às ' + time(data.lastWebhook) : 'nenhum recebido'}` : 'Opcional. Configure PUBLIC_URL e WEBHOOK_SECRET.'}</small></div><span class="badge ${data.webhookConfigured ? 'green' : ''}">${data.webhookConfigured ? 'Configurado' : 'Não configurado'}</span></div><div class="settings-row"><div><strong>Administrador</strong><small>Usuário definido em ADMIN_USERNAME</small></div><span class="badge">${escape(data.username)}</span></div><div class="settings-row"><div><strong>Validar integração</strong><small>Consulta seus canais sem enviar mensagens.</small></div>${button('Testar conexão', 'test-connection', 'activity', 'primary', data.configured ? '' : 'disabled')}</div><div id="connection-result"></div></div></section>
      <aside class="settings-guide">${icon('book-open')}<h3>Conecte em poucos passos</h3><p>O token fica protegido no servidor. Ele não é enviado ao navegador.</p><ol><li>Na FLW, abra <strong>Ajustes → Integrações → Integração via API</strong>.</li><li>Copie seu token permanente.</li><li>Preencha <strong>FLW_API_TOKEN</strong> no arquivo <strong>.env</strong> deste projeto.</li><li>Reinicie o servidor e teste a conexão.</li></ol><a class="button" href="https://flwchat.readme.io/reference/autentica%C3%A7%C3%A3o" target="_blank" rel="noreferrer">${icon('external-link')}Consultar documentação</a><p>As respostas são consultadas diretamente na API. O webhook é opcional para atualizar as entregas.</p></aside></div>`
    );
  },
};

function updateConnection(configured, verified = false) {
  const element = $('#connection-badge');
  element.classList.toggle('connected', verified);
  element.innerHTML = `<span class="status-dot"></span>${verified ? 'Conexão verificada' : configured ? 'Token configurado' : 'Conexão pendente'}`;
}
function contactsTable() {
  const query = state.search.toLocaleLowerCase();
  const rows = state.contacts.filter(
    (c) =>
      (!state.contactList || c.lists.some((l) => l.id === state.contactList)) &&
      `${c.name} ${c.phone} ${c.email}`.toLocaleLowerCase().includes(query),
  );
  if (!rows.length)
    return empty(
      state.contacts.length ? 'Nenhum contato encontrado' : 'Nenhum contato cadastrado',
      state.contacts.length
        ? 'Experimente outro nome ou selecione uma lista diferente.'
        : 'Cadastre um contato, cole vários números ou importe um arquivo CSV ou TXT.',
      button('Adicionar contato', 'new-contact', 'user-plus', 'primary small'),
      'users-round',
    );
  return `<div class="table-wrap"><table><thead><tr><th>Contato</th><th>WhatsApp</th><th>Listas</th><th>Permissão de envio</th><th></th></tr></thead><tbody>${rows
    .map(
      (c) =>
        `<tr><td><div class="cell-title"><span class="avatar">${escape(initials(c.name))}</span><div class="table-primary">${escape(c.name)}<small>${escape(c.email || 'Sem e-mail')}</small></div></div></td><td>${escape(phone(c.phone))}</td><td>${
          c.lists.length
            ? c.lists
                .slice(0, 2)
                .map((l) => `<span class="badge blue">${escape(l.name)}</span>`)
                .join(' ') + (c.lists.length > 2 ? ` +${c.lists.length - 2}` : '')
            : '<span class="muted">Sem lista</span>'
        }</td><td><span class="badge ${c.opted_in ? 'green' : 'orange'}">${c.opted_in ? 'Autorizado' : 'Sem autorização'}</span></td><td><div class="row-actions"><button class="icon-button" data-action="edit-contact" data-id="${c.id}" aria-label="Editar ${escape(c.name)}">${icon('pencil')}</button><button class="icon-button" data-action="delete-contact" data-id="${c.id}" aria-label="Excluir ${escape(c.name)}">${icon('trash-2')}</button></div></td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

function showModal(title, subtitle, body, footer = '', wide = false, formId = '') {
  modal.classList.remove('composer-modal');
  modal.classList.toggle('wide', wide);
  $('#modal-content').innerHTML =
    `${formId ? `<form id="${formId}" class="modal-form">` : ''}<div class="modal-header"><div><h2 id="modal-title">${title}</h2><p>${subtitle}</p></div><button type="button" class="icon-button" data-action="close-modal" aria-label="Fechar janela">${icon('x')}</button></div><div class="modal-body">${body}</div><div class="alert error modal-error" id="modal-error" role="alert"></div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}${formId ? '</form>' : ''}`;
  modal.setAttribute('aria-labelledby', 'modal-title');
  if (!modal.open) modal.showModal();
  icons();
}
const cancelButton = '<button type="button" class="button" data-action="close-modal">Cancelar</button>';
function formFooter(text) {
  return `${cancelButton}<button type="submit" class="button primary">${icon('check')}${text}</button>`;
}
function bindForm(id, handler) {
  $(`#${id}`).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const errorBox = $('#modal-error');
    errorBox.classList.remove('visible');
    submit.disabled = true;
    try {
      await handler(new FormData(form), form);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.add('visible');
    } finally {
      submit.disabled = false;
    }
  });
}
function confirmDialog({ title, text, label = 'Confirmar', danger = false, action }) {
  showModal(
    title,
    'Confira antes de continuar.',
    `<p class="muted">${text}</p>`,
    `${cancelButton}<button type="submit" class="button ${danger ? 'danger' : 'primary'}">${label}</button>`,
    false,
    'confirmation-form',
  );
  bindForm('confirmation-form', async () => {
    await action();
    modal.close();
    await renderPage(true);
  });
}
function listModal(list) {
  showModal(
    list ? 'Editar lista' : 'Nova lista',
    'Organize seus contatos por público, interesse ou campanha.',
    `<div class="form-stack"><label>Nome da lista<input name="name" required maxlength="120" placeholder="Ex.: Clientes especiais" value="${escape(list?.name)}" autofocus></label><label>Descrição<textarea name="description" maxlength="500" placeholder="Para quem é esta lista?">${escape(list?.description)}</textarea></label><label>Cor da lista<select name="color">${[
      ['blue', 'Azul'],
      ['purple', 'Lilás'],
      ['green', 'Verde'],
      ['orange', 'Laranja'],
    ]
      .map(([v, label]) => `<option value="${v}" ${list?.color === v ? 'selected' : ''}>${label}</option>`)
      .join('')}</select></label></div>`,
    formFooter(list ? 'Salvar alterações' : 'Criar lista'),
    false,
    'list-form',
  );
  bindForm('list-form', async (form) => {
    await api(list ? `/lists/${list.id}` : '/lists', {
      method: list ? 'PUT' : 'POST',
      body: Object.fromEntries(form),
    });
    modal.close();
    toast(list ? 'Lista atualizada.' : 'Lista criada. Hora de adicionar seus contatos!');
    await renderPage(true);
  });
}
async function contactModal(contact) {
  state.lists = await api('/lists');
  showModal(
    contact ? 'Editar contato' : 'Novo contato',
    'Mantenha as informações da sua audiência organizadas.',
    `<div class="form-stack"><label>Nome completo<input name="name" required maxlength="120" placeholder="Ex.: Marina Oliveira" value="${escape(contact?.name)}" autofocus></label><div class="form-grid"><label>WhatsApp com DDI e DDD<input name="phone" required inputmode="tel" placeholder="55 91 99999-9999" value="${escape(contact?.phone)}"><p class="field-hint">Inclua o código do país. Ex.: 55 para Brasil.</p></label><label>E-mail <span class="muted">(opcional)</span><input name="email" type="email" placeholder="contato@empresa.com" value="${escape(contact?.email)}"></label></div><div><span class="field-label">Adicionar às listas</span>${state.lists.length ? `<div class="check-grid">${state.lists.map((l) => `<label class="check-label"><input type="checkbox" name="listIds" value="${l.id}" ${contact?.lists.some((item) => item.id === l.id) || (!contact && state.contactList === l.id) ? 'checked' : ''}>${escape(l.name)}</label>`).join('')}</div>` : '<p class="field-hint">Você pode criar listas e associar este contato depois.</p>'}</div><label class="check-label"><input type="checkbox" name="optedIn" ${contact?.opted_in ? 'checked' : ''}>Este contato autorizou o recebimento de mensagens pelo WhatsApp.</label></div>`,
    formFooter(contact ? 'Salvar alterações' : 'Adicionar contato'),
    false,
    'contact-form',
  );
  bindForm('contact-form', async (form) => {
    await api(contact ? `/contacts/${contact.id}` : '/contacts', {
      method: contact ? 'PUT' : 'POST',
      body: {
        name: form.get('name'),
        phone: form.get('phone'),
        email: form.get('email'),
        optedIn: form.has('optedIn'),
        listIds: form.getAll('listIds'),
      },
    });
    modal.close();
    toast('Contato salvo com sucesso.');
    await renderPage(true);
  });
}
async function importModal() {
  return openEasyImport();
}

async function campaignModal() {
  return openEasyCampaign();
}

async function campaignDetails(id) {
  const [campaign, lists] = await Promise.all([api(`/campaigns/${id}`), api('/lists')]);
  const authorized = lists.find((list) => list.id === campaign.list_id)?.opted_in_count || 0;
  state.currentCampaign = campaign;
  const pending = campaign.deliveries.filter((d) => d.status === 'pending').length;
  let actions = '';
  if (['draft', 'paused'].includes(campaign.status))
    actions += button(
      campaign.status === 'paused' ? `Continuar (${pending} pendentes)` : 'Revisar e disparar',
      'start-campaign',
      'send',
      'primary',
      `data-id="${id}"`,
    );
  if (campaign.status === 'running')
    actions += button('Pausar campanha', 'pause-campaign', 'pause', '', `data-id="${id}"`);
  if (['draft', 'paused', 'running'].includes(campaign.status))
    actions += button('Cancelar campanha', 'cancel-campaign', 'circle-x', '', `data-id="${id}"`);
  if (campaign.deliveries.length)
    actions += button('Atualizar entregas', 'sync-campaign', 'refresh-cw', '', `data-id="${id}"`);
  const content = `<div class="detail-bar"><div><span>Status</span><strong>${badge(campaign.status)}</strong></div><div><span>Destinatários</span><strong>${number(campaign.status === 'draft' ? authorized : campaign.deliveries.length)}</strong></div><div><span>Lista</span><strong>${escape(campaign.list_name)}</strong></div><div><span>Template</span><strong>${escape(campaign.template_name)}</strong></div></div><div class="template-preview"><div class="message-preview">${escape(templateText(campaign.template_text, JSON.parse(campaign.parameters)))}</div></div><div class="review-variables">${Object.entries(
    JSON.parse(campaign.parameters),
  )
    .map(
      ([key, value]) =>
        `<div><span>${escape(friendlyVariable(key))}</span><strong>${escape(value)}</strong></div>`,
    )
    .join(
      '',
    )}</div><p class="field-hint">“Processada” indica que a fila local terminou. Entrega e leitura dependem das confirmações da FLW. Um envio em andamento pode terminar após pausar ou cancelar.</p>${campaign.deliveries.length ? `<div class="table-wrap"><table><thead><tr><th>Contato</th><th>Telefone</th><th>Status</th><th>Detalhes</th></tr></thead><tbody>${campaign.deliveries.map((d) => `<tr><td>${escape(d.name)}</td><td>${escape(phone(d.phone))}</td><td>${badge(d.status)}</td><td class="text-break">${escape(d.error || '—')}</td></tr>`).join('')}</tbody></table></div>` : `<div class="alert">${icon('info')}Os destinatários serão definidos no início do disparo, considerando a lista e as autorizações atuais.</div>`}`;
  showModal(
    escape(campaign.name),
    campaign.status === 'draft'
      ? 'Confira a mensagem, as variáveis e os destinatários antes de confirmar.'
      : 'Acompanhe o resultado de cada destinatário.',
    content,
    actions,
    true,
  );
}

function conversationItems(query = '') {
  const rows = state.conversations.filter((c) =>
    `${c.contactDetails?.name || c.title || ''} ${c.number || ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  if (!rows.length)
    return empty(
      'Nenhuma conversa por aqui',
      'As conversas da sua conta aparecerão nesta lista.',
      '',
      'messages-square',
      true,
    );
  return rows
    .map(
      (c) =>
        `<button class="conversation-item ${state.selectedConversation?.id === c.id ? 'active' : ''}" data-action="open-conversation" data-id="${escape(c.id)}"><span class="avatar ${c.unreadCount ? 'mint' : ''}">${escape(initials(c.contactDetails?.name || c.title))}</span><div class="conversation-item-content"><strong>${escape(c.contactDetails?.name || c.title || c.number || 'Contato')}</strong><p>${escape(c.lastMessageText || 'Ver conversa')}</p></div><div><small>${date(c.lastInteractionDate || c.createdAt)}</small>${c.unreadCount ? `<br><span class="badge blue">${number(c.unreadCount)}</span>` : ''}</div></button>`,
    )
    .join('');
}
let conversationRequest = 0;
async function openConversation(id, reset = true) {
  const conversation = state.conversations.find((c) => c.id === id) || state.selectedConversation;
  if (!conversation) return;
  state.selectedConversation = conversation;
  if (reset) state.messagePage = 1;
  const request = ++conversationRequest;
  const thread = $('#conversation-thread');
  if (!thread) return;
  $('#inbox').classList.add('thread-open');
  document
    .querySelectorAll('.conversation-item')
    .forEach((row) => row.classList.toggle('active', row.dataset.id === id));
  thread.innerHTML = loading();
  try {
    const data = await api(`/conversations/${id}/messages?page=${state.messagePage}`);
    if (request !== conversationRequest || !thread.isConnected) return;
    const active = conversation.windowStatus === 'ACTIVE';
    thread.innerHTML = `<header class="thread-head"><button class="icon-button thread-back hidden" data-action="back-conversations" aria-label="Voltar às conversas">${icon('chevron-left')}</button><span class="avatar">${escape(initials(conversation.contactDetails?.name || conversation.title))}</span><div><strong>${escape(conversation.contactDetails?.name || conversation.title || 'Contato')}</strong><small>${escape(phone(conversation.number || conversation.contactDetails?.phonenumber))}</small></div><span class="badge ${active ? 'green' : 'orange'}">${active ? 'Janela aberta' : 'Janela fechada'}</span></header><div class="messages" id="messages">${messageItems(data)}</div><div class="pagination"><button class="button small" data-action="messages-older" ${!data.hasMorePages ? 'disabled' : ''}>Mensagens anteriores</button><span>Página ${state.messagePage}</span><button class="button small" data-action="messages-newer" ${state.messagePage <= 1 ? 'disabled' : ''}>Mais recentes</button></div>${active ? `<form class="reply-form" id="reply-form"><textarea name="text" placeholder="Escreva sua resposta..." aria-label="Sua resposta" required maxlength="4096"></textarea><button class="button primary" type="submit" aria-label="Enviar resposta">${icon('send')}Enviar</button></form>` : '<div class="alert warning">A janela de atendimento está fechada. Use um template aprovado em uma campanha para iniciar uma nova conversa.</div>'}`;
    icons();
    $('#messages').scrollTop = $('#messages').scrollHeight;
    $('#reply-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = $('button', form);
      const field = $('textarea', form);
      const text = field.value.trim();
      if (!text) return;
      submit.disabled = true;
      try {
        const result = await api(`/conversations/${id}/reply`, { method: 'POST', body: { text } });
        field.value = '';
        toast(
          `Resposta recebida pela FLW. Status: ${statusMap[result.status?.toLowerCase()]?.[0] || result.status || 'na fila'}.`,
        );
        await refreshMessages();
      } catch (error) {
        toast(error.message, true);
      } finally {
        submit.disabled = false;
      }
    });
  } catch (error) {
    if (request === conversationRequest)
      thread.innerHTML = empty(
        'Não foi possível carregar as mensagens',
        escape(error.message),
        button('Tentar novamente', 'reload-conversation', 'refresh-cw'),
        'cloud-off',
      );
    icons();
  }
}
function messageItems(data) {
  const messages = [...(data.items || [])].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return messages.length
    ? messages
        .map(
          (m) =>
            `<div class="message ${m.direction === 'FROM_HUB' ? 'outgoing' : ''}">${escape(m.text || `[${m.type || 'Mídia'} — consulte o arquivo na FLW]`)}<span class="message-time">${date(m.createdAt)} · ${time(m.createdAt)} ${m.direction === 'FROM_HUB' ? `· ${escape(statusMap[m.status?.toLowerCase()]?.[0] || m.status)}` : ''}</span></div>`,
        )
        .join('')
    : empty(
        'Ainda sem mensagens',
        'As mensagens desta conversa aparecerão aqui.',
        '',
        'message-circle',
        true,
      );
}
async function refreshMessages() {
  const id = state.selectedConversation?.id;
  const element = $('#messages');
  if (!id || !element) return;
  const page = state.messagePage;
  const data = await api(`/conversations/${id}/messages?page=${page}`);
  if (!element.isConnected || state.selectedConversation?.id !== id || state.messagePage !== page) return;
  const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  element.innerHTML = messageItems(data);
  icons();
  if (nearBottom) element.scrollTop = element.scrollHeight;
}

const actions = {
  refresh: () => renderPage(true),
  'close-modal': () => modal.close(),
  'go-settings': () => {
    modal.close();
    window.location.hash = 'settings';
  },
  'new-list': () => listModal(),
  'edit-list': (element) => listModal(state.lists.find((l) => l.id === element.dataset.id)),
  'delete-list': (element) =>
    confirmDialog({
      title: 'Excluir esta lista?',
      text: 'Os contatos serão preservados. Apenas a lista e seus vínculos serão removidos.',
      label: 'Excluir lista',
      danger: true,
      action: () => api(`/lists/${element.dataset.id}`, { method: 'DELETE' }),
    }),
  'list-contacts': (element) => {
    state.contactList = element.dataset.id;
    state.search = '';
    window.location.hash = 'contacts';
  },
  'new-contact': () => contactModal(),
  'edit-contact': (element) => contactModal(state.contacts.find((c) => c.id === element.dataset.id)),
  'delete-contact': (element) =>
    confirmDialog({
      title: 'Excluir este contato?',
      text: 'O contato será removido de todas as listas. O histórico de campanhas será preservado e os envios pendentes para ele serão ignorados.',
      label: 'Excluir contato',
      danger: true,
      action: () => api(`/contacts/${element.dataset.id}`, { method: 'DELETE' }),
    }),
  'import-contacts': () => importModal(),
  'download-csv': () => {
    const url = URL.createObjectURL(
      new Blob(['\uFEFFnome,telefone,email\r\n'], { type: 'text/csv;charset=utf-8;' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'modelo-contatos.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  'filter-campaigns': (element) => {
    state.campaignFilter = element.dataset.filter;
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === element));
    $('#campaign-table').innerHTML = campaignTable(
      state.campaigns.filter((c) => state.campaignFilter === 'all' || c.status === state.campaignFilter),
    );
    icons();
  },
  'new-campaign': () => campaignModal(),
  'campaign-details': (element) => campaignDetails(element.dataset.id),
  'start-campaign': async (element) => {
    const campaign = await api(`/campaigns/${element.dataset.id}`);
    const lists = await api('/lists');
    const list = lists.find((l) => l.id === campaign.list_id);
    const total =
      campaign.status === 'paused'
        ? campaign.deliveries.filter((d) => d.status === 'pending').length
        : list?.opted_in_count || 0;
    if (!total) throw new Error('Não há contatos autorizados pendentes para enviar nesta campanha.');
    confirmDialog({
      title: `Enviar para ${number(total)} contato(s)?`,
      text: `A campanha <strong>${escape(campaign.name)}</strong> enviará o template <strong>${escape(campaign.template_name)}</strong> pelo número <strong>${escape(phone(campaign.sender))}</strong>. Os envios serão reais e poderão gerar cobrança na sua conta Meta/FLW.`,
      label: 'Confirmar disparo',
      action: async () => {
        await api(`/campaigns/${campaign.id}/start`, { method: 'POST', body: { confirmed: true } });
        toast('Campanha iniciada. Acompanhe os envios nos detalhes.');
      },
    });
  },
  'pause-campaign': async (element) => {
    await api(`/campaigns/${element.dataset.id}/pause`, { method: 'POST' });
    toast('Campanha pausada. O envio atual poderá terminar.');
    await campaignDetails(element.dataset.id);
  },
  'cancel-campaign': (element) =>
    confirmDialog({
      title: 'Cancelar campanha?',
      text: 'Os destinatários pendentes não receberão a mensagem. Um envio já em andamento poderá terminar.',
      label: 'Cancelar campanha',
      danger: true,
      action: () => api(`/campaigns/${element.dataset.id}/cancel`, { method: 'POST' }),
    }),
  'sync-campaign': async (element) => {
    const result = await api(`/campaigns/${element.dataset.id}/sync`, { method: 'POST' });
    toast(`${result.synced} status consultados. Use novamente para atualizar os demais, se necessário.`);
    await campaignDetails(element.dataset.id);
  },
  'test-connection': async () => {
    const data = await api('/connection/test', { method: 'POST' });
    updateConnection(true, true);
    $('#connection-result').innerHTML =
      `<div class="alert">${icon('circle-check')}${escape(data.message)}</div>`;
    icons();
    toast('Conexão validada com sucesso.');
  },
  'open-conversation': (element) => openConversation(element.dataset.id),
  'reload-conversation': () => openConversation(state.selectedConversation.id, false),
  'back-conversations': () => $('#inbox').classList.remove('thread-open'),
  'conversation-prev': () => {
    state.conversationPage--;
    state.selectedConversation = null;
    return renderPage(true);
  },
  'conversation-next': () => {
    state.conversationPage++;
    state.selectedConversation = null;
    return renderPage(true);
  },
  'messages-older': () => {
    state.messagePage++;
    return openConversation(state.selectedConversation.id, false);
  },
  'messages-newer': () => {
    state.messagePage--;
    return openConversation(state.selectedConversation.id, false);
  },
};

document.addEventListener('click', async (event) => {
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  const action = actions[element.dataset.action];
  if (!action) return;
  event.preventDefault();
  element.disabled = true;
  try {
    await action(element);
  } catch (error) {
    toast(error.message, true);
  } finally {
    element.disabled = false;
  }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'contact-search') {
    state.search = event.target.value;
    $('#contacts-table').innerHTML = contactsTable();
    icons();
  }
  if (event.target.id === 'conversation-search') {
    $('#conversation-items').innerHTML = conversationItems(event.target.value);
    icons();
  }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'contact-list-filter') {
    state.contactList = event.target.value;
    $('#contacts-table').innerHTML = contactsTable();
    icons();
  }
});
function setMenuOpen(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#menu-toggle').setAttribute('aria-expanded', String(open));
  $('.app-shell').inert = open;
  $('#skip-content').inert = open;
  if (open) $('#sidebar .active')?.focus();
}
$('#menu-toggle').addEventListener('click', () => setMenuOpen(!$('#sidebar').classList.contains('open')));
function closeMenu() {
  setMenuOpen(false);
  $('#menu-toggle').focus();
}
$('#menu-close').addEventListener('click', closeMenu);
$('#sidebar-overlay').addEventListener('click', closeMenu);
window.matchMedia('(max-width: 760px)').addEventListener('change', () => setMenuOpen(false));
$('#sidebar').addEventListener('click', (event) => {
  if (event.target.closest('a') && $('#sidebar').classList.contains('open')) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#sidebar').classList.contains('open')) closeMenu();
});
$('#skip-content').addEventListener('click', (event) => {
  event.preventDefault();
  main.focus();
});
window.addEventListener('hashchange', () => {
  modal.close();
  renderPage();
});
setInterval(async () => {
  if (document.hidden || modal.open || refreshBusy) return;
  refreshBusy = true;
  try {
    if (state.page === 'conversations' && state.configured) {
      const data = await api(`/conversations?page=${state.conversationPage}`);
      if (state.page === 'conversations' && $('#conversation-items')) {
        state.conversations = data.items || [];
        $('#conversation-items').innerHTML = conversationItems($('#conversation-search')?.value || '');
        icons();
        await refreshMessages();
      }
    }
    const controlFocused = document.activeElement !== main && main.contains(document.activeElement);
    if (['dashboard', 'campaigns'].includes(state.page) && !controlFocused) {
      await renderPage(true);
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    refreshBusy = false;
  }
}, 15000);
api('/settings')
  .then((settings) => {
    state.configured = settings.configured;
    updateConnection(settings.configured);
  })
  .catch(() => {});
renderPage();
