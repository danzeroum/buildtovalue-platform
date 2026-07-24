import type { paths } from './generated/schema.js';

/**
 * Atalhos de tipo AMARRADOS ao SDK gerado do OpenAPI: se uma rota mudar de
 * forma, estes tipos quebram a compilação do console — o contrato é a fonte,
 * não uma cópia à mão.
 */
type JsonOf<R> = R extends { content: { 'application/json': infer T } } ? T : never;

export type Get200<P extends keyof paths> = paths[P] extends {
  get: { responses: infer R };
}
  ? R extends { 200: infer Resp }
    ? JsonOf<Resp>
    : never
  : never;

export type Post200<P extends keyof paths> = paths[P] extends {
  post: { responses: infer R };
}
  ? R extends { 200: infer Resp }
    ? JsonOf<Resp>
    : never
  : never;

export type TaskItem = Get200<'/v1/user-tasks'>['items'][number];
export type TaskDetail = Get200<'/v1/user-tasks/{id}'>;
export type FormDefByRef = Get200<'/v1/form-definitions/{ref}'>;
export type ProcessItem = Get200<'/v1/process-definitions'>['items'][number];
export type StartableItem = Get200<'/v1/startable-definitions'>['items'][number];

export type InstanceItem = Get200<'/v1/instances'>['items'][number];
export type InstanceDetail = Get200<'/v1/instances/{id}'>;
export type VariableView = Get200<'/v1/instances/{id}/variables'>['items'][number];
export type HistoryEvent = Get200<'/v1/instances/{id}/history'>['items'][number];
export type Incident = Get200<'/v1/incidents'>['items'][number];
export type Job = Get200<'/v1/jobs'>['items'][number];
export type Timer = Get200<'/v1/timers'>['items'][number];
export type ProcessDetail = Get200<'/v1/process-definitions/{idOrRef}'>;

// AG-3.2 (P4 — kill-switch). GET e POST de /v1/ai/kill-switch devolvem o MESMO
// shape (o FATO, nível 1 — nunca a razão); a config (nível 2) é rota separada.
export type KillSwitchState = Get200<'/v1/ai/kill-switch'>;
export type AiConfig = Get200<'/v1/ai/config'>;
