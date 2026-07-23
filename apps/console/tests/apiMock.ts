import { type Mock } from 'vitest';
import { api } from '../src/api/client.js';

/**
 * Despachante de dublê do SDK: as rotas do console chamam `api.GET('/v1/…')`
 * com o path-TEMPLATE literal (o openapi-fetch substitui os params por dentro,
 * mas aqui o `api` é dublê e recebe o template). Roteamos por «MÉTODO path».
 */
export type Resp = { data?: unknown; error?: unknown; response: Response };

export function ok(data: unknown, status = 200): Resp {
  return { data, error: undefined, response: new Response(null, { status }) };
}
export function fail(status: number, body: unknown = {}): Resp {
  return { data: undefined, error: body, response: new Response(null, { status }) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (opts: any) => Resp | Promise<Resp>;
const handlers: Record<string, Handler> = {};

export function route(key: string, handler: Handler): void {
  handlers[key] = handler;
}

/** Liga as implementações do dublê e limpa as rotas — chame em beforeEach. */
export function resetRoutes(): void {
  for (const k of Object.keys(handlers)) delete handlers[k];
  for (const m of ['GET', 'POST', 'DELETE', 'PATCH'] as const) {
    (api[m] as unknown as Mock).mockImplementation((path: string, opts: unknown) => {
      const h = handlers[`${m} ${path}`];
      return Promise.resolve(h ? h(opts) : fail(404, { title: `sem mock: ${m} ${path}` }));
    });
  }
}
