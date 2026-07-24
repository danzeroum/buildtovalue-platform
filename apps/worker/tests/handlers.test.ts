import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createHandlerRegistry, type JobContext } from '../src/handlers.js';

const job = (type: string, payload: Record<string, unknown> = {}): JobContext => ({
  jobId: 'j1',
  instanceId: 'i1',
  tenantId: 't1',
  type,
  payload,
});

/** fetch falso: devolve o status configurado e captura a chamada. */
function fakeFetch(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response('{}', { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('JobHandlerRegistry (F2.3, G-API-4)', () => {
  it('tipo sem handler FALHA explicitamente (nunca conclui silencioso)', async () => {
    const registry = createHandlerRegistry({ fetchImpl: fakeFetch().impl });
    const run = await registry.run(job('desconhecido'));
    expect(run).toMatchObject({ ok: false, error: expect.stringContaining('desconhecido') });
  });

  it('handler que LANÇA vira falha do job, não derruba o worker', async () => {
    const registry = createHandlerRegistry({ fetchImpl: fakeFetch().impl });
    registry.register('explode', async () => {
      throw new Error('boom');
    });
    const run = await registry.run(job('explode'));
    expect(run).toEqual({ ok: false, error: 'boom' });
  });

  it('http-call: POST no payload.url, 2xx conclui com httpStatus no result', async () => {
    const { impl, calls } = fakeFetch(201);
    const registry = createHandlerRegistry({ fetchImpl: impl });
    const run = await registry.run(job('http-call', { url: 'https://x.test/hook', body: { a: 1 } }));
    expect(run).toEqual({ ok: true, result: { httpStatus: 201 } });
    expect(calls[0].url).toBe('https://x.test/hook');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ a: 1 });
  });

  it('http-call: não-2xx e payload sem url falham (retries → incidente)', async () => {
    const registry = createHandlerRegistry({ fetchImpl: fakeFetch(500).impl });
    expect(await registry.run(job('http-call', { url: 'https://x.test' }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('500'),
    });
    expect(await registry.run(job('http-call'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('payload.url'),
    });
  });

  it('send-email é stub que conclui e registra a intenção SEM o destinatário (leak-fail 8.4)', async () => {
    const log = vi.fn();
    const registry = createHandlerRegistry({ fetchImpl: fakeFetch().impl, log });
    const run = await registry.run(job('send-email', { to: 'a@b.c' }));
    expect(run).toEqual({ ok: true, result: { emailStub: true } });
    // o destinatário é PII e NÃO vai ao log: registra só o sinal (hasRecipient).
    expect(log).toHaveBeenCalledWith('send-email (stub)', { jobId: 'j1', hasRecipient: true });
    const [, fields] = log.mock.calls[0];
    expect(JSON.stringify(fields)).not.toContain('a@b.c');
  });

  it('webhook: assina com HMAC-SHA256 quando payload.secret existe', async () => {
    const { impl, calls } = fakeFetch();
    const registry = createHandlerRegistry({ fetchImpl: impl });
    const run = await registry.run(
      job('webhook', { url: 'https://x.test/wh', data: { ping: true }, secret: 's3gr3d0' }),
    );
    expect(run).toMatchObject({ ok: true });
    const sent = calls[0];
    const body = sent.init.body as string;
    const headers = sent.init.headers as Record<string, string>;
    expect(JSON.parse(body)).toEqual({ instanceId: 'i1', jobId: 'j1', data: { ping: true } });
    expect(headers['x-btv-signature']).toBe(
      createHmac('sha256', 's3gr3d0').update(body).digest('hex'),
    );
  });
});
