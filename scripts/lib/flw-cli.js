import 'dotenv/config';
import { FlwClient } from '../../src/services/flw.js';

// Estes comandos precisam apenas da configuração da FLW.
// Não iniciam o Express, não abrem o banco e não executam a fila de campanhas.
export function createClient() {
  const token = process.env.FLW_API_TOKEN?.trim();
  if (!token) {
    throw new Error('Preencha FLW_API_TOKEN no arquivo .env antes de executar este comando.');
  }

  const base = new URL(process.env.FLW_API_BASE_URL || 'https://api.wts.chat/chat');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('FLW_API_BASE_URL deve ser uma URL HTTPS sem credenciais, parâmetros ou fragmentos.');
  }

  return new FlwClient({ apiToken: token, apiBase: base.toString().replace(/\/$/, '') });
}

export function reportError(error) {
  // Não mostrar token, mesmo se o provedor o repetir no texto de um erro.
  const token = process.env.FLW_API_TOKEN?.trim();
  let message = String(error.message || 'Não foi possível concluir a consulta.');
  if (token) message = message.replaceAll(token, '[TOKEN OCULTO]');
  console.error(`\nFalha: ${message}`);
  console.error('Nenhuma mensagem foi enviada.');
  process.exitCode = 1;
}
