import { randomUUID } from 'node:crypto';

export const now = () => new Date().toISOString();
const providerStatuses = new Set([
  'PROCESSING',
  'SAVED',
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'DELETED',
  'WAIT_REPLY',
]);

export function applyProviderStatus(db, deliveryId, response) {
  const existing = db.prepare('SELECT * FROM deliveries WHERE id=?').get(deliveryId);
  if (!existing) return;
  let status = providerStatuses.has(response?.status) ? response.status.toLowerCase() : 'queued';
  const ranks = { processing: 0, saved: 1, queued: 2, sent: 3, delivered: 4, read: 5 };
  if (
    ranks[existing.status] !== undefined &&
    ranks[status] !== undefined &&
    ranks[existing.status] > ranks[status]
  )
    status = existing.status;
  db.prepare(
    'UPDATE deliveries SET status=?, provider_id=COALESCE(?,provider_id), session_id=COALESCE(?,session_id), error=?, updated_at=? WHERE id=?',
  ).run(
    status,
    response?.id || null,
    response?.sessionId || null,
    response?.failedReason || null,
    now(),
    deliveryId,
  );
}

export class CampaignService {
  constructor(db, flw, config) {
    this.db = db;
    this.flw = flw;
    this.config = config;
    this.busy = false;
    this.stopped = false;
  }
  startWorker() {
    this.timer = setInterval(
      () => this.tick().catch((error) => console.error('Falha na fila:', error.message)),
      this.config.sendInterval,
    );
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
  start(id) {
    if (!this.config.apiToken)
      throw Object.assign(new Error('Configure o token FLW antes de disparar.'), { status: 400 });
    const campaign = this.db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
    if (!campaign) throw Object.assign(new Error('Campanha não encontrada.'), { status: 404 });
    if (!['draft', 'paused'].includes(campaign.status))
      throw Object.assign(new Error('Esta campanha já foi iniciada ou finalizada.'), { status: 409 });
    this.db.transaction(() => {
      if (campaign.status === 'draft') {
        const contacts = this.db
          .prepare(
            'SELECT c.* FROM contacts c JOIN list_contacts lc ON lc.contact_id=c.id WHERE lc.list_id=? AND c.opted_in=1',
          )
          .all(campaign.list_id);
        if (!contacts.length)
          throw Object.assign(new Error('A lista não possui contatos com autorização de envio.'), {
            status: 400,
          });
        const insert = this.db.prepare(
          'INSERT INTO deliveries (id,campaign_id,contact_id,name,phone,updated_at) VALUES (?,?,?,?,?,?)',
        );
        for (const c of contacts) insert.run(randomUUID(), id, c.id, c.name, c.phone, now());
      }
      this.db
        .prepare("UPDATE campaigns SET status='running', started_at=COALESCE(started_at,?) WHERE id=?")
        .run(now(), id);
    })();
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const campaign = this.db
        .prepare("SELECT * FROM campaigns WHERE status='running' ORDER BY started_at LIMIT 1")
        .get();
      if (!campaign) return;
      const delivery = this.db
        .prepare("SELECT * FROM deliveries WHERE campaign_id=? AND status='pending' ORDER BY rowid LIMIT 1")
        .get(campaign.id);
      if (!delivery) {
        this.db
          .prepare("UPDATE campaigns SET status='completed' WHERE id=? AND status='running'")
          .run(campaign.id);
        return;
      }
      const contact = this.db.prepare('SELECT * FROM contacts WHERE id=?').get(delivery.contact_id);
      if (!contact?.opted_in || contact.phone !== delivery.phone) {
        this.db
          .prepare(
            "UPDATE deliveries SET status='skipped', error='Contato sem autorização, removido ou com telefone alterado.', updated_at=? WHERE id=?",
          )
          .run(now(), delivery.id);
        return;
      }
      this.db
        .prepare("UPDATE deliveries SET status='sending', updated_at=? WHERE id=?")
        .run(now(), delivery.id);
      const parameters = Object.fromEntries(
        Object.entries(JSON.parse(campaign.parameters)).map(([key, value]) => [
          key,
          value.replaceAll('{{nome}}', delivery.name).replaceAll('{{telefone}}', delivery.phone),
        ]),
      );
      const body = {
        to: delivery.phone,
        from: campaign.sender,
        templateId: campaign.template_id,
        parameters,
        senderId: delivery.id,
      };
      if (campaign.file_url) body.fileIdOrUrl = campaign.file_url;
      if (this.config.publicUrl && this.config.webhookSecret)
        body.callbackUrl = `${this.config.publicUrl}/webhooks/flw/${this.config.webhookSecret}`;
      try {
        const response = await this.flw.sendTemplate(body);
        if (!response?.id)
          throw Object.assign(new Error('A API não retornou um ID. Verifique o envio na FLW.'), {
            uncertain: true,
          });
        applyProviderStatus(this.db, delivery.id, response);
      } catch (error) {
        const status = error.uncertain ? 'unknown' : error.status === 429 ? 'pending' : 'failed';
        this.db
          .prepare('UPDATE deliveries SET status=?, error=?, updated_at=? WHERE id=?')
          .run(status, error.message, now(), delivery.id);
        // Pausar permite corrigir token, limite ou template antes de consumir a lista inteira.
        const remaining = this.db
          .prepare("SELECT COUNT(*) n FROM deliveries WHERE campaign_id=? AND status='pending'")
          .get(campaign.id).n;
        this.db
          .prepare("UPDATE campaigns SET status=? WHERE id=? AND status='running'")
          .run(remaining ? 'paused' : 'completed', campaign.id);
      }
    } finally {
      this.busy = false;
    }
  }
  async sync(id) {
    const rows = this.db
      .prepare(
        "SELECT * FROM deliveries WHERE campaign_id=? AND provider_id IS NOT NULL AND status NOT IN ('read','failed','deleted') ORDER BY updated_at LIMIT 100",
      )
      .all(id);
    for (const row of rows)
      applyProviderStatus(this.db, row.id, await this.flw.messageStatus(row.provider_id));
    return rows.length;
  }
}
