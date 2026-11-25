import { createClient, reportError } from './lib/flw-cli.js';

// Executar: npm run flw:templates -- ID_DO_CANAL
// Sem ID, consulta os templates aprovados de todos os canais acessíveis.
try {
  const args = process.argv.slice(2);
  const channelId = args[0];
  if (args.length > 1 || (channelId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channelId))) {
    throw new Error('Use npm run flw:templates -- ID_DO_CANAL, com o UUID mostrado na consulta de conexão.');
  }

  const client = createClient();
  console.log('Consultando GET /v1/template com ApprovedOnly=true e Archived=false.');
  console.log(channelId ? `Canal selecionado: ${channelId}` : 'Consultando todos os canais acessíveis.');
  console.log('Se houver mais de uma página, o script consulta as páginas seguintes.');

  const templates = await client.templates(channelId);
  console.log(`\n${templates.length} template(s) aprovado(s) retornado(s).`);
  for (const template of templates) {
    console.log('\n----------------------------------------');
    console.log(`Nome: ${template.name || 'Sem nome'}`);
    console.log(`ID: ${template.id}`);
    console.log(`Canal: ${template.channelId || 'Não informado'}`);
    console.log(`Status: ${template.status} | Ativo: ${template.active ? 'Sim' : 'Não'}`);
    console.log(`Variáveis: ${(template.params || []).map(param => param.name).filter(Boolean).join(', ') || 'Nenhuma'}`);
    console.log(`Mídia: ${template.fileType || 'UNDEFINED'}`);
    console.log(`Texto:\n${template.text || '(Sem texto; confira o conteúdo na FLW.)'}`);
  }
  console.log('\nConsulta finalizada. Nenhuma mensagem foi enviada.');
} catch (error) {
  reportError(error);
}
