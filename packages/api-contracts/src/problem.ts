import { z } from 'zod';

/**
 * problem+json (RFC 9457) — o formato ÚNICO de erro do /v1 (G-API-1).
 * `type` é URI estável por classe de erro: clientes programam contra ela.
 */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
});
export type Problem = z.infer<typeof problemSchema>;

/** Catálogo v1 de tipos de problema (cresce por fase; URIs nunca mudam). */
export const PROBLEM_TYPES = {
  validation: 'https://buildtovalue.dev/problems/validation',
  unauthorized: 'https://buildtovalue.dev/problems/unauthorized',
  forbidden: 'https://buildtovalue.dev/problems/forbidden',
  notFound: 'https://buildtovalue.dev/problems/not-found',
  conflict: 'https://buildtovalue.dev/problems/conflict',
  rateLimited: 'https://buildtovalue.dev/problems/rate-limited',
  internal: 'https://buildtovalue.dev/problems/internal',
} as const;
