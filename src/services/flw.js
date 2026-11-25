export class ApiError extends Error {
  constructor(message, status = 502, uncertain = false) {
    super(message);
    this.status = status;
    this.uncertain = uncertain;
  }
}

export class FlwClient {
  constructor(config) {
    this.config = config;
  }
  async request(path, { method = 'GET', body, query = {} } = {}) {
    if (!this.config.apiToken)
      throw new ApiError('Configure FLW_API_TOKEN no .env e reinicie o servidor.', 503);
    const url = new URL(`${this.config.apiBase}${path}`);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new ApiError(
        'A FLW não respondeu a tempo. Confira o resultado na plataforma antes de reenviar.',
        502,
        method === 'POST',
      );
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        response.status === 401
          ? 'Token FLW inválido ou expirado.'
          : response.status === 429
            ? 'Limite de requisições da FLW atingido. Aguarde para continuar.'
            : `A FLW recusou a operação (HTTP ${response.status}). ${String(data?.detail || data?.title || data?.message || '').slice(0, 250)}`;
      throw new ApiError(
        message,
        response.status === 429 ? 429 : 502,
        method === 'POST' && response.status >= 500,
      );
    }
    if (!data || typeof data !== 'object') {
      throw new ApiError(
        'A FLW retornou uma resposta inválida. Confira a operação na plataforma antes de reenviar.',
        502,
        method === 'POST',
      );
    }
    return data;
  }
  async allPages(path, query = {}) {
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.request(path, { query: { ...query, PageNumber: page, PageSize: 100 } });
      if (Array.isArray(data)) return data;
      items.push(...(data?.items || []));
      if (!data?.hasMorePages && !(data?.totalPages > page)) return items;
    }
    throw new ApiError('A consulta excedeu 100 páginas. Refine a consulta na plataforma FLW.');
  }
  channels() {
    return this.request('/v1/channel', { query: { ChannelType: 'Whatsapp' } });
  }
  templates(channelId) {
    return this.allPages('/v1/template', {
      ApprovedOnly: true,
      Archived: false,
      ChannelId: channelId,
      IncludeDetails: 'All',
    });
  }
  sendTemplate(body) {
    return this.request('/v1/send/template', { method: 'POST', body });
  }
  messageStatus(id) {
    return this.request(`/v1/send/message/${encodeURIComponent(id)}`);
  }
  sessions(channelId, after, page = 1) {
    return this.request('/v2/session', {
      query: {
        PageNumber: page,
        PageSize: 20,
        ChannelsId: channelId,
        'LastInteractionAt.After': after,
        IncludeDetails: 'ContactDetails',
        OrderBy: 'LastInteractionAt',
        OrderDirection: 'DESCENDING',
      },
    });
  }
  session(id) {
    return this.request(`/v2/session/${encodeURIComponent(id)}`, { query: { IncludeDetails: 'ContactDetails' } });
  }
  messages(id, page = 1) {
    return this.request(`/v1/session/${encodeURIComponent(id)}/message`, {
      query: { PageNumber: page, PageSize: 25, OrderBy: 'CreatedAt', OrderDirection: 'DESCENDING' },
    });
  }
  reply(id, text) {
    return this.sessionMessage(id, { text });
  }
  sessionMessage(id, body) {
    return this.request(`/v1/session/${encodeURIComponent(id)}/message`, { method: 'POST', body });
  }
}
