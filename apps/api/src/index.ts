import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

await server.register(cors, {
  origin: process.env.DASHBOARD_URL ?? 'http://localhost:3001',
});
await server.register(sensible);

server.get('/health', async () => {
  return { status: 'ok', timestamp: Date.now() };
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await server.listen({ port, host });
  server.log.info(`API server running at http://localhost:${port}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
