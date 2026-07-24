import { createHmac } from 'node:crypto';

/**
 * JobHandlerRegistry (F2.3, G-API-4): handlers PLUGÁVEIS que rodam FORA de
 * qualquer transação (D22) — o worker executa o handler e conclui/falha pelo
 * CONTRATO PÚBLICO (POST /v1/jobs/{id}/complete|fail com lock_token). O
 * retorno ok carrega `result` (variáveis que o HOST persiste — D13).
 *
 * Handlers v1 do plano: http-call, send-email (stub), webhook — e o noop do
 * skeleton. Tipo sem handler registrado FALHA o job (retries → incidente
 * operacional), nunca conclui silenciosamente.
 */
export interface JobContext {
  jobId: string;
  instanceId: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
}

export type JobRunResult =
  | { ok: true; result?: Record<string, unknown> }
  | { ok: false; error: string }
  // PARADA HONESTA (§5): não é falha — estaciona o job sem incidente (budget/kill-switch).
  | { ok: false; honestStop: true; reason: string; kind: string };

export type JobHandler = (job: JobContext) => Promise<JobRunResult>;

export interface HandlerRegistry {
  register(type: string, handler: JobHandler): void;
  /** Executa o handler do tipo; tipo desconhecido = falha explícita. */
  run(job: JobContext): Promise<JobRunResult>;
}

export interface RegistryDeps {
  fetchImpl?: typeof fetch;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** timeout default das chamadas HTTP dos handlers (ms). */
  httpTimeoutMs?: number;
}

export function createHandlerRegistry(deps: RegistryDeps = {}): HandlerRegistry {
  const doFetch = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.httpTimeoutMs ?? 10_000;
  const handlers = new Map<string, JobHandler>();

  async function post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<JobRunResult> {
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status} de ${url}` };
      }
      return { ok: true, result: { httpStatus: response.status } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const registry: HandlerRegistry = {
    register(type, handler) {
      handlers.set(type, handler);
    },
    async run(job) {
      const handler = handlers.get(job.type);
      if (!handler) {
        return { ok: false, error: `nenhum handler registrado para o tipo '${job.type}'` };
      }
      try {
        return await handler(job);
      } catch (error) {
        // Handler que LANÇA vira falha do job (retries/incidente), nunca
        // derruba o loop do worker.
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  // ---- handlers v1 -------------------------------------------------------
  registry.register('noop', async () => ({ ok: true }));

  registry.register('http-call', async (job) => {
    const url = job.payload.url;
    if (typeof url !== 'string' || url.length === 0) {
      return { ok: false, error: 'http-call requer payload.url' };
    }
    return post(url, job.payload.body ?? {}, {});
  });

  registry.register('send-email', async (job) => {
    // Stub do plano (F2.3): provedor real entra pós-piloto; o job registra
    // a intenção e conclui — o fluxo não fica preso em infraestrutura.
    // O destinatário é PII (Art. 5 LGPD) e NUNCA vai em claro para o log —
    // ele vive no `payload` (redigido por inteiro). Loga só o jobId +
    // se há destinatário (sinal de ops sem o dado). (Gate 8.4: leak-fail de log.)
    log('send-email (stub)', { jobId: job.jobId, hasRecipient: Boolean(job.payload.to) });
    return { ok: true, result: { emailStub: true } };
  });

  registry.register('webhook', async (job) => {
    const url = job.payload.url;
    if (typeof url !== 'string' || url.length === 0) {
      return { ok: false, error: 'webhook requer payload.url' };
    }
    const body = {
      instanceId: job.instanceId,
      jobId: job.jobId,
      data: job.payload.data ?? {},
    };
    const headers: Record<string, string> = { 'x-btv-event': 'job' };
    const secret = job.payload.secret;
    if (typeof secret === 'string' && secret.length > 0) {
      headers['x-btv-signature'] = createHmac('sha256', secret)
        .update(JSON.stringify(body))
        .digest('hex');
    }
    return post(url, body, headers);
  });

  return registry;
}
