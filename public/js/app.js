/* Vieira Link — interface sem build. Cada operação é validada pelo servidor. */
const $ = (selector, root = document) => root.querySelector(selector);
const main = $('#main');
const modal = $('#modal');
const csrf = $('meta[name="csrf-token"]').content;
const account = document.body.dataset;
const allowedPages = new Set([...document.querySelectorAll('[data-page]')].map(link => link.dataset.page));
const staffRoles = { agent: 'Atendente', sender: 'Enviador', manager: 'Gerente' };
const state = {
  configured: account.configured === 'true',
  users: [],
  page: '',
  lists: [],
  contacts: [],
  campaigns: [],
  templates: [],
  templateChannel: '',
  channels: [],
  conversations: [],
  selectedConversation: null,
  conversationPage: 1,
  conversationChannel: '',
  conversationDays: '7',
  conversationSearch: '',
  unreadOnly: false,
  inboxFiltersOpen: false,
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
  users: 'Usuários',
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
  if (account.role !== 'manager') return `<div class="alert">${icon('plug-zap')}Peça ao gerente para configurar a integração FLW.</div>`;
  return `<div class="alert">${icon('plug-zap')}<span>Conecte sua conta FLW para carregar canais, templates e conversas. Configure o token no <strong>.env</strong> e reinicie o servidor. <a href="#settings">Ver configuração</a></span></div>`;
}

