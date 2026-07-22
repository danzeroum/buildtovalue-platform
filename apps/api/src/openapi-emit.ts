import { writeFile } from 'node:fs/promises';
import { buildApp } from './app.js';
import { fakeDeps } from './testing/fakes.js';

/**
 * Emite openapi.json em build-time para o pipeline do SDK do console (orval,
 * F1.5): endpoint só entra no console depois de estável no OpenAPI.
 */
const app = await buildApp(fakeDeps());
await app.ready();
const target = process.argv[2] ?? 'openapi.json';
await writeFile(target, JSON.stringify(app.swagger(), null, 2));
console.log(`OpenAPI emitido em ${target}`);
await app.close();
