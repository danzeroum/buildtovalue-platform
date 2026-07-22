import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * Métricas Prometheus da plataforma (9.2 do plano). Na F1 nascem as básicas de
 * HTTP; as de runtime (profundidade da outbox, jobs/timers atrasados, p95/p99
 * de advance, incidentes) entram na F2 junto do dispatcher — os NOMES já ficam
 * reservados aqui para os dashboards não renomearem depois.
 */
export interface PlatformMetrics {
  registry: Registry;
  httpRequestDuration: Histogram<'method' | 'route' | 'status'>;
  httpRequestsTotal: Counter<'method' | 'route' | 'status'>;
}

export function createMetrics(): PlatformMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    httpRequestDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duração das requisições HTTP',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    httpRequestsTotal: new Counter({
      name: 'http_requests_total',
      help: 'Total de requisições HTTP',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
  };
}
