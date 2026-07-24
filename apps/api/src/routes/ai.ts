import { PROBLEM_TYPES, problemSchema } from '@platform/api-contracts';
import { hasPermission } from '@platform/auth';
import type { TenantAiConfig } from '@platform/db';
import type { FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps, ZodApp } from '../app.js';

/**
 * AG-3.2 (P4 — inteligência do tenant + kill-switch). Quatro superfícies com a
 * SEPARAÇÃO ler-estado × ler-config × acionar × configurar (RBAC), e a LEITURA EM
 * DOIS NÍVEIS: o FATO do kill-switch (quem/quando) é amplo — o banner vive na
 * Operação inteira; a RAZÃO é reservada a quem configura. A chave NUNCA sai em
 * nenhuma rota — `keyRef` é o ponteiro `secret://`, jamais o segredo (D29).
 *
 * G-UX-3 (marcação do banner): o `by` cru só carrega `{type,id}` — renderizar
 * "por admin" é o mesmo defeito do rótulo cru que a marcação apontou. Resolve-se
 * aqui o NOME DE EXIBIÇÃO (via UserRepository); `displayName: null` é o degrade
 * honesto (ator de outro tipo, ou usuário não encontrado) — o cliente decide a
 * voz (a marcação já cobre "nunca desconhecido": ela usa o id cru como último
 * recurso, nunca "desconhecido").
 */

type RawActor = { type: 'user' | 'system' | 'agent'; id: string } | null;

async function resolveActor(by: RawActor, tenantId: string, users: ApiDeps['users']) {
  if (!by) return null;
  if (by.type !== 'user') return { ...by, displayName: null as string | null };
  try {
    const u = await users.findById(tenantId, by.id);
    return { ...by, displayName: (u?.display_name as string | undefined) ?? null };
  } catch {
    // enriquecimento NUNCA pode derrubar o fato/config (ex.: id não-UUID —
    // token de teste sintético, ou usuário removido). Degrade honesto: sem nome.
    return { ...by, displayName: null as string | null };
  }
}

const actorSchema = z.object({
  type: z.enum(['user', 'system', 'agent']),
  id: z.string(),
  // resolvido no servidor (users.findById); null = não-usuário ou não encontrado.
  displayName: z.string().nullable(),
});

const killSwitchStateSchema = z.object({
  state: z.enum(['active', 'paused']),
  by: actorSchema.nullable(),
  since: z.string().nullable(),
});

const aiConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().nullable(),
  keyRef: z.string(), // PONTEIRO secret:// — nunca o segredo
  keyConfigured: z.boolean(),
  budgetCents: z.number().int().nullable(),
  fxUsdBrl: z.number().nullable(),
  killSwitch: killSwitchStateSchema.extend({ reason: z.string().nullable() }),
  updatedAt: z.string(),
});

