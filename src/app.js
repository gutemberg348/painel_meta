import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { ZodError } from 'zod';
import { SQLiteSessionStore } from './db.js';
import { apiRouter } from './routes/api.js';
import { usersRouter } from './routes/users.js';
import { verifyPassword, roleNames, landingPage, canUseApi } from './services/users.js';
import { applyProviderStatus, now } from './services/campaigns.js';
import { createInboxChannels } from './services/inbox-channels.js';
import { pushAvailable, pushRouter } from './services/push.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const equal = (a, b) =>
  timingSafeEqual(
    createHash('sha256')
      .update(String(a || ''))
      .digest(),
    createHash('sha256')
      .update(String(b || ''))
      .digest(),
  );

export function createApp({ config, db, flw, campaigns }) {
  const app = express();
  const inboxChannels = createInboxChannels(flw, config);
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', join(root, 'views'));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'font-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'upgrade-insecure-requests': config.production ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  app.use(express.static(join(root, 'public')));
  app.use('/vendor/icons', express.static(join(root, 'node_modules/lucide/dist/umd')));
  app.use('/vendor/fonts', express.static(join(root, 'node_modules/@fontsource/inter/files')));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.post(
    '/webhooks/flw/:secret',
    rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res) => {
      if (!config.webhookSecret || !equal(req.params.secret, config.webhookSecret))
        return res.sendStatus(401);
      const body = req.body;
      if (!body || typeof body !== 'object') return res.sendStatus(400);
      const content = body.content || body;
      // Validar o status diretamente na API evita confiar em conteúdo recebido externamente.
      const delivery =
        typeof content.id === 'string'
          ? db.prepare('SELECT id,provider_id FROM deliveries WHERE provider_id=?').get(content.id)
          : null;
      if (delivery) applyProviderStatus(db, delivery.id, await flw.messageStatus(delivery.provider_id));
      const received = body.eventType === 'MESSAGE_RECEIVED';
      const eventId = createHash('sha256').update(received && typeof content.id === 'string'
        ? 'MESSAGE_RECEIVED:' + content.id : JSON.stringify(body)).digest('hex');
      let notify = false;
      if (received && pushAvailable(config) && db.prepare('SELECT 1 FROM push_subscriptions LIMIT 1').get()
          && !db.prepare('SELECT 1 FROM webhook_events WHERE id=?').get(eventId)) {
        const channelId = content.channelId || (typeof content.sessionId === 'string' && (await flw.session(content.sessionId)).channelId);
        notify = typeof channelId === 'string' && (await inboxChannels()).some(c => c.id.toLowerCase() === channelId.toLowerCase());
      }
      db.transaction(() => {
        const inserted = db.prepare('INSERT OR IGNORE INTO webhook_events VALUES (?,?,?)')
          .run(eventId, String(body.eventType || 'SEND_CALLBACK').slice(0, 100), now());
        if (notify && inserted.changes) {
          db.prepare('UPDATE push_subscriptions SET pending_event=?, next_attempt=0, attempts=0').run(eventId);
        }
      })();
      db.prepare("INSERT OR REPLACE INTO metadata VALUES ('lastWebhook',?)").run(now());
      res.json({ received: true });
    },
  );
  app.use(
    session({
      name: 'totalk.sid',
      secret: config.sessionSecret,
      store: new SQLiteSessionStore(db),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: 8 * 60 * 60 * 1000 },
    }),
  );
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    req.session.csrf ||= randomBytes(32).toString('hex');
    res.locals.csrf = req.session.csrf;
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !equal(req.headers['x-csrf-token'] || req.body?._csrf, req.session.csrf)
    ) {
      return res.status(403).json({ error: 'Sessão de segurança expirada. Atualize a página.' });
    }
    next();
  });
  app.use((req, res, next) => {
    if (req.session.authenticated) {
      // Sessões emitidas antes das contas de equipe pertenciam ao único administrador.
      if (!req.session.accountId || req.session.accountId === 'manager') {
        res.locals.account = { username: config.username, role: 'manager' };
      } else {
        res.locals.account = db.prepare('SELECT username, role FROM staff_users WHERE id=? AND active=1 AND version=?')
          .get(req.session.accountId, req.session.accountVersion);
      }
    }
    next();
  });
  app.get('/login', (req, res) =>
    res.locals.account ? res.redirect('/') : res.render('login', { error: null }),
  );
  const loginLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).render('login', { error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' }),
  });
  app.post('/login', loginLimit, async (req, res, next) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256)
      return res.status(401).render('login', { error: 'Usuário ou senha incorretos.' });
    let account;
    if (equal(username, config.username) && equal(password, config.password)) {
      account = { id: 'manager', version: 1 };
    } else {
      const staff = db.prepare('SELECT id, version, password_hash, active FROM staff_users WHERE username=?').get(username);
      if (await verifyPassword(password, staff?.password_hash) && staff?.active && username.toLowerCase() !== config.username.toLowerCase()) account = staff;
    }
    if (!account) return res.status(401).render('login', { error: 'Usuário ou senha incorretos.' });
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.authenticated = true;
      req.session.accountId = account.id;
      req.session.accountVersion = account.version;
      req.session.csrf = randomBytes(32).toString('hex');
      req.session.save((error) => (error ? next(error) : res.redirect('/')));
    });
  });
  app.use((req, res, next) => {
    if (res.locals.account) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Faça login para continuar.' });
    res.redirect('/login');
  });
  app.post('/logout', (req, res, next) => {
    db.prepare('DELETE FROM push_subscriptions WHERE sid=?').run(req.sessionID);
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('totalk.sid');
      res.redirect('/login');
    });
  });
  app.use('/api', (req, res, next) => {
    if (canUseApi(res.locals.account.role, req.path)) return next();
    res.status(403).json({ error: 'Seu perfil não tem acesso a esta operação.' });
  });
  app.use('/api/users', usersRouter(db, config));
  app.use('/api/push', pushRouter(db, config));
  app.use('/api', apiRouter(db, flw, campaigns, config, inboxChannels));
  app.get('/', (req, res) => {
    const { username, role } = res.locals.account;
    res.render('index', { username, role, roleName: roleNames[role], homePage: landingPage[role],
      configured: Boolean(config.apiToken), inboxChannelId: config.inboxChannelId || '' });
  });
  app.use((req, res) => res.status(404).json({ error: 'Página não encontrada.' }));
  app.use((error, req, res, next) => {
    if (error instanceof ZodError)
      return res.status(400).json({ error: error.issues[0]?.message || 'Dados inválidos.' });
    const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    if (status === 500) console.error('Erro interno:', error.message);
    const message =
      status === 500 ? 'Não foi possível concluir a operação. Confira o servidor.' : error.message;
    res.status(status).json({ error: message });
  });
  return app;
}
