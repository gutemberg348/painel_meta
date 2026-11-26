# Totalk Studio

Painel administrativo de WhatsApp feito com **Node.js + Express**, EJS, JavaScript puro e SQLite. Visual azul-claro e branco, fonte Inter hospedada localmente e interface responsiva.

## Começar

Requer Node.js **22.13 ou superior**.

```bash
npm install
npm run setup
```

O setup cria `.env` e gera os segredos de sessão e webhook. Ele preserva qualquer `.env` existente. Edite:

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=sua-senha-forte
FLW_API_TOKEN=seu-token-permanente
```

```bash
npm run dev
```

Acesse **http://127.0.0.1:3000** e use o usuário/senha do `.env`. O projeto abre sem token para permitir cadastrar contatos e listas; as funções da FLW pedem que a integração seja configurada. Os dados começam vazios, sem resultados fictícios.

`npm start` executa sem recarregamento automático. Depois de alterar `.env`, reinicie o processo — o modo `--watch` não acompanha esse arquivo automaticamente.

## Consultar a FLW pelo terminal, passo a passo

Os scripts abaixo são executados por você, na pasta do projeto. Não precisam do painel aberto. Eles carregam o `.env`, fazem consultas à FLW e encerram; não iniciam o Express, o banco ou a fila de disparos. Cada nova execução relê o `.env`.

### 1. Configurar o token

Preencha `FLW_API_TOKEN` no `.env` com o token permanente, sem escrever `Bearer` antes dele. O código adiciona esse prefixo no cabeçalho HTTP. O token não aparece na saída do terminal.

### 2. Testar a conexão e listar canais

```bash
npm run flw:conexao
```

Esse comando executa `scripts/flw-conexao.js` e faz `GET /v1/channel?ChannelType=Whatsapp`. Uma resposta válida mostra **Conexão confirmada** e uma tabela com ID, nome, número, tipo e situação dos canais. A consulta confirma acesso à listagem; não comprova que a conta pode disparar mensagens. Uma lista vazia significa que a consulta funcionou, mas nenhum canal foi retornado.

### 3. Consultar os templates aprovados

Copie o ID de um canal da tabela anterior e substitua `ID_DO_CANAL`:

```bash
npm run flw:templates -- ID_DO_CANAL
```

O `--` repassa o argumento ao script `scripts/flw-templates.js`. Ele consulta `GET /v1/template` com filtros de aprovação, arquivamento e canal, percorrendo a paginação. A saída mostra ID, texto, variáveis e tipo de mídia de cada template.

Para consultar todos os canais acessíveis, omita o ID:

```bash
npm run flw:templates
```

### Entender os erros

- **Preencha FLW_API_TOKEN:** o token está vazio ou o comando foi executado fora da pasta do projeto.
- **Token inválido ou expirado:** a FLW recusou a autenticação.
- **HTTP 403:** confira as permissões da integração na FLW.
- **Limite de requisições:** aguarde antes de consultar novamente.
- **Não respondeu a tempo:** confira conexão de rede, endereço da API e disponibilidade da FLW.

Em erro, os scripts terminam com código de saída `1` (`$LASTEXITCODE` no PowerShell). Em sucesso, terminam com `0`. Nenhum desses comandos envia mensagens. O envio de teste é uma etapa posterior, após escolher canal, template, variáveis e destinatário.

## O que está implementado

- Login do gerente pelo `.env`, contas de equipe no SQLite, cookie HttpOnly, proteção CSRF e limitação de tentativas.
- Dashboard com indicadores reais do banco e atividade dos últimos sete dias, agrupada por UTC.
- Cadastro, edição, exclusão e busca de contatos; um contato pode estar em várias listas.
- Ao criar uma lista ou importar contatos para uma nova lista, o nome é opcional. Em branco, o painel gera um nome como `Lista 4d21a8bc19`.
- No cadastro individual, basta salvar o contato. Ele começa sem autorização de envio. Para registrar ou revogar a autorização, abra **Editar contato → Permissão de envio**.
- Importação CSV/TXT ou números colados, com prévia, validação integral, deduplicação por telefone e transação atômica.
- Consulta de canais oficiais WhatsApp e templates aprovados da FLW.
- Criação de campanhas com mensagem e destinatários no mesmo formulário, prévia, variáveis, URL de mídia quando necessária e rascunho. Criação automática da lista ao adicionar números diretamente.
- Confirmação antes do disparo, fila persistente, pausa, retomada, cancelamento e resultado por destinatário.
- Atualização manual de entregas e callback opcional com verificação na API.
- Caixa de entrada com filtro por canal e período, atualização sob demanda e resposta de texto quando a janela está ativa.
- Tela de configuração e teste de conexão sem envio de mensagens.

## Contas da equipe

O administrador configurado no `.env` é o gerente. Em **Administração → Usuários → Criar usuário**, ele define login, senha e perfil. Em **Editar**, pode mudar o perfil, redefinir a senha e desativar o acesso. Alterar o cadastro invalida as sessões anteriores da pessoa. Cada usuário entra pelo mesmo endereço do painel com suas próprias credenciais.

| Perfil | Acesso |
| --- | --- |
| Atendente | Caixa de entrada, histórico e respostas |
| Enviador | Caixa de entrada, contatos, listas, templates e operações de campanha, incluindo o disparo |
| Gerente | Todas as áreas, incluindo usuários, indicadores e configurações |

As senhas da equipe são armazenadas como hashes scrypt com salt individual. Inclua o banco SQLite no backup para preservar as contas.

## Fluxo de uso

1. Preencha o token e clique em **Configurações → Testar conexão**.
2. Clique em **Preparar um envio** ou **Nova campanha**.
3. Escolha o canal oficial e o modelo aprovado. Preencha os campos da mensagem; a prévia acompanha as alterações. Templates com status `APPROVED` ou `Approved` são aceitos.
4. Em **Quem vai receber?**, escolha **Colar números**, **Enviar arquivo** (CSV/TXT) ou **Usar uma lista**. Não é necessário cadastrar uma lista antes: ao adicionar números diretamente, o painel cria uma lista com o nome da campanha, junto com o rascunho.
5. Confira os números normalizados, duplicados removidos e linhas inválidas. O seletor **Brasil (+55)** adiciona 55 aos números nacionais com 10 ou 11 dígitos. Para outros países, escolha **Internacional** e informe DDI. Números com `+` não recebem um DDI adicional. Confirme a autorização apenas quando os contatos tiverem consentido.
6. Clique em **Salvar e revisar envio**. Confira o resumo, clique em **Revisar e disparar** e confirme. Salvar o rascunho não envia mensagens.
7. Abra os detalhes para pausar ou atualizar entregas. As respostas ficam na **Caixa de entrada**.

A criação/aprovação de templates ocorre na FLW/Meta. A caixa de entrada mostra conversas do canal WhatsApp selecionado, inclusive as iniciadas na FLW. Mensagens com mídia são identificadas. Os anexos podem ser visualizados na FLW.

Na caixa de entrada, escolha o canal da empresa se o token der acesso a vários canais. O período inicial é de sete dias e usa a data da última interação. As conversas são carregadas em páginas de até 20. A busca atua na página atual. Leituras simultâneas da mesma página compartilham uma consulta à FLW e seu resultado pode ser reutilizado por quatro segundos.

Enquanto a conversa está visível e exibe as mensagens recentes, o navegador consulta a versão do histórico no painel a cada cinco segundos. Um envio pela equipe invalida o cache daquela conversa e da lista do canal. O histórico aberto também consulta novidades externas em ciclos de aproximadamente 30 segundos. A lista continua com atualização manual. Uma resposta concorrente pode pedir revisão do rascunho antes de um novo envio.

Para deixar a caixa de entrada fixa em um canal, configure `FLW_INBOX_CHANNEL_ID` no `.env` e recrie o contêiner. Use o ID retornado por `npm run flw:conexao` (na VPS, `sudo docker compose exec painel npm run flw:conexao`). O painel confere se esse canal aparece entre os canais WhatsApp do token. Confirme o nome e o número do canal antes de escolher seu ID.

O botão **Nome do contato**, ao lado de uma variável, preenche `{{nome}}`: cada destinatário recebe o nome salvo no contato. Você também pode digitar `{{telefone}}`. Para usar um nome de provedor diferente por destinatário, importe o nome do provedor na coluna `nome` e use esse botão no campo correspondente. Variáveis como `[nome_provedor]` e `[nome_empresa]` aparecem com rótulos legíveis; as chaves originais são preservadas no envio à FLW.

Para apenas cadastrar contatos, use **Contatos → Adicionar em lote**. Escolha uma lista existente ou crie uma nova no mesmo formulário.

## CSV, TXT e números colados

Formato UTF-8, com ou sem BOM. Até 5.000 contatos e 900 KB por arquivo. No CSV, use vírgula ou ponto e vírgula. O cabeçalho pode ser `nome,telefone,email` ou apenas `telefone`. Nome e e-mail são opcionais; quando não há nome, o cadastro usa `Contato <telefone>`.

```csv
nome,telefone,email
Marina Oliveira,5591999999999,marina@example.com
João Souza,5591888888888,
```

Se qualquer linha for inválida, nenhuma linha é importada. Telefones existentes são associados à lista sem duplicação e sem sobrescrever seus dados. Uma importação **não reativa** contatos cuja autorização está desmarcada; use a edição individual quando houver nova autorização.

No TXT ou no campo de colagem, informe um telefone por linha:

```text
5591999999999
5591888888888
```

Ou inclua o nome, separado por ponto e vírgula:

```text
Provedor Alfa;5591999999999
Provedor Beta;5591888888888
```

O cadastro manual individual continua exigindo DDI. Na importação, a inclusão de 55 depende da opção de país mostrada no formulário. A prévia consulta apenas o servidor local; ela não salva contatos nem faz requisições à FLW.

## Estrutura para desenvolver

```text
src/
  server.js                Inicialização, worker e encerramento
  app.js                   Express, autenticação, CSRF e webhook
  config.js                Leitura e validação do .env
  db.js                    Schema SQLite e armazenamento das sessões
  routes/api.js            Validação e rotas do painel
  services/
    flw.js                 Cliente HTTP da API FLW
    campaigns.js           Fila de envios e atualização de status
    audience.js            Leitura, validação, deduplicação e importação CSV/TXT/texto
