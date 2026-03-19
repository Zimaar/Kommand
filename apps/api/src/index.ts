import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { config } from './config/index.js';
import { AppError } from './utils/errors.js';
import { registerRequestLogger } from './middleware/request-logger.js';
import { registerRoutes } from './routes/index.js';
import { getScheduler } from './jobs/scheduler.js';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

// Plugins
await app.register(cors, { origin: config.DASHBOARD_URL });
await app.register(sensible);

// Request logger hook
registerRequestLogger(app);

// Error handler
app.setErrorHandler((error: FastifyError, _request, reply) => {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }

  if (error.statusCode === 400) {
    return reply.status(400).send({
      error: 'VALIDATION_ERROR',
      message: error.message,
    });
  }

  app.log.error(error);
  return reply.status(500).send({
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred',
  });
});

// Routes
await registerRoutes(app);

// ── Job scheduler ─────────────────────────────────────────────────────────────

const scheduler = getScheduler(config.REDIS_URL);

// Stub handlers — replaced with real logic in later M6 prompts
await scheduler.registerJob('morning_brief',    async () => { app.log.info('job: morning_brief'); });
await scheduler.registerJob('eod_summary',      async () => { app.log.info('job: eod_summary'); });
await scheduler.registerJob('stock_check',      async () => { app.log.info('job: stock_check'); });
await scheduler.registerJob('invoice_reminder', async () => { app.log.info('job: invoice_reminder'); });
await scheduler.registerJob('alert_check',      async () => { app.log.info('job: alert_check'); });

// Load DB-persisted schedules and start the worker
await scheduler.loadFromDb();
await scheduler.start();

app.log.info('Job scheduler started');

// ── Graceful shutdown ─────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down...`);
  await scheduler.close();
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start
try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
