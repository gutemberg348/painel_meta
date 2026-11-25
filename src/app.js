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
import { applyProviderStatus, now } from './services/campaigns.js';

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
      const eventId = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      db.prepare('INSERT OR IGNORE INTO webhook_events VALUES (?,?,?)').run(
        eventId,
        String(body.eventType || 'SEND_CALLBACK').slice(0, 100),
        now(),
      );
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
  app.get('/login', (req, res) =>
    req.session.authenticated ? res.redirect('/') : res.render('login', { error: null }),
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
  app.post('/login', loginLimit, (req, res, next) => {
    if (!equal(req.body.username, config.username) || !equal(req.body.password, config.password))
      return res.status(401).render('login', { error: 'Usuário ou senha incorretos.' });
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.authenticated = true;
      req.session.csrf = randomBytes(32).toString('hex');
      req.session.save((error) => (error ? next(error) : res.redirect('/')));
    });
  });
  app.use((req, res, next) => {
    if (req.session.authenticated) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Faça login para continuar.' });
    res.redirect('/login');
  });
  app.post('/logout', (req, res, next) =>
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('totalk.sid');
      res.redirect('/login');
    }),
  );
  app.use('/api', apiRouter(db, flw, campaigns, config));
  app.get('/', (req, res) => res.render('index', { username: config.username }));
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
