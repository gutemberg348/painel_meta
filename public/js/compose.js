/* Composição guiada. Usa api(), showModal() e os componentes básicos de app.js. */
function friendlyVariable(key) {
  return key
    .replace(/[\[\]{}]/g, '')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function templateText(text, parameters, sample = {}) {
  const name = sample?.name || 'Nome do contato';
  const number = sample?.phone || '5591999999999';
  const replacements = [];
  for (const [key, value] of Object.entries(parameters)) {
    const resolved = value.split('{{nome}}').join(name).split('{{telefone}}').join(number);
    const tokens = key.startsWith('[') || key.startsWith('{{') ? [key] : [`{{${key}}}`, `[${key}]`];
    for (const token of tokens) replacements.push([token, resolved]);
  }
  if (!replacements.length) return text;
  // Uma substituição única evita substituir acidentalmente o conteúdo de outra variável.
  const values = new Map(replacements);
  const pattern = [...values.keys()]
    .sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return text.replace(new RegExp(pattern, 'g'), (token) => values.get(token));
}

function audienceMarkup(allowList = true) {
  return `<div class="audience-picker" id="audience-picker">
    <div class="source-options" role="group" aria-label="Como adicionar os contatos">
      <button type="button" class="source-option active" data-source="paste" aria-pressed="true">${icon('clipboard-paste')}<strong>Colar números</strong><span>Digite ou cole aqui</span></button>
      <button type="button" class="source-option" data-source="file" aria-pressed="false">${icon('file-up')}<strong>Enviar arquivo</strong><span>CSV ou TXT</span></button>
      ${allowList ? `<button type="button" class="source-option" data-source="list" aria-pressed="false">${icon('folder-open')}<strong>Usar uma lista</strong><span>Contatos já salvos</span></button>` : ''}
    </div>
    <div data-source-panel="paste"><label for="audience-text">Números ou contatos</label><textarea id="audience-text" class="numbers-input" placeholder="5591999999999&#10;5591888888888&#10;&#10;Ou nome e número:&#10;Provedor Alfa;5591777777777" spellcheck="false"></textarea><p class="field-hint">Para salvar a empresa como nome do contato, cole uma linha por empresa no formato <strong>Empresa;telefone</strong>. Também aceitamos apenas números.</p></div>
    <div data-source-panel="file" hidden><label class="upload-area" id="audience-drop" for="audience-file">${icon('cloud-upload')}<strong>Arraste seu arquivo aqui</strong><span>ou clique para escolher no computador</span><small>CSV ou TXT · até 900 KB · 5.000 contatos</small><input id="audience-file" type="file" accept=".csv,.txt,text/csv,text/plain"></label><p id="audience-file-name" class="field-hint" role="status"></p><div class="file-examples"><span>CSV: <code>nome,telefone,email</code> ou apenas <code>telefone</code></span><span>TXT sem cabeçalho · uma linha por empresa, por exemplo <code>Provedor Alfa;5591999990001</code>. Também aceitamos um telefone por linha.</span><div>${button('Modelo CSV', 'download-csv', 'download', 'ghost')}${button('Modelo TXT', 'download-txt', 'download', 'ghost')}</div></div></div>
    ${allowList ? `<div data-source-panel="list" hidden><label>Lista de contatos<select id="audience-list"><option value="">Selecione uma lista</option>${state.lists.map((list) => `<option value="${list.id}">${escape(list.name)} · ${number(list.opted_in_count)} autorizados</option>`).join('')}</select></label>${!state.lists.length ? '<p class="field-hint">Ainda não há listas. Use “Colar números” ou “Enviar arquivo”; a lista será criada ao salvar a campanha.</p>' : ''}</div>` : ''}
    <div id="audience-new-options"><label class="country-field">Formato dos números<select id="audience-country"><option value="55">Brasil (+55) · adicionar DDI aos números com 10 ou 11 dígitos</option><option value="">Internacional · todos os números já incluem DDI</option></select></label><p class="field-hint">Números começando com + mantêm o DDI informado. Confira a prévia abaixo.</p></div>
    <div id="audience-result" class="audience-result" aria-live="polite"><span>${icon('users-round')} Seus contatos aparecerão aqui para conferência.</span></div>
    <label class="check-label consent-box" id="audience-consent-label"><input type="checkbox" id="audience-consent">Confirmo que estes contatos autorizaram o recebimento de mensagens pelo WhatsApp.</label>
  </div>`;
}

class AudiencePicker {
  constructor(onChange = () => {}) {
    this.root = $('#audience-picker');
    this.mode = 'paste';
    this.file = null;
    this.version = 0;
    this.onChange = onChange;
    this.summary = null;
    this.reading = false;
    this.root
      .querySelectorAll('[data-source]')
      .forEach((button) => button.addEventListener('click', () => this.select(button.dataset.source)));
    $('#audience-text').addEventListener('input', () => this.changed());
    $('#audience-country').addEventListener('change', () => this.changed());
    $('#audience-list')?.addEventListener('change', () => this.changed());
    $('#audience-file').addEventListener('change', (event) => this.readFile(event.target.files[0]));
    const drop = $('#audience-drop');
    for (const type of ['dragenter', 'dragover'])
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add('dragging');
      });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('dragging');
      this.readFile(event.dataTransfer.files[0]);
    });
  }
  select(mode) {
    this.mode = mode;
    this.root.querySelectorAll('[data-source]').forEach((button) => {
      button.classList.toggle('active', button.dataset.source === mode);
      button.setAttribute('aria-pressed', String(button.dataset.source === mode));
    });
    this.root.querySelectorAll('[data-source-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.sourcePanel !== mode;
    });
    $('#audience-new-options').hidden = mode === 'list';
    $('#audience-consent-label').hidden = mode === 'list';
    this.changed();
  }
  async readFile(file) {
    const serial = (this.fileSerial = (this.fileSerial || 0) + 1);
    this.file = null;
    this.reading = false;
    if (!file) {
      this.changed();
      return;
    }
    if (!/\.(csv|txt)$/i.test(file.name) || file.size > 900000) {
      $('#audience-file').value = '';
      $('#audience-file-name').textContent = 'Escolha um arquivo CSV ou TXT com até 900 KB.';
      this.changed();
      return;
    }
    this.reading = true;
    this.changed();
    $('#audience-file-name').textContent = `Lendo ${file.name}…`;
    try {
      const text = await file.text();
      if (serial !== this.fileSerial || !this.root.isConnected) return;
      this.file = { text, format: /\.csv$/i.test(file.name) ? 'csv' : 'txt' };
      $('#audience-file-name').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
    } catch {
      if (serial === this.fileSerial && this.root.isConnected)
        $('#audience-file-name').textContent = 'Não foi possível ler o arquivo. Selecione novamente.';
    } finally {
      if (serial === this.fileSerial && this.root.isConnected) {
        this.reading = false;
        this.changed();
      }
    }
  }
  input() {
    if (this.mode === 'list') return { listId: $('#audience-list').value };
    const source = this.mode === 'file' ? this.file : { text: $('#audience-text').value, format: 'paste' };
    return source ? { audience: { ...source, countryCode: $('#audience-country').value } } : null;
  }
  changed() {
    clearTimeout(this.timer);
    this.version++;
    this.summary = null;
    this.onChange(null);
    const input = this.input();
    if (this.mode === 'list') {
      const list = state.lists.find((list) => list.id === input.listId);
      this.summary = list
        ? { eligible: list.opted_in_count, unique: list.contact_count, contacts: [] }
        : null;
      $('#audience-result').innerHTML = list
        ? `<strong>${number(list.opted_in_count)} contatos autorizados</strong><p>Lista ${escape(list.name)}. Contatos sem autorização ficam fora do envio.</p>`
        : 'Selecione uma lista para continuar.';
      this.onChange(this.summary);
      return;
    }
    if (this.reading || !input?.audience.text.trim()) {
      $('#audience-result').textContent = this.reading
        ? 'Lendo arquivo…'
        : 'Adicione os números para conferir os destinatários.';
      return;
    }
    $('#audience-result').textContent = 'Conferindo seus contatos…';
    const version = this.version;
    this.timer = setTimeout(() => this.preview(input, version), 500);
  }
  async preview(input, version) {
    if (!this.root.isConnected || version !== this.version) return null;
    try {
      const result = await api('/contacts/preview', { method: 'POST', body: input.audience });
      if (!this.root.isConnected || version !== this.version) return null;
      this.summary = result;
      this.onChange(result);
      $('#audience-result').innerHTML =
        `<div class="audience-totals"><span><strong>${number(result.eligible)}</strong> aptos para envio</span><span><strong>${number(result.duplicates)}</strong> repetidos removidos</span><span class="${result.errors.length ? 'invalid-count' : ''}"><strong>${number(result.errors.length)}</strong> linhas inválidas</span></div>
        ${result.blocked ? `<p class="audience-warning">${number(result.blocked)} contato(s) já estavam sem autorização e continuarão bloqueados.</p>` : ''}
        ${
          result.errors.length
            ? `<ul class="audience-errors">${result.errors
                .slice(0, 5)
                .map((error) => `<li>Linha ${error.line}: ${escape(error.message)}</li>`)
                .join('')}</ul><p>Corrija o conteúdo antes de continuar. Nenhum contato foi salvo.</p>`
            : ''
        }
        ${
          result.contacts.length
            ? `<div class="audience-samples">${result.contacts
                .slice(0, 4)
                .map(
                  (contact) =>
                    `<span><b>${escape(contact.name)}</b><span>${escape(phone(contact.phone))}${contact.blocked ? ' · Sem autorização' : ''}</span></span>`,
                )
                .join(
                  '',
                )}</div><p class="field-hint">Prévia de até 4 contatos · ${number(result.unique)} números únicos no total.</p>`
            : ''
        }`;
      return result;
    } catch (error) {
      if (this.root.isConnected && version === this.version)
        $('#audience-result').textContent = error.message;
      return null;
    }
  }
  async payload() {
    if (this.reading) throw new Error('Aguarde a leitura do arquivo.');
    const input = this.input();
    if (this.mode === 'list') {
      if (!input.listId || !this.summary?.eligible)
        throw new Error('Escolha uma lista com contatos autorizados.');
      return input;
    }
    if (!input?.audience.text.trim()) throw new Error('Adicione seus números ou selecione um arquivo.');
    if (!$('#audience-consent').checked) throw new Error('Confirme a autorização dos contatos.');
    const version = this.version;
    clearTimeout(this.timer);
    const result = await this.preview(input, version);
    if (version !== this.version) throw new Error('Os contatos mudaram. Confira novamente antes de salvar.');
    if (!result || result.errors.length)
      throw new Error('Corrija as linhas indicadas na prévia de contatos.');
    if (!result.eligible) throw new Error('Não há contatos autorizados disponíveis.');
    return { ...input, optedIn: true };
  }
}