function problem(reply: FastifyReply, status: number, type: string, title: string, requestId: string, detail?: string) {
  return reply
    .status(status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({ type, title, status, requestId, ...(detail ? { detail } : {}) });
}

/** Projeção da config para a rota. `keyRef` (ponteiro) sai; a CHAVE nunca. A
 *  RAZÃO do kill-switch (nível 2) só quando `canSeeReason` (quem tem ai:configure). */
async function projectConfig(cfg: TenantAiConfig, canSeeReason: boolean, tenantId: string, users: ApiDeps['users']) {
  const rawBy: RawActor = cfg.killSwitch && cfg.killSwitchBy ? { type: 'user', id: cfg.killSwitchBy } : null;
  return {
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    keyRef: cfg.keyRef, // ponteiro secret:// — a chave NUNCA sai
    keyConfigured: cfg.keyRef.startsWith('secret://'),
    budgetCents: cfg.budgetCents,
    fxUsdBrl: cfg.fxUsdBrl,
    killSwitch: {
      state: cfg.killSwitch ? ('paused' as const) : ('active' as const),
      by: await resolveActor(rawBy, tenantId, users),
      since: cfg.killSwitch ? cfg.killSwitchAt : null,
      reason: canSeeReason && cfg.killSwitch ? cfg.killSwitchReason : null,
    },
    updatedAt: cfg.updatedAt,
  };
}

export function registerAiRoutes(rawApp: ZodApp, deps: ApiDeps): void {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const runtime = deps.runtime;
  if (!runtime) return; // testes de auth puros não injetam runtime

  /** FATO (nível 1) com o `by` já resolvido para nome de exibição. */
  const factOf = async (tenantId: string) => {
    const state = await runtime.ai.killSwitchState(tenantId);
    return { ...state, by: await resolveActor(state.by, tenantId, deps.users) };
  };

  // ── 1.1 · LER o FATO do kill-switch — Operação inteira (banner) ──────────────
  // `ai:read-state` é AMPLO. NUNCA devolve a razão (nível 2, reservada) — a função
  // `killSwitchState` sequer a seleciona no SQL.
  app.get(
    '/v1/ai/kill-switch',
    {
      preHandler: [app.authenticate, app.requirePermission('ai:read-state')],
      schema: {
        tags: ['ai'],
        summary: 'Estado (FATO) do kill-switch — legível por toda a Operação (banner)',
        security: [{ bearerAuth: [] }],
        response: { 200: killSwitchStateSchema, 403: problemSchema },
      },
    },
    async (req) => factOf(req.auth!.tenantId),
  );

  // ── 1.3 · ACIONAR / RETOMAR — admin, motivo nas DUAS direções, auditado ──────
  app.post(
    '/v1/ai/kill-switch',
    {
      preHandler: [app.authenticate, app.requirePermission('ai:operate')],
      schema: {
        tags: ['ai'],
        summary: 'Aciona/retoma o kill-switch (motivo obrigatório nas duas direções; auditado)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          paused: z.boolean(),
          // motivo OBRIGATÓRIO pausando E retomando (não-vazio após trim).
          reason: z.string().trim().min(1, 'motivo é obrigatório (pausar e retomar)'),
        }),
        response: { 200: killSwitchStateSchema, 403: problemSchema, 404: problemSchema, 422: problemSchema },
      },
    },
    async (req, reply) => {
      const actor = { type: 'user' as const, id: req.auth!.sub, requestId: String(req.id) };
      try {
        await runtime.ai.setKillSwitch(req.auth!.tenantId, req.body.paused, actor, req.body.reason);
      } catch {
        // única falha esperada: sem config de IA para o tenant.
        return problem(reply, 404, PROBLEM_TYPES.notFound, 'Sem configuração de inteligência para este tenant', String(req.id));
      }
      // eco = FATO (sem a razão no corpo de volta); a razão fica p/ a rota admin.
      return factOf(req.auth!.tenantId);
    },
  );

  // ── 1.2 · LER config (razão nível-2 só p/ quem configura) — admin + auditor ──
  app.get(
    '/v1/ai/config',
    {
      preHandler: [app.authenticate, app.requirePermission('ai:read-config')],
      schema: {
        tags: ['ai'],
        summary: 'Config de inteligência (keyRef ponteiro; razão do kill-switch só p/ ai:configure)',
        security: [{ bearerAuth: [] }],
        response: { 200: aiConfigSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (req, reply) => {
      const cfg = await runtime.ai.config(req.auth!.tenantId);
      if (!cfg) return problem(reply, 404, PROBLEM_TYPES.notFound, 'Sem configuração de inteligência para este tenant', String(req.id));
      // NÍVEL 2: a razão só é PROJETADA a quem tem `ai:configure` (admin). Auditor
      // lê a config (evidência de binding) mas a razão vem null.
      return projectConfig(cfg, hasPermission(req.auth!.role, 'ai:configure'), req.auth!.tenantId, deps.users);
    },
  );

  // ── 1.4 · CONFIGURAR inteligência — admin, motivo, chave nunca volta ─────────
  app.put(
    '/v1/ai/config',
    {
      preHandler: [app.authenticate, app.requirePermission('ai:configure')],
      schema: {
        tags: ['ai'],
        summary: 'Cria/atualiza a config de inteligência (keyRef secret://; base_url validada; auditado)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          provider: z.string().min(1),
          model: z.string().min(1),
          baseUrl: z.string().url().nullable().optional(),
          keyRef: z.string().min(1),
          budgetCents: z.number().int().nonnegative().nullable().optional(),
          fxUsdBrl: z.number().positive().nullable().optional(),
          reason: z.string().trim().min(1, 'motivo é obrigatório'),
        }),
        response: { 200: aiConfigSchema, 403: problemSchema, 422: problemSchema },
      },
    },
    async (req, reply) => {
      const actor = { type: 'user' as const, id: req.auth!.sub, requestId: String(req.id) };
      try {
        await runtime.ai.configure(
          req.auth!.tenantId,
          {
            provider: req.body.provider,
            model: req.body.model,
            baseUrl: req.body.baseUrl ?? null,
            keyRef: req.body.keyRef,
            budgetCents: req.body.budgetCents ?? null,
            fxUsdBrl: req.body.fxUsdBrl ?? null,
          },
          actor,
        );
      } catch (err) {
        // validação de domínio (keyRef não-secret://, base_url ausente/malformada p/ openai-compatible).
        return problem(reply, 422, PROBLEM_TYPES.validation, 'Configuração inválida', String(req.id), (err as Error).message);
      }
      const cfg = await runtime.ai.config(req.auth!.tenantId);
      // quem chega aqui tem `ai:configure` (admin) → razão projetada.
      return projectConfig(cfg!, true, req.auth!.tenantId, deps.users);
    },
  );
}