views/
  login.ejs                Tela de acesso
  index.ejs                Estrutura do painel
public/
  css/style.css            Design responsivo
  css/compose.css          Refinamento visual e formulário de envio
  js/app.js                Telas, formulários e chamadas ao backend
  js/compose.js            Formulário de envio, prévia de contatos e variáveis
  js/login.js              Interação da tela de login
scripts/setup.js           Criação inicial do .env
test/                     Testes de servidor e navegador com API simulada
data/                     SQLite em execução; ignorado pelo Git
```

Não há etapa de build. O Express entrega os arquivos estáticos e renderiza o HTML inicial. O navegador acessa somente `/api/...`; o token FLW é adicionado pelo servidor às requisições externas. SQL usa parâmetros. Schemas Zod validam os dados de entrada.

## API FLW utilizada

Base documentada: `https://api.wts.chat/chat`. Autenticação: `Authorization: Bearer TOKEN`.

| Operação                         | Endpoint                                            |
| -------------------------------- | --------------------------------------------------- |
| Canais WhatsApp                  | `GET /v1/channel?ChannelType=Whatsapp`              |
| Templates aprovados              | `GET /v1/template?ApprovedOnly=true&Archived=false` |
| Disparo individual por template  | `POST /v1/send/template`                            |
| Status de envio                  | `GET /v1/send/message/{id}`                         |
| Conversas                        | `GET /v2/session` com `ChannelsId` e `LastInteractionAt.After` |
| Detalhe e janela de uma conversa | `GET /v2/session/{id}`                              |
| Mensagens de uma conversa        | `GET /v1/session/{id}/message`                      |
| Resposta em uma conversa         | `POST /v1/session/{id}/message`                     |

