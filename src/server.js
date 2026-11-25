import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { FlwClient } from './services/flw.js';
import { CampaignService } from './services/campaigns.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const flw = new FlwClient(config);
const campaigns = new CampaignService(db, flw, config);
const app = createApp({ config, db, flw, campaigns });
const server = app.listen(config.port, config.host, () => {
  console.log(`Totalk Studio disponível em http://${config.host}:${config.port}`);
  console.log(
    config.apiToken
      ? 'Token FLW configurado. Teste a conexão no painel.'
      : 'Configure FLW_API_TOKEN no .env para conectar sua conta.',
  );
  campaigns.startWorker();
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    campaigns.stop();
    server.close(async () => {
      while (campaigns.busy) await new Promise((resolve) => setTimeout(resolve, 100));
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 30000).unref();
  });
