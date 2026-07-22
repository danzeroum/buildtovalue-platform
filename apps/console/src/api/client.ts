import createClient from 'openapi-fetch';
import type { paths } from './generated/schema.js';

/**
 * SDK tipado do console (F1.5): gerado do OpenAPI da API em CI
 * (`sdk:generate` → openapi-typescript). Disciplina do plano: um endpoint só
 * entra no console DEPOIS de estável no OpenAPI — este client não compila se
 * a rota não existir no contrato.
 */
export const api = createClient<paths>({ baseUrl: '/' });