async function openEasyImport() {
  state.lists = await api('/lists');
  showModal(
    'Adicione seus contatos',
    'Cole os números ou envie um arquivo. A gente organiza a lista para você.',
    `<div class="form-stack"><div class="form-grid"><label>Salvar em<select id="import-destination"><option value="">Criar uma nova lista</option>${state.lists.map((list) => `<option value="${list.id}">${escape(list.name)}</option>`).join('')}</select></label><label id="import-list-name-label">Nome da nova lista (opcional)<input id="import-list-name" maxlength="120" placeholder="Nome automático se ficar em branco"></label></div>${audienceMarkup(false)}</div>`,
    formFooter('Salvar contatos'),
    true,
    'easy-import-form',
  );
  const picker = new AudiencePicker();
  $('#import-destination').addEventListener('change', (event) => {
    $('#import-list-name-label').hidden = Boolean(event.target.value);
    $('#import-list-name').disabled = Boolean(event.target.value);
  });
  bindForm('easy-import-form', async () => {
    const listId = $('#import-destination').value;
    const listName = $('#import-list-name').value.trim();
    const payload = await picker.payload();
    const result = await api('/contacts/import', {
      method: 'POST',
      body: { ...payload, ...(listId ? { listId } : { listName }) },
    });
    modal.close();
    toast(`${result.linked} contato(s) adicionado(s) à lista “${result.listName}”. Novos cadastros: ${result.created}.`);
    await renderPage(true);
  });
}

