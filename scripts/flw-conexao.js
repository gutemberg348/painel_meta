import { createClient, reportError } from './lib/flw-cli.js';

// Executar: npm run flw:conexao
// Uma consulta GET para verificar se o token permite listar canais WhatsApp.
try {
  const client = createClient();
  console.log('Consultando GET /v1/channel?ChannelType=Whatsapp');
  console.log('O token é lido do .env e enviado no cabeçalho Authorization: Bearer.');

  const channels = await client.channels();
  if (!Array.isArray(channels)) throw new Error('A API retornou um formato inesperado para os canais.');

  console.log(`\nConexão confirmada. ${channels.length} canal(is) encontrado(s).`);
  if (channels.length) {
    console.table(channels.map(channel => ({
      ID: channel.id,
      Nome: channel.identity?.displayName || 'Sem nome',
      Número: channel.numberFormatted || channel.number || 'Não informado',
      Tipo: channel.type,
      Ativo: channel.active ? 'Sim' : 'Não',
    })));
  } else {
    console.log('A consulta funcionou, mas este token não retornou canais WhatsApp.');
  }

  console.log('\nPróximo passo: npm run flw:templates -- ID_DO_CANAL');
  console.log('Esta consulta não envia mensagens nem confirma permissão de disparo.');
} catch (error) {
  reportError(error);
}