O payload de campanha usa `to`, `from` (número do canal), `templateId`, `parameters`, `senderId` e, quando aplicável, `fileIdOrUrl` e `callbackUrl`. A consulta de templates percorre as páginas (até 100 páginas). Conversas e mensagens são paginadas na interface.

Referências: [autenticação](https://flwchat.readme.io/reference/autentica%C3%A7%C3%A3o), [envio de template](https://flwchat.readme.io/reference/post_v1-send-template), [conversas](https://flwchat.readme.io/reference/get_v2-session), [webhooks](https://flwchat.readme.io/reference/webhooks-1).

## Como a fila funciona

- Execute **uma instância** do aplicativo/worker por banco SQLite. Não use cluster ou múltiplas réplicas com este banco.
- A confirmação congela os destinatários autorizados da lista. Antes de cada envio, a autorização e o telefone são conferidos novamente.
- `SEND_INTERVAL_MS` controla o intervalo entre destinatários; mínimo de 500 ms, padrão de 1 segundo. Os limites da conta continuam sendo aplicados pela FLW.
- A resposta HTTP da API significa que ela recebeu o pedido; não comprova entrega ou leitura.
- “Processada” significa que a fila local terminou. Consulte as entregas para conferir `queued`, `sent`, `delivered`, `read` ou falha.
- Uma falha pausa os destinatários ainda pendentes; se não houver pendentes, a campanha é finalizada como processada com o erro individual registrado.
- HTTP 429 mantém o destinatário pendente e pausa a campanha. Aguarde antes de retomar.
- Timeout, falha de rede ou HTTP 5xx durante POST ficam como **Verificar na FLW**. Não há reenvio automático, pois o provedor pode já ter aceitado a mensagem.
- Reiniciar o servidor pausa campanhas ativas e marca requisições em andamento como indeterminadas. Confira na FLW antes de criar um novo envio para esses contatos.
- Pausar/cancelar não cancela uma requisição que já saiu do servidor.
- “Atualizar entregas” consulta até 100 registros por vez. As próximas consultas priorizam os menos recentemente atualizados.

`senderId` é usado para rastreamento; a documentação não foi interpretada como garantia de idempotência do provedor.

## Webhook opcional

Para os callbacks de status, configure:

```dotenv
PUBLIC_URL=https://totalk.testes-techcode.shop
WEBHOOK_SECRET=um-segredo-longo-e-aleatorio
```

O servidor inclui automaticamente a URL `PUBLIC_URL/webhooks/flw/WEBHOOK_SECRET` nos disparos. O endpoint aceita o callback direto ou o envelope documentado `{ eventType, date, content }`. O status recebido é confirmado por consulta à API antes de alterar o banco. Eventos repetidos são registrados uma única vez; dados completos de contatos/mensagens do webhook não são persistidos.

Não é preciso webhook para ler respostas: a caixa de entrada consulta a API diretamente. Não exponha URLs com o segredo em logs públicos.

## Instalar o Vieira Link no celular e receber notificações

O aplicativo usa o mesmo endereço HTTPS do painel. Depois do login, toque em **Ativar notificações** no topo do painel. Fechar o convite dispensa o aviso nessa visita. As opções também ficam em **Aplicativo e notificações** no menu. No Android, toque em **Instalar aplicativo**. No iPhone com iOS 16.4 ou superior, abra o painel no Safari, toque em **Compartilhar → Adicionar à Tela de Início** e entre pelo ícone Vieira Link. Toque em **Ativar notificações** e confirme **Permitir**. Cada aparelho tem sua própria preferência.

Com o token FLW configurado e um aparelho inscrito, a VPS procura mensagens novas de clientes a cada 20 segundos. Cada aparelho acompanha um canal WhatsApp. Os avisos pendentes são agrupados e expiram em 90 segundos. Ao reiniciar, o monitor acompanha as mensagens que chegarem a partir desse momento.

O webhook é opcional. Se já houver uma assinatura de **MESSAGE_RECEIVED** na FLW apontando para o painel, ela pode antecipar o aviso. O identificador da mensagem evita que a consulta e o webhook gerem dois avisos para o mesmo aparelho.

O aviso abre a caixa de entrada e exibe apenas que chegou uma mensagem. Se o token tiver vários canais disponíveis no painel, escolha o número ao ativar as notificações. Para parar em um aparelho, escolha **Desativar notificações**. Sair da conta pelo menu também encerra o recebimento nesse aparelho.

A caixa de entrada reúne as sessões do mesmo contato no mesmo canal e usa a sessão mais recente para responder. A leitura é registrada por usuário do painel quando as últimas mensagens estão visíveis na conversa. A lista e o chat se atualizam ao receber um evento e também consultam as novidades a cada cinco segundos enquanto a caixa estiver aberta.

## Testar

```bash
npm test
npm run test:ui
```

Os testes usam SQLite em memória e uma FLW simulada; não usam seu token e não fazem disparos reais. Os testes do navegador usam Edge no Windows quando disponível, ou Chromium instalado pelo Playwright (`npx playwright install chromium`). Capturas de tela ficam em `test-results/`.

```bash
npm run format
```

Formata JavaScript, CSS e documentação para facilitar a leitura. As views EJS são editadas diretamente.

## Executar em produção

### VPS Linux com Docker Compose

O serviço `painel` roda **um contêiner**. O processo `node src/server.js` serve o painel Express, abre o SQLite e inicia a fila de campanhas. Use uma única instância por banco. O acesso público passa por um proxy HTTPS instalado na própria VPS.

```text
Navegador → HTTPS → proxy da VPS → 127.0.0.1:3038 → painel
                                                      ├── Express e fila → API FLW
                                                      └── /app/data → ./data na VPS
```

| Arquivo ou diretório | Função |
| --- | --- |
| `Dockerfile` | Monta as dependências Linux com `npm ci` e o lockfile. A imagem final usa Node 22, roda com o usuário `node` e inclui o código, as telas, os ícones, as fontes e os scripts de consulta à FLW. |
| `compose.yaml` | Define o único serviço, a porta local, a pasta de dados, a rotação de logs e o reinício após reboot. Dá à aplicação 35 segundos para encerrar. |
| `.dockerignore` | Limita o contexto de build ao código necessário. Credenciais, banco local, arquivos de contatos e `node_modules` do Windows ficam fora da imagem. |
| `.env` | Fornece usuário, senha, segredo de sessão, token FLW e opções da integração quando o contêiner é criado. |
| `./data/` | Pasta persistente da VPS. Contém o SQLite com contatos, listas, campanhas e sessões, inclusive após recriar o contêiner. |

#### 1. Preparar a VPS

Instale Docker Engine com o plugin Compose. Copie o projeto para uma pasta da VPS e execute os comandos abaixo **dentro dessa pasta**. Use SSH/SFTP para transferir seu `.env`. Se preferir gerar uma configuração nova, rode `npm run setup` em uma cópia local do projeto sem `.env`, edite o arquivo gerado e transfira-o.

Confira `ADMIN_USERNAME`, `ADMIN_PASSWORD` e `SESSION_SECRET` (mínimo de 32 caracteres). A aplicação rejeita a senha de exemplo em produção. Preencha `FLW_API_TOKEN` para habilitar a integração. Se uma senha contiver um cifrão, use aspas simples ao redor do valor no `.env` para o Compose preservá-lo. Para callbacks, configure também `PUBLIC_URL` com o domínio HTTPS e `WEBHOOK_SECRET`.

O Nginx encaminha para `127.0.0.1:3038` na VPS. O Docker publica essa porta e encaminha para a porta 3000 interna do painel. Se o `.env` da VPS já definir `TOTALK_HOST_PORT`, use `TOTALK_HOST_PORT=3038` para coincidir com o Nginx.

Para migrar os cadastros do computador, encerre primeiro o painel local e transfira a pasta `data` inteira para a VPS antes da primeira inicialização. Uma pasta vazia cria um banco novo. Em uma VPS Linux com Docker convencional, o usuário `node` da imagem usa UID e GID 1000. Prepare a pasta para esse usuário gravar:

```bash
chmod 600 .env
sudo install -d -m 700 -o 1000 -g 1000 ./data
sudo chown -R 1000:1000 ./data
docker compose up -d --build
docker compose ps
```

O primeiro `up` baixa a base, instala as dependências e inicia o painel em segundo plano. Em `ps`, o serviço deve passar de `starting` para `healthy`. Essa verificação consulta apenas `/health` no Express. Para investigar um serviço que reinicia ou fica `unhealthy`, use `docker compose logs --tail=80 painel`.

#### 2. Adicionar o painel ao Nginx existente

O arquivo [deploy/nginx/totalk.conf](deploy/nginx/totalk.conf) usa `totalk.testes-techcode.shop` para o painel, as rotas `/api/` e os callbacks da FLW. Aponte o registro DNS A de `totalk` para o IPv4 da VPS. Se usar IPv6, configure também o registro AAAA e o `listen [::]:80;` nesse bloco, conforme os demais sites. A emissão com Certbot usa a porta pública 80 e o painel usa a 443. [Como o Nginx seleciona o site](https://nginx.org/en/docs/http/request_processing.html)

**Copiar e editar.** Em Debian/Ubuntu com `sites-enabled`, execute na pasta do projeto:

```bash
sudo cp -n deploy/nginx/totalk.conf /etc/nginx/sites-available/totalk.conf
sudo nano /etc/nginx/sites-available/totalk.conf
```

O primeiro comando copia o arquivo apenas se o destino for novo. Se você já instalou uma cópia anterior, ajuste `server_name` para `totalk.testes-techcode.shop` no arquivo da VPS. Na linha `proxy_pass`, use a porta escolhida no primeiro passo. Salve com Ctrl+O, Enter e saia com Ctrl+X.

**Ativar.** O primeiro comando cria o link que habilita o site e só precisa ser feito na primeira instalação. O segundo valida a configuração do Nginx e aplica por recarga se a validação passar. Se aparecer `conflicting server name`, confira qual site já usa o subdomínio antes de prosseguir.

```bash
sudo ln -s /etc/nginx/sites-available/totalk.conf /etc/nginx/sites-enabled/totalk.conf
sudo nginx -t && sudo systemctl reload nginx
```

Se os sites atuais usam `/etc/nginx/conf.d/*.conf`, copie com `sudo cp -n deploy/nginx/totalk.conf /etc/nginx/conf.d/totalk.conf`, edite essa cópia e faça a validação e a recarga. Nesse layout o próprio arquivo já habilita o site. Escolha apenas o diretório incluído pela instalação da VPS.

**Ativar HTTPS.** Com o subdomínio apontando para a VPS e o plugin Nginx do Certbot instalado, execute o comando abaixo. Ele solicita o certificado, instala o HTTPS e configura o redirecionamento. Se a VPS já tem um certificado que cobre o subdomínio e usa outro gerenciador, aplique a configuração TLS desse gerenciador ao bloco do Totalk. [Guia oficial do Certbot](https://eff-certbot.readthedocs.io/en/stable/using.html#nginx)

```bash
sudo certbot --nginx --redirect -d totalk.testes-techcode.shop
```

Abra `https://totalk.testes-techcode.shop/login` e use as credenciais do `.env`. A proteção de sessão exige HTTPS. Antes de configurar o certificado, o site responde 403 em HTTP por esse motivo. O Nginx se comunica com o Docker pelo endereço local e informa o protocolo ao Express, que roda com `TRUST_PROXY=true`.

#### 3. Atualizar e guardar os dados

Depois de transferir alterações de código, execute `docker compose up -d --build` na mesma pasta. Para aplicar apenas uma alteração no `.env`, use `docker compose up -d --force-recreate painel`. Ao reiniciar, campanhas que estavam em andamento ficam pausadas para revisão.

Para um backup com o banco fechado, rode estes comandos na pasta do projeto, entre campanhas. O arquivo inclui o diretório inteiro do SQLite.

```bash
umask 077
docker compose stop painel
sudo tar -czf - ./data > "totalk-data-$(date +%Y%m%d-%H%M%S).tar.gz"
docker compose start painel
```

Guarde a cópia e o `.env` em local privado fora da VPS. Para restaurar em uma instalação nova, extraia a cópia na pasta do projeto com o serviço parado, ajuste o proprietário de `./data` conforme o primeiro passo e inicie o serviço.

### Sem Docker

Configure uma senha forte, `NODE_ENV=production`, HTTPS no proxy reverso e os segredos do `.env`. A senha inicial de exemplo é rejeitada em produção. Se houver exatamente um proxy confiável na frente, use `TRUST_PROXY=true` para os cookies seguros e limite de login funcionarem corretamente. Configure `HOST=0.0.0.0` apenas quando precisar receber conexões externas ou do proxy em outra interface.

O cookie de sessão dura oito horas. Banco e sessões ficam em `data/totalk.sqlite`. Faça backup com o servidor parado ou com a API de backup SQLite; em WAL, copiar só o arquivo principal durante execução pode perder dados recentes. Preserve esse diretório entre deploys. O token, `.env`, banco e logs estão ignorados pelo Git.

Para escalar para múltiplas instâncias, substitua a fila local por um worker com locks distribuídos e use um banco compartilhado. A integração real deve ser validada com o token e um destinatário autorizado antes de operar campanhas maiores.
