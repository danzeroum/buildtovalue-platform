import { writeFile } from 'node:fs/promises';
import type { PlatformRegistry, PlatformRuntime } from '@platform/db';
import { buildApp } from './app.js';
import { fakeDeps } from './testing/fakes.js';

/**
 * Emite openapi.json em build-time para o pipeline do SDK do console (F1.5):
 * endpoint só entra no console depois de estável no OpenAPI.
 *
 * As rotas de runtime/registry só se REGISTRAM se `deps.runtime`/
 * `deps.registry` existirem (DIP) — e os métodos NÃO são chamados na
 * emissão, só na execução real dos handlers. Sem estes stubs, o OpenAPI
 * emitido continha APENAS auth/me (as rotas de instances/definitions/
 * user-tasks/operate ficavam de fora e o SDK do console não as tipava). O
 * proxy que lança garante que qualquer chamada acidental durante o emit
 * falhe alto, em vez de gerar contrato falso.
 */
function emitStub<T extends object>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `${name}.${String(prop)} foi chamado durante a emissão de OpenAPI — o emit só REGISTRA rotas, nunca as executa`,
        );
      },
    },
  ) as T;
}

const app = await buildApp({
  ...fakeDeps(),
  runtime: emitStub<PlatformRuntime>('runtime'),
  registry: emitStub<PlatformRegistry>('registry'),
});
await app.ready();
const target = process.argv[2] ?? 'openapi.json';
await writeFile(target, JSON.stringify(app.swagger(), null, 2));
console.log(`OpenAPI emitido em ${target}`);
await app.close();
