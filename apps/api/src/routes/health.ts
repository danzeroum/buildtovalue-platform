import type { FastifyInstance } from 'fastify';
import type { PlatformMetrics } from '@platform/observability';
import type { ApiDeps } from '../app.js';

/** Liveness, readiness e métricas Prometheus (fora do /v1 — são operacionais). */
export function registerHealthRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  metrics: PlatformMetrics,
): void {
  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));

  app.get('/ready', { schema: { hide: true } }, async (_req, reply) => {
    const dbOk = await deps.dbReady().catch(() => false);
    if (!dbOk) return reply.status(503).send({ status: 'degraded', db: false });
    return { status: 'ready', db: true };
  });

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
