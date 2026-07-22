import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

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

/** Métricas do RUNTIME (9.2) — publicadas pelo worker a cada tick. */
export interface RuntimeMetrics {
  registry: Registry;
  outboxDepth: Gauge<'tenant'>;
  jobsAvailable: Gauge<'tenant'>;
  timersLate: Gauge<'tenant'>;
  incidentsOpen: Gauge<'tenant'>;
  effectsDispatched: Counter<'tenant'>;
  effectsDeadLettered: Counter<'tenant'>;
  timersFired: Counter<'tenant'>;
}

export function createRuntimeMetrics(): RuntimeMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const gauge = (name: string, help: string) =>
    new Gauge({ name, help, labelNames: ['tenant'] as const, registers: [registry] });
  const counter = (name: string, help: string) =>
    new Counter({ name, help, labelNames: ['tenant'] as const, registers: [registry] });
  return {
    registry,
    outboxDepth: gauge('runtime_outbox_depth', 'Efeitos pendentes na outbox'),
    jobsAvailable: gauge('runtime_jobs_available', 'Jobs aguardando lock'),
    timersLate: gauge('runtime_timers_late', 'Timers vencidos ha mais de 1min ainda armados'),
    incidentsOpen: gauge('runtime_incidents_open', 'Incidentes abertos'),
    effectsDispatched: counter('runtime_effects_dispatched_total', 'Efeitos aplicados pelo dispatcher'),
    effectsDeadLettered: counter('runtime_effects_dead_lettered_total', 'Efeitos em dead-letter'),
    timersFired: counter('runtime_timers_fired_total', 'Timers disparados'),
  };
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