async function openEasyCampaign(preselectedTemplate) {
  if (!state.configured) {
    showModal(
      'Conecte sua conta para começar',
      'Configure o token da sua conta FLW.',
      connectionBanner(),
      account.role === 'manager' ? '<button type="button" class="button primary" data-action="go-settings">Ver configurações</button>' : cancelButton,
    );
    return;
  }
  showModal('Preparando seu envio', 'Carregando seus canais e listas…', loading());
  try {
    const [channels, lists] = await Promise.all([api('/channels'), api('/lists')]);
    if (!modal.open) return;
    state.channels = channels;
    state.lists = lists;
    const official = channels.filter((channel) => channel.active && /cloudapi|dialog360/i.test(channel.type));
    if (!official.length)
      throw new Error('Nenhum canal oficial WhatsApp ativo disponível. Confira sua conta na FLW.');
    showModal(
      'Prepare seu próximo envio',
      'Escolha a mensagem, adicione os contatos e confira tudo antes de enviar.',
      `<div class="compose-layout"><div class="compose-sections">
        <section class="compose-section"><div class="section-title"><span>${icon('message-square-text')}</span><div><h3>Qual mensagem você quer enviar?</h3><p>Escolha um modelo aprovado e personalize os campos.</p></div></div>
          <div class="form-stack"><label>Nome deste envio<input name="name" required maxlength="120" placeholder="Ex.: Apresentação para provedores" value="Envio ${new Date().toLocaleDateString('pt-BR')}"></label><label>Enviar pelo número<select name="channelId" id="easy-channel">${official.map((channel) => `<option value="${escape(channel.id)}">${escape(channel.identity?.displayName || 'WhatsApp')} · ${escape(channel.numberFormatted || phone(channel.number))}</option>`).join('')}</select></label><label>Modelo da mensagem<select name="templateId" id="easy-template" required><option value="">Carregando…</option></select></label><p id="easy-template-info" class="field-hint" role="status"></p><div id="easy-fields" class="form-stack"></div><div id="easy-media"></div></div>
        </section>
        <section class="compose-section"><div class="section-title"><span>${icon('users-round')}</span><div><h3>Quem vai receber?</h3><p>Use um arquivo, cole os números ou escolha uma lista.</p></div></div>${audienceMarkup()}</section>
      </div><aside class="compose-preview"><div class="preview-topline">${icon('eye')} PRÉVIA DO ENVIO <span class="badge green">WhatsApp</span></div>
        <div class="phone-preview"><div class="phone-header"><span class="avatar mint">${icon('message-circle')}</span><div><strong id="easy-sender">Sua empresa</strong><small>Conta comercial</small></div></div><div class="phone-body"><span class="phone-date">Prévia da mensagem</span><div class="whatsapp-bubble"><div id="easy-preview">Escolha um modelo para visualizar sua mensagem aqui.</div><span class="bubble-check">Agora ${icon('check-check')}</span></div><p id="easy-media-preview" class="field-hint"></p></div></div>
        <div class="send-summary"><div><span>Destinatários autorizados</span><strong id="easy-count">—</strong></div><div><span>Campos da mensagem</span><strong id="easy-filled">—</strong></div></div><p class="preview-note" id="easy-sample-note">Prévia ilustrativa. Confira os dados antes de enviar.</p><div class="review-note">${icon('shield-check')}O próximo passo é a revisão. O disparo só começa quando você confirmar.</div>
      </aside></div>`,
      `${cancelButton}<button type="submit" class="button primary">${icon('clipboard-check')}Salvar e revisar envio</button>`,
      true,
      'easy-campaign-form',
    );
    modal.classList.add('composer-modal');
    let templates = [],
      templateVersion = 0;
    const picker = new AudiencePicker((summary) => {
      $('#easy-count').textContent = summary ? number(summary.eligible) : '—';
      refreshPreview();
    });
    const selectedTemplate = () => templates.find((template) => template.id === $('#easy-template').value);
    const parameters = () =>
      Object.fromEntries(
        [...$('#easy-fields').querySelectorAll('[data-param]')].map((input) => [
          input.dataset.param,
          input.value,
        ]),
      );
    function refreshPreview() {
      const template = selectedTemplate();
      const params = parameters();
      const sample = picker.summary?.contacts?.find((contact) => !contact.blocked);
      $('#easy-preview').textContent = templateText(
        template?.text || 'Escolha um modelo para visualizar sua mensagem aqui.',
        params,
        sample,
      );
      const values = Object.values(params);
      $('#easy-filled').textContent = `${values.filter((value) => value.trim()).length} de ${values.length}`;
      $('#easy-sample-note').textContent = sample
        ? `Exemplo para ${sample.name}. {{nome}} e {{telefone}} usam os dados de cada contato.`
        : 'Prévia ilustrativa. {{nome}} e {{telefone}} usam os dados de cada contato.';
      const channel = official.find((channel) => channel.id === $('#easy-channel').value);
      $('#easy-sender').textContent =
        channel?.identity?.displayName || channel?.numberFormatted || 'Sua empresa';
    }
    function renderFields() {
      const template = selectedTemplate();
      $('#easy-fields').innerHTML = (template?.params || [])
        .filter((param) => param.name)
        .map(
          (param) =>
            `<label>${escape(friendlyVariable(param.name))}<div class="variable-control"><input data-param="${escape(param.name)}" required maxlength="2000" placeholder="Preencha ${escape(friendlyVariable(param.name).toLowerCase())}"><button type="button" class="variable-chip" title="Usar o nome salvo de cada contato">${icon('user-round')}Nome do contato</button></div><span class="field-hint">Campo ${escape(param.name)}. Digite um valor fixo ou use o nome de cada contato.</span></label>`,
        )
        .join('');
      $('#easy-fields')
        .querySelectorAll('.variable-chip')
        .forEach((button) =>
          button.addEventListener('click', () => {
            $('input', button.parentElement).value = '{{nome}}';
            refreshPreview();
          }),
        );
      const media = template?.fileType && String(template.fileType).toUpperCase() !== 'UNDEFINED';
      $('#easy-media').innerHTML = media
        ? `<label>Link da mídia (${escape(template.fileType.toLowerCase())})<input name="fileUrl" type="url" required placeholder="https://seu-site.com/arquivo"><p class="field-hint">Este modelo precisa de uma mídia disponível em uma URL HTTPS.</p></label>`
        : '';
      $('#easy-media-preview').textContent = media
        ? `O envio também incluirá a mídia do tipo ${template.fileType.toLowerCase()}.`
        : '';
      refreshPreview();
      icons();
    }
    async function loadTemplates(preselect) {
      const request = ++templateVersion;
      const select = $('#easy-template');
      const channel = $('#easy-channel').value;
      templates = [];
      select.disabled = true;
      select.innerHTML = '<option value="">Carregando modelos…</option>';
      $('#easy-template-info').textContent = '';
      renderFields();
      try {
        const result = await api(`/templates?channelId=${encodeURIComponent(channel)}`);
        if (request !== templateVersion || !select.isConnected) return;
        templates = result.filter(
          (template) =>
            template.active &&
            !template.archived &&
            String(template.status).toUpperCase() === 'APPROVED' &&
            template.channelId === channel,
        );
        select.innerHTML =
          '<option value="">Escolha sua mensagem</option>' +
          templates
            .map((template) => `<option value="${escape(template.id)}">${escape(template.name)}</option>`)
            .join('');
        if (templates.some((template) => template.id === preselect)) select.value = preselect;
        else if (templates.length === 1) select.value = templates[0].id;
        $('#easy-template-info').textContent = templates.length
          ? `${templates.length} modelo(s) aprovado(s) neste canal.`
          : 'Nenhum modelo aprovado disponível neste canal. Confira os modelos na FLW.';
        select.disabled = false;
        renderFields();
      } catch (error) {
        if (!select.isConnected || request !== templateVersion) return;
        select.innerHTML = '<option value="">Não foi possível carregar</option>';
        $('#easy-template-info').innerHTML =
          `${escape(error.message)} <button type="button" class="button ghost" id="retry-easy-templates">Tentar novamente</button>`;
        $('#retry-easy-templates').addEventListener('click', () => loadTemplates());
      }
    }
    $('#easy-channel').addEventListener('change', () => loadTemplates());
    $('#easy-template').addEventListener('change', renderFields);
    $('#easy-campaign-form').addEventListener('input', refreshPreview);
    bindForm('easy-campaign-form', async (form) => {
      const template = selectedTemplate();
      if (!template) throw new Error('Escolha um modelo aprovado para continuar.');
      const body = {
        name: form.get('name'),
        channelId: form.get('channelId'),
        templateId: template.id,
        parameters: parameters(),
        fileUrl: form.get('fileUrl') || '',
      };
      const recipients = await picker.payload();
      const result = await api('/campaigns', { method: 'POST', body: { ...body, ...recipients } });
      modal.close();
      toast('Envio salvo. Confira o resumo e confirme quando estiver pronto.');
      await renderPage(true);
      await campaignDetails(result.id);
    });
    const preselected = state.templates.find((template) => template.id === preselectedTemplate);
    if (preselected && official.some((channel) => channel.id === preselected.channelId))
      $('#easy-channel').value = preselected.channelId;
    await loadTemplates(preselectedTemplate);
    icons();
  } catch (error) {
    if (modal.open)
      showModal(
        'Não foi possível preparar seu envio',
        'Confira a integração e tente novamente.',
        `<div class="alert error">${escape(error.message)}</div>`,
        '<button class="button" data-action="close-modal">Fechar</button>',
      );
  }
}

actions['download-txt'] = () => {
  const url = URL.createObjectURL(
    new Blob(['Provedor Alfa;5591999990001\nProvedor Beta;5591999990002\n'], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'exemplo-contatos.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
actions['use-template'] = (element) => openEasyCampaign(element.dataset.id);
