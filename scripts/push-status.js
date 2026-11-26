import Database from 'better-sqlite3';

// Apenas leitura. A conexão não passa pelas migrações e pela inicialização das campanhas.
const db = new Database(process.env.DATABASE_PATH || './data/totalk.sqlite', { readonly: true, fileMustExist: true });
const time = value => value ? new Date(value).toISOString() : 'sem registro';
try {
  const subs = db.prepare(`SELECT count(*) AS total, count(channel) AS vinculadas FROM push_subscriptions`).get();
  console.log('Inscrições no painel:', subs.total);
  console.log('Inscrições vinculadas a um WhatsApp:', subs.vinculadas);
  const lastScan = db.prepare(`SELECT max(CAST(value AS INTEGER)) AS at FROM metadata
    WHERE key IN (SELECT 'pushCursor:' || channel FROM push_subscriptions)`).get();
  console.log('Última consulta concluída em um canal inscrito (UTC):', time(lastScan.at));
  const lastEvent = db.prepare("SELECT max(received_at) AS at FROM webhook_events WHERE event_type='MESSAGE_RECEIVED'").get();
  console.log('Último evento de mensagem registrado no painel (UTC):', time(lastEvent.at));
  console.log('Avisos pendentes agora:', db.prepare('SELECT count(*) AS n FROM push_deliveries').get().n);
  for (const [key, label] of [['pushLastAccepted', 'Último push aceito pelo serviço do celular'], ['pushLastFailure', 'Última falha de envio']]) {
    const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    const result = row && JSON.parse(row.value);
    console.log(label + ' (UTC):', result ? time(result.at) + ' (' + (result.code ? 'HTTP ' + result.code : 'sem resposta HTTP') + ')' : 'sem registro');
  }
} catch {
  console.error('Não foi possível consultar o estado das notificações. Confira a versão do container e o banco configurado.');
  process.exitCode = 1;
} finally {
  db.close();
}
