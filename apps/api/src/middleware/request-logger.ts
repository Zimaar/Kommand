import type { FastifyInstance } from 'fastify';

export function registerRequestLogger(app: FastifyInstance) {
  app.addHook('onResponse', async (request, reply) => {
    const duration = reply.elapsedTime;
    app.log.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      duration: Math.round(duration),
      userId: (request as { userId?: string }).userId ?? undefined,
    });
  });
}