async function renderPage(silent = false) {
  const page = window.location.hash.slice(1).split('?')[0];
  state.page = allowedPages.has(page) ? page : account.home;
  const current = ++navigation;
  $('#breadcrumb-title').textContent = titles[state.page];
  document.title = `${titles[state.page]} · Vieira Link`;
  document.querySelectorAll('[data-page]').forEach((link) => {
    const currentPage = link.dataset.page === state.page;
    link.classList.toggle('active', currentPage);
    if (currentPage) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (!silent) setMenuOpen(false);
  if (!silent) main.innerHTML = loading();
  try {
    const html = await pages[state.page](current);
    if (current !== navigation) return;
    main.innerHTML = html;
    icons();
    if (state.page === 'conversations' && state.selectedConversation) {
      await openConversation(state.selectedConversation.id, false);
    }
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
      `<div class="filter-bar contact-filters">
        <label for="contact-search">Buscar contato<span class="search-field">${icon('search')}<input type="search" id="contact-search" placeholder="Nome, telefone ou e-mail" value="${escape(state.search)}"></span></label>
        <label for="contact-list-filter">Lista de contatos<select id="contact-list-filter"><option value="">Todas as listas</option>${state.lists.map((l) => `<option value="${escape(l.id)}" ${state.contactList === l.id ? 'selected' : ''}>${escape(l.name)}</option>`).join('')}</select></label>
      </div><div class="panel" id="contacts-table">${contactsTable()}</div>`
    );
  },
  async templates(current) {
    if (!state.configured)
      return (
        pageHeading(
          'Templates de mensagem',
          'Seus templates aprovados, prontos para iniciar uma conversa.',
        ) +
        connectionBanner()
      );
    const channels = (await api('/channels')).filter((channel) => channel.active && /cloudapi|dialog360/i.test(channel.type));
    if (current !== navigation) return;
    const heading = pageHeading('Templates de mensagem', 'Escolha um modelo aprovado para iniciar uma campanha.');
    if (!channels.length) return heading + `<div class="panel">${empty('Nenhum canal oficial ativo', 'Confira os canais WhatsApp vinculados à conta FLW.', '', 'smartphone')}</div>`;
    const selected = [state.templateChannel, state.conversationChannel, account.inboxChannel]
      .find((id) => channels.some((channel) => channel.id === id))
      || (channels.length === 1 ? channels[0].id : '');
    const filter = `<form id="template-filter" class="filter-bar template-filters">
      <label for="template-channel">Canal WhatsApp<select id="template-channel" required>
        <option value="" disabled ${selected ? '' : 'selected'}>Selecione um canal</option>
        ${channels.map((c) => `<option value="${escape(c.id)}" ${selected === c.id ? 'selected' : ''}>${escape([c.identity?.displayName || c.name || 'WhatsApp', c.numberFormatted || c.number].filter(Boolean).join(' · '))}</option>`).join('')}
      </select></label>
      <button class="button primary" type="submit">${icon('list-filter')}Filtrar templates</button>
    </form>`;
    if (!selected) return heading + filter + `<div class="panel">${empty('Escolha um canal', 'Selecione o número e clique em Filtrar templates para consultar os modelos.', '', 'panels-top-left')}</div>`;
    let models;
    try {
      models = await api(`/templates?channelId=${encodeURIComponent(selected)}`);
    } catch (error) {
      return heading + filter + `<div class="alert error" role="alert">${escape(error.message)}</div>`;
    }
    if (current !== navigation) return;
    state.templateChannel = selected;
    state.templates = models.filter((t) => t.channelId === selected && t.active && !t.archived && String(t.status).toUpperCase() === 'APPROVED');
    return (
      heading + filter +
      (state.templates.length
        ? `<div class="list-grid">${state.templates.map((t) => `<article class="template-card"><span class="badge green">${icon('check-check')}Aprovado</span><h3>${escape(t.name)}</h3><div class="message-preview">${escape(t.text || 'Template com mídia ou conteúdo interativo.')}</div><div class="template-card-footer"><span>${number(t.params?.length)} variáveis · ${escape(t.fileType && t.fileType !== 'UNDEFINED' ? t.fileType.toLowerCase() : 'texto')}</span><button class="button ghost" data-action="use-template" data-id="${escape(t.id)}">Usar template</button></div></article>`).join('')}</div>`
        : `<div class="panel">${empty('Nenhum template aprovado neste canal', 'Os modelos ativos aparecem aqui após a aprovação na FLW.', '', 'panels-top-left')}</div>`)
    );
  },
  async conversations(current) {
    if (!state.configured)
      return (
        pageHeading('Caixa de entrada', 'Acompanhe suas conversas e continue de onde parou.') +
        connectionBanner()
      );
    const query = new URLSearchParams({
      page: state.conversationPage,
      days: state.conversationDays,
    });
    if (state.conversationChannel) query.set('channelId', state.conversationChannel);
    const data = await api(`/conversations?${query}`);
    if (current !== navigation) return;
    state.conversationChannel = data.channelId;
    state.conversations = data.items || [];
    const channels = data.channels || [];
    const channelLabel = (channel) => escape([channel.name, channel.number].filter(Boolean).join(' · '));
    const channelField = channels.length === 1
      ? `<div class="inbox-channel">${icon('smartphone')}<span>${channelLabel(channels[0])}</span></div>`
      : `<select id="conversation-channel" aria-label="Canal WhatsApp"><option value="">Escolha um canal WhatsApp</option>${channels.map((channel) => `<option value="${escape(channel.id)}" ${channel.id === data.channelId ? 'selected' : ''}>${channelLabel(channel)}</option>`).join('')}</select>`;
    const heading = `<div class="page-heading inbox-heading"><h1>Caixa de entrada</h1>
      ${button('Atualizar lista', 'conversation-refresh', 'refresh-cw', '')}</div>`;
    if (!channels.length) {
      return heading + `<div class="panel">${empty('Nenhum canal WhatsApp disponível', 'Confira os canais associados ao token nas configurações da FLW.', '', 'inbox')}</div>`;
    }
    return heading + `
      <div class="inbox" id="inbox">
        <section class="conversation-list" aria-label="Lista de conversas">
          <div class="conversation-list-head">
            <div class="inbox-list-title"><div><h2>Conversas</h2><small>${data.channelId ? channelLabel(channels.find(c => c.id === data.channelId)) : 'Selecione o canal de atendimento'}</small></div>
              <button class="icon-button inbox-filter-button" type="button" data-action="toggle-inbox-filters" aria-controls="inbox-filters" aria-label="Filtros de canal e período" aria-expanded="${!data.channelId || state.inboxFiltersOpen}">${icon('sliders-horizontal')}Filtros</button></div>
            <div id="inbox-filters" class="inbox-filter-fields" ${!data.channelId || state.inboxFiltersOpen ? '' : 'hidden'}>
              <div class="filter-field"><span>Canal WhatsApp</span>${channelField}</div>
              ${data.channelId ? `<label>Última interação<select id="conversation-days">${[
                ['1', 'Últimas 24 horas'], ['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'], ['90', 'Últimos 90 dias'],
              ].map(([days, label]) => `<option value="${days}" ${days === state.conversationDays ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}
            </div>
            ${data.channelId ? `<div class="search-field">${icon('search')}<input id="conversation-search" type="search" placeholder="Buscar nome ou telefone" aria-label="Buscar conversas por nome ou telefone nesta página" value="${escape(state.conversationSearch)}"></div>
              <div class="inbox-segments" role="group" aria-label="Conversas nesta página">
                <button type="button" data-action="filter-inbox-rows" data-mode="all" aria-pressed="${!state.unreadOnly}">Todas</button>
                <button type="button" data-action="filter-inbox-rows" data-mode="unread" aria-pressed="${state.unreadOnly}">Não lidas <b>${number(state.conversations.filter(c => c.unreadCount > 0).length)}</b></button>
              </div>` : ''}
          </div>
          <div class="conversation-items" id="conversation-items">
            ${data.channelId ? conversationItems() : empty('Escolha um canal', 'Selecione o número que você quer acompanhar.', '', 'smartphone', true)}
          </div>
          ${data.channelId ? `<div class="pagination"><button class="icon-button" data-action="conversation-prev" ${state.conversationPage <= 1 ? 'disabled' : ''} aria-label="Página anterior">${icon('chevron-left')}</button>Página ${state.conversationPage}<button class="icon-button" data-action="conversation-next" ${!data.hasMorePages ? 'disabled' : ''} aria-label="Próxima página">${icon('chevron-right')}</button></div>` : ''}
        </section>
        <section class="conversation-thread" id="conversation-thread">
          ${idleThread()}
        </section>
      </div>`;
  },
  async users() {
    state.users = await api('/users');
    return pageHeading('Usuários', 'Gerencie o acesso da equipe ao painel.', button('Criar usuário', 'new-user', 'user-plus')) +
      `<div class="panel table-wrap"><table><thead><tr><th>Usuário</th><th>Perfil</th><th>Acesso</th><th></th></tr></thead><tbody>${state.users.map(user => `<tr>
        <td><strong>${escape(user.username)}</strong></td><td>${staffRoles[user.role]}</td>
        <td><span class="badge ${user.active ? 'green' : ''}">${user.active ? 'Ativo' : 'Desativado'}</span></td>
        <td>${user.role === 'manager' ? 'Conta do servidor' : `<button class="button ghost" data-action="edit-user" data-id="${escape(user.id)}" aria-label="Editar ${escape(user.username)}">${icon('pencil')}Editar</button>`}</td>
      </tr>`).join('')}</tbody></table></div>`;
  },
  async settings() {
    const data = await api('/settings');
    updateConnection(data.configured);
    return (
      pageHeading(
        'Configurações',
        'Gerencie a integração e confira as configurações do workspace.',
      ) +
      `<div class="settings-grid"><section class="panel"><div class="panel-head"><div><h2>Integração FLW Chat</h2><p>Seus canais e mensagens em um só lugar.</p></div><span class="stat-icon">${icon('plug-zap')}</span></div><div class="settings-body"><div class="settings-row"><div><strong>Token da API</strong><small>${data.configured ? 'Token configurado no servidor. Teste para validar.' : 'Adicione seu token permanente no arquivo .env.'}</small></div><span class="badge ${data.configured ? 'green' : 'orange'}">${data.configured ? 'Configurado' : 'Não configurado'}</span></div><div class="settings-row"><div><strong>Endereço da API</strong><small>Servidor usado nas requisições</small></div><code>${escape(data.apiBase)}</code></div><div class="settings-row"><div><strong>Intervalo entre envios</strong><small>Fila persistente com processamento individual</small></div><span class="badge blue">${data.sendInterval / 1000}s / contato</span></div><div class="settings-row"><div><strong>Callbacks de entrega</strong><small>${data.webhookConfigured ? `Último evento: ${data.lastWebhook ? date(data.lastWebhook) + ' às ' + time(data.lastWebhook) : 'nenhum recebido'}` : 'Opcional. Configure PUBLIC_URL e WEBHOOK_SECRET.'}</small></div><span class="badge ${data.webhookConfigured ? 'green' : ''}">${data.webhookConfigured ? 'Configurado' : 'Não configurado'}</span></div><div class="settings-row"><div><strong>Administrador</strong><small>Usuário definido em ADMIN_USERNAME</small></div><span class="badge">${escape(data.username)}</span></div><div class="settings-row"><div><strong>Validar integração</strong><small>Consulta seus canais sem enviar mensagens.</small></div>${button('Testar conexão', 'test-connection', 'activity', 'primary', data.configured ? '' : 'disabled')}</div><div id="connection-result"></div></div></section>
      <aside class="settings-guide">${icon('book-open')}<h3>Conecte em poucos passos</h3><p>O token fica protegido no servidor. Ele não é enviado ao navegador.</p><ol><li>Na FLW, abra <strong>Ajustes → Integrações → Integração via API</strong>.</li><li>Copie seu token permanente.</li><li>Preencha <strong>FLW_API_TOKEN</strong> no arquivo <strong>.env</strong> deste projeto.</li><li>Reinicie o servidor e teste a conexão.</li></ol><a class="button" href="https://flwchat.readme.io/reference/autentica%C3%A7%C3%A3o" target="_blank" rel="noreferrer">${icon('external-link')}Consultar documentação</a><p>As respostas são consultadas diretamente na API. O webhook é opcional para atualizar as entregas.</p></aside></div>`
    );
  },
};

function updateConnection(configured, verified = false) {
  const element = $('#connection-badge');
  state.configured = configured;
  state.connectionVerified = configured && (verified || state.connectionVerified);
  element.classList.toggle('connected', configured);
  element.innerHTML = `<span class="status-dot"></span>${state.connectionVerified ? 'Conexão verificada' : configured ? 'Token configurado' : 'Conexão pendente'}`;
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
function staffModal(user) {
  const editing = Boolean(user);
  const staffRole = user?.role || 'agent';
  showModal(editing ? 'Editar usuário' : 'Criar usuário',
    editing ? 'Salvar alterações encerra as sessões anteriores deste usuário.' : 'Defina o login da pessoa e as áreas que ela poderá acessar.',
    `<div class="form-stack">
      <label>Usuário<input name="username" autocomplete="off" required minlength="3" maxlength="80" pattern="[a-zA-Z0-9._\\-]{3,80}" value="${escape(user?.username || '')}" ${editing ? 'readonly' : 'autofocus'}></label>
      <label>${editing ? 'Nova senha (opcional)' : 'Senha'}<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="256" ${editing ? '' : 'required'} placeholder="Pelo menos 10 caracteres"></label>
      <label>Perfil<select name="role"><option value="agent" ${staffRole === 'agent' ? 'selected' : ''}>Atendente</option><option value="sender" ${staffRole === 'sender' ? 'selected' : ''}>Enviador</option></select></label>
      <p class="field-hint">Atendentes leem e respondem conversas. Enviadores também organizam contatos e listas e usam templates aprovados para disparar campanhas.</p>
      ${editing ? `<label class="check-label"><input type="checkbox" name="active" ${user.active ? 'checked' : ''}>Acesso ativo</label>` : ''}
    </div>`, formFooter(editing ? 'Salvar alterações' : 'Criar usuário'), false, 'staff-form');
  bindForm('staff-form', async (form) => {
    const body = { role: form.get('role') };
    if (editing) body.active = form.has('active');
    else body.username = form.get('username');
    if (form.get('password')) body.password = form.get('password');
    await api(editing ? `/users/${user.id}` : '/users', { method: editing ? 'PUT' : 'POST', body });
    modal.close();
    toast(editing ? 'Acesso atualizado.' : 'Usuário criado.');
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

const replyDrafts = new Map();
const pendingReplies = new Set();
const draftKey = (id) => state.conversationChannel + '/' + id;

function visibleConversations() {
  const query = state.conversationSearch.trim().toLocaleLowerCase('pt-BR');
  const digits = query.replace(/\D/g, '');
  const phoneQuery = digits && /^[+\d\s().-]+$/.test(query);
  return state.conversations.filter((c) => (!state.unreadOnly || c.unreadCount > 0) && (
    phoneQuery
      ? String(c.number || c.contactDetails?.phonenumber || '').replace(/\D/g, '').includes(digits)
      : (c.contactDetails?.name || c.title || '').toLocaleLowerCase('pt-BR').includes(query)
  ));
}

function idleThread() {
  const rows = visibleConversations();
  const next = rows.find(c => c.unreadCount > 0) || rows[0];
  const action = next ? `<button class="button primary" data-action="open-conversation" data-id="${escape(next.id)}">${icon('message-square')}${next.unreadCount > 0 ? 'Abrir primeira não lida' : 'Abrir conversa mais recente'}</button>` : '';
  return `<div class="thread-empty">${empty('Selecione uma conversa', 'Escolha um contato na lista para consultar o histórico e responder.', action, 'messages-square')}</div>`;
}

function conversationItems() {
  const rows = visibleConversations();
  const query = state.conversationSearch.trim();
  if (!rows.length)
    return empty(
      query ? 'Nenhum resultado nesta página' : state.unreadOnly ? 'Nenhuma não lida nesta página' : 'Nenhuma conversa no período',
      query ? 'Tente outro nome ou número.' : state.unreadOnly ? 'Use Todas para ver as conversas lidas.' : 'Abra os filtros para selecionar um período maior.',
      '',
      'messages-square',
      true,
    );
  return rows
    .map(
      (c) => {
        const selected = state.selectedConversation?.id === c.id;
        const updated = c.lastInteractionDate || c.createdAt;
        const today = updated && new Date(updated).toDateString() === new Date().toDateString();
        const draft = replyDrafts.get(draftKey(c.id));
        return `<button type="button" class="conversation-item ${selected ? 'active' : ''}" aria-pressed="${selected}" data-action="open-conversation" data-id="${escape(c.id)}"><span class="avatar ${c.unreadCount ? 'mint' : ''}">${escape(initials(c.contactDetails?.name || c.title))}</span><span class="conversation-item-content"><strong>${escape(c.contactDetails?.name || c.title || c.number || 'Contato')}</strong><span class="conversation-snippet">${draft ? '<b>Rascunho</b> ' + escape(draft) : escape(c.lastMessageText || 'Ver conversa')}</span></span><span class="conversation-meta"><small>${today ? time(updated) : date(updated)}</small>${c.unreadCount ? `<span class="badge blue" aria-label="${number(c.unreadCount)} não lidas">${number(c.unreadCount)}</span>` : ''}</span></button>`;
      },
    )
    .join('');
}
let conversationRequest = 0;
let syncVisibleThread;
let threadSyncBusy = false;
setInterval(async () => {
  if (!syncVisibleThread || threadSyncBusy || document.hidden || modal.open) return;
  threadSyncBusy = true;
  try {
    await syncVisibleThread();
  } finally {
    threadSyncBusy = false;
  }
}, 5000);
function conversationPath(id, route, page) {
  const query = new URLSearchParams({ channelId: state.conversationChannel });
  if (page) query.set('page', page);
  return `/conversations/${encodeURIComponent(id)}/${route}?${query}`;
}

async function openConversation(id, reset = true) {
  const conversation = state.conversations.find((c) => c.id === id)
    || (state.selectedConversation?.id === id ? state.selectedConversation : null);
  if (!conversation) return;
  state.selectedConversation = conversation;
  const request = ++conversationRequest;
  syncVisibleThread = null;
  const thread = $('#conversation-thread');
  if (!thread) return;
  $('#inbox').classList.add('thread-open');
  document
    .querySelectorAll('.conversation-item')
    .forEach((row) => {
      row.classList.toggle('active', row.dataset.id === id);
      row.setAttribute('aria-pressed', String(row.dataset.id === id));
    });
  const name = conversation.contactDetails?.name || conversation.title || 'Contato';
  const threadHeader = (status = '') => `<header class="thread-head">
    <button type="button" class="icon-button thread-back hidden" data-action="back-conversations" aria-label="Voltar às conversas">${icon('chevron-left')}</button>
    <span class="avatar">${escape(initials(name))}</span>
    <div class="thread-contact"><strong>${escape(name)}</strong><small>${escape(phone(conversation.number || conversation.contactDetails?.phonenumber))}</small></div>
    ${status ? `<span class="badge ${status === 'ACTIVE' ? 'green' : 'orange'}">${status === 'ACTIVE' ? 'Janela aberta' : 'Janela fechada'}</span>
      <button type="button" class="icon-button" data-action="reload-conversation" aria-label="Atualizar mensagens" title="Atualizar mensagens">${icon('refresh-cw')}</button>` : ''}
  </header>`;
  thread.innerHTML = threadHeader() + loading();
  icons();
  try {
    const data = await api(conversationPath(id, 'messages', 1));
    if (request !== conversationRequest || !thread.isConnected) return;
    const active = data.windowStatus === 'ACTIVE';
    const key = draftKey(id);
    const draft = replyDrafts.get(key) || '';
    const sending = pendingReplies.has(key);
    thread.innerHTML = threadHeader(data.windowStatus || 'CLOSED') + `
      <div class="messages" id="messages" role="region" aria-label="Histórico de mensagens" tabindex="0">
        <button type="button" class="history-more" ${data.hasMorePages ? '' : 'hidden'}>Carregar mensagens anteriores</button>
        <div class="chat-history">${messageItems(data)}</div>
      </div>
      ${active ? `<form class="reply-form" id="reply-form">
        <label for="reply-text">Responder a ${escape(name)}</label>
        <textarea id="reply-text" name="text" placeholder="Escreva sua mensagem…" aria-label="Sua resposta" rows="2" required maxlength="4096" ${sending ? 'readonly' : ''}>${escape(draft)}</textarea>
        <div class="reply-actions"><small class="reply-shortcut">Ctrl ou ⌘ + Enter para enviar</small><button class="button primary" type="submit" aria-label="Enviar resposta" ${sending || !draft.trim() ? 'disabled' : ''}>${icon('send')}<span>${sending ? 'Enviando…' : 'Enviar'}</span></button></div>
      </form>` : `<div class="closed-thread">${icon('lock-keyhole')}<div><strong>Janela de resposta encerrada</strong><p>Para retomar o atendimento, use um template aprovado em uma campanha.</p></div></div>`}`;
    icons();
    $('#messages').scrollTop = $('#messages').scrollHeight;
    const history = $('.chat-history', thread);
    const scrollArea = $('#messages', thread);
    const older = $('.history-more', thread);
    let loaded = data.items || [];
    let historyPage = 1;
    let revision = data.revision;
    let seenReply = data.replyVersion;
    let retryAt = 0;
    syncVisibleThread = async () => {
      if (!history.isConnected || historyPage !== 1 || older.disabled || pendingReplies.has(key) || Date.now() < retryAt) return;
      try {
        const fresh = await api(conversationPath(id, 'messages', 1) + '&since=' + encodeURIComponent(revision));
        if (!history.isConnected || older.disabled || historyPage !== 1 || request !== conversationRequest || fresh.unchanged) return;
        revision = fresh.revision;
        seenReply = fresh.replyVersion;
        if (fresh.windowStatus !== data.windowStatus) {
          await openConversation(id, false);
          return;
        }
        older.hidden = !fresh.hasMorePages;
        if (JSON.stringify(loaded) === JSON.stringify(fresh.items)) return;
        const follow = scrollArea.scrollHeight - scrollArea.clientHeight - scrollArea.scrollTop < 64;
        loaded = fresh.items || [];
        history.innerHTML = messageItems({ items: loaded });
        if (follow) scrollArea.scrollTop = scrollArea.scrollHeight;
      } catch (error) {
        retryAt = Date.now() + 30000;
        if (history.isConnected) toast(error.message, true);
      }
    };
    older?.addEventListener('click', async () => {
      if (older.disabled) return;
      older.disabled = true;
      older.textContent = 'Carregando histórico…';
      try {
        const page = await api(conversationPath(id, 'messages', historyPage + 1));
        if (request !== conversationRequest || !history.isConnected) return;
        historyPage++;
        const ids = new Set(loaded.map(message => message.id).filter(Boolean));
        loaded = [...(page.items || []).filter(message => !message.id || !ids.has(message.id)), ...loaded];
        const before = scrollArea.scrollHeight;
        const top = scrollArea.scrollTop;
        history.innerHTML = messageItems({ items: loaded });
        if (!page.hasMorePages) {
          older.hidden = true;
          scrollArea.focus({ preventScroll: true });
        }
        scrollArea.scrollTop = top + scrollArea.scrollHeight - before;
      } catch (error) {
        if (history.isConnected) toast(error.message, true);
      } finally {
        older.disabled = false;
        older.textContent = 'Carregar mensagens anteriores';
      }
    });
    if (reset && window.matchMedia('(max-width: 760px)').matches) {
      $('.thread-back', thread)?.focus({ preventScroll: true });
    }
    const reply = $('#reply-form');
    reply?.addEventListener('input', () => {
      const value = $('textarea', reply).value;
      if (value) replyDrafts.set(key, value);
      else replyDrafts.delete(key);
      $('button', reply).disabled = !value.trim() || pendingReplies.has(key);
      const snippet = $('.conversation-item.active .conversation-snippet');
      if (snippet) snippet.textContent = value ? 'Rascunho · ' + value : conversation.lastMessageText || 'Ver conversa';
    });
    reply?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (!$('button', reply).disabled) reply.requestSubmit();
      }
    });
    $('#reply-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = $('button', form);
      const field = $('textarea', form);
      const text = field.value.trim();
      if (!text || pendingReplies.has(key)) return;
      pendingReplies.add(key);
      submit.disabled = true;
      field.readOnly = true;
      $('span', submit).textContent = 'Enviando…';
      try {
        const result = await api(conversationPath(id, 'reply'), { method: 'POST', body: { text, replyVersion: seenReply } });
        replyDrafts.delete(key);
        toast(
          `Resposta recebida pela FLW. Status: ${statusMap[result.status?.toLowerCase()]?.[0] || result.status || 'na fila'}.`,
        );
      } catch (error) {
        toast(error.message, true);
        return;
      } finally {
        pendingReplies.delete(key);
        const currentForm = $('#reply-form');
        if (currentForm && draftKey(state.selectedConversation?.id) === key) {
          const currentField = $('textarea', currentForm);
          currentField.readOnly = false;
          $('button', currentForm).disabled = !currentField.value.trim();
          $('button span', currentForm).textContent = 'Enviar';
        }
      }
      if ($('#conversation-items')) $('#conversation-items').innerHTML = conversationItems();
      if ($('#conversation-thread') && draftKey(state.selectedConversation?.id) === key) {
        await openConversation(id, false);
      }
    });
  } catch (error) {
    if (request === conversationRequest && thread.isConnected)
      thread.innerHTML = threadHeader() + empty(
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
  let previousDay;
  return messages.length
    ? messages
        .map((m, index) => {
          const day = m.createdAt ? new Date(m.createdAt).toLocaleDateString('pt-BR', { dateStyle: 'long' }) : '';
          const separator = day && day !== previousDay ? `<span class="message-day">${escape(day)}</span>` : '';
          previousDay = day;
          const outgoing = m.direction === 'FROM_HUB';
          const status = outgoing && m.status ? ` · ${escape(statusMap[m.status.toLowerCase()]?.[0] || m.status)}` : '';
          const startsGroup = separator || index === 0 || messages[index - 1].direction !== m.direction;
          const author = outgoing ? 'Equipe' : (state.selectedConversation?.contactDetails?.name || state.selectedConversation?.title || 'Contato');
          return `${separator}${startsGroup ? `<span class="message-author ${outgoing ? 'from-team' : ''}">${escape(author)}</span>` : ''}<div class="message ${outgoing ? 'outgoing' : ''}">${escape(m.text || `[${m.type || 'Mídia'} — consulte o arquivo na FLW]`)}<span class="message-time">${time(m.createdAt)}${status}</span></div>`;
        })
        .join('')
    : empty(
        'Ainda sem mensagens',
        'As mensagens desta conversa aparecerão aqui.',
        '',
        'message-circle',
        true,
      );
}

const actions = {
  'new-user': () => staffModal(),
  'edit-user': element => staffModal(state.users.find(user => user.id === element.dataset.id)),
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
  'toggle-inbox-filters': (element) => {
    const filters = $('#inbox-filters');
    filters.hidden = !filters.hidden;
    state.inboxFiltersOpen = !filters.hidden;
    element.setAttribute('aria-expanded', String(!filters.hidden));
  },
  'filter-inbox-rows': (element) => {
    state.unreadOnly = element.dataset.mode === 'unread';
    document.querySelectorAll('.inbox-segments button').forEach(button => {
      button.setAttribute('aria-pressed', String(button === element));
    });
    $('#conversation-items').innerHTML = conversationItems();
    if (!state.selectedConversation) $('#conversation-thread').innerHTML = idleThread();
    icons();
  },
  'back-conversations': () => {
    syncVisibleThread = null;
    conversationRequest++;
    const previous = state.selectedConversation?.id;
    state.selectedConversation = null;
    $('#inbox').classList.remove('thread-open');
    $('#conversation-items').innerHTML = conversationItems();
    $('#conversation-thread').innerHTML = idleThread();
    icons();
    const row = [...document.querySelectorAll('.conversation-item')].find(item => item.dataset.id === previous);
    (row || $('#conversation-search'))?.focus();
  },
  'conversation-refresh': () => renderPage(true),
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
document.addEventListener('submit', (event) => {
  if (event.target.id !== 'template-filter') return;
  event.preventDefault();
  state.templateChannel = $('#template-channel').value;
  renderPage();
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'contact-search') {
    state.search = event.target.value;
    $('#contacts-table').innerHTML = contactsTable();
    icons();
  }
  if (event.target.id === 'conversation-search') {
    state.conversationSearch = event.target.value;
    $('#conversation-items').innerHTML = conversationItems();
    if (!state.selectedConversation) $('#conversation-thread').innerHTML = idleThread();
    icons();
  }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'contact-list-filter') {
    state.contactList = event.target.value;
    $('#contacts-table').innerHTML = contactsTable();
    icons();
  }
  if (['conversation-channel', 'conversation-days'].includes(event.target.id)) {
    if (event.target.id === 'conversation-channel') state.conversationChannel = event.target.value;
    else state.conversationDays = event.target.value;
    state.conversationPage = 1;
    state.conversationSearch = '';
    state.inboxFiltersOpen = false;
    state.selectedConversation = null;
    renderPage();
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
  syncVisibleThread = null;
  modal.close();
  state.selectedConversation = null;
  renderPage();
});
setInterval(async () => {
  if (document.hidden || modal.open || refreshBusy || !['dashboard', 'campaigns'].includes(state.page)) return;
  refreshBusy = true;
  try {
    const controlFocused = document.activeElement !== main && main.contains(document.activeElement);
    if (!controlFocused) await renderPage(true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    refreshBusy = false;
  }
}, 15000);
updateConnection(state.configured);
renderPage();
