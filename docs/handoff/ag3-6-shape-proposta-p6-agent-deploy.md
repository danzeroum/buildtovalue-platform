# AG-3.6 — Proposta de shape (dev → triagem do dono) · P6 (deploy de agente)

> **Rito:** proposta de shape (este doc) → **triagem do dono [GATE]** → código. Par de:
> `docs/handoff/ADENDO-02-agentes-squads.md` (P6 aprovado como v1: "mesma UI de rejeição da
> tela 04; remediação em linguagem de negócio"), levantamento AG-3.6. O dono já decidiu: a
> ponte `?load=` do Squad Studio NÃO entra aqui enquanto P3 estiver pausado.

## 0 · O que já existe vs. o que falta (achado da investigação)

CLAUDE.md registra P6 como "completo" — isso é **só meio verdade**. Há DUAS superfícies de
deploy no sistema, e só uma delas está de pé:

- **Lint de PROCESSO (D19)**: completo, ponta a ponta. `registry/lint.ts` já cobre
  `EXEC_AGENT_GATE_MISSING`/`EXEC_TOOL_EFFECT_UNGATED`; `POST /v1/process-definitions` recusa
  com 422+issues; `POST /v1/process-definitions/lint` faz dry-run; `PublishModal`
  (`apps/console/src/routes/studio.tsx:62-199`) é a "tela 04" de rejeição — separa
  erro/aviso, bloqueia publish em erro, mostra remediação. **Nada muda aqui.**
- **Deploy do GRAFO de agente**: `deployAgentDefinition` (`packages/db/src/registry/agentStore.ts:67-91`)
  já roda `validateGraph` (lib) + `lintAgentGraphExecution` (host, ex.
  `EXEC_AGENT_LLM_CHAIN_UNSUPPORTED`) e recusa com `{ok:false, issues}` sem gravar nada em erro
  — **mas não tem rota HTTP nenhuma**. `listAgentDefinitions` também existe e também não tem
  rota. Só são exercitados por teste de banco (`packages/db/tests/agent-registry.test.ts` e
  afins). Zero UI.

Ou seja: a VALIDAÇÃO já está pronta e testada — o que falta é só o fio até `/v1` e uma tela
que chame essa rota. Isso é rota nova (`/v1` novo) → **exige este gate**, mesmo a lógica de
baixo já existindo.

## 1 · Rotas propostas (mesmo padrão de `process-definitions`)

```ts
// packages/db/src/registry/store.ts — PlatformRegistry ganha 3 métodos, mesmo padrão dos de processo:
deployAgent(tenantId, input: { graph: AgentWorkflow; createdBy?: string }): Promise<DeployAgentOutcome>;
lintAgent(graph: AgentWorkflow): ValidationIssue[]; // validateGraph + lintAgentGraphExecution, sem gravar
listAgents(tenantId): Promise<Omit<AgentDefinitionRow, 'graph'>[]>; // já existe como função solta — só falta o fio
```

```ts
// apps/api/src/routes/definitions.ts (mesmo arquivo dos process-definitions — família igual)
app.post('/v1/agent-definitions', {
  preHandler: [app.authenticate, app.requirePermission('definitions:deploy')], // reaproveita, sem permissão nova (§3)
  schema: {
    body: z.object({ graph: z.record(z.string(), z.unknown()) }),
    response: {
      201: agentDefinitionSummarySchema.extend({ warnings: z.array(lintIssueSchema) }),
      422: problemSchema.extend({ issues: z.array(lintIssueSchema) }),
    },
  },
}, async (req, reply) => {
  const outcome = await registry.deployAgent(req.auth!.tenantId, {
    graph: req.body.graph as unknown as AgentWorkflow, createdBy: req.auth!.sub,
  });
  if (!outcome.ok) return problem(reply, 422, PROBLEM_TYPES.validation, 'Grafo de agente rejeitado', String(req.id), { issues: outcome.issues });
  reply.status(201);
  return { id: outcome.definition.id, agentId: outcome.definition.agent_id, version: outcome.definition.version,
    ref: outcome.definition.ref, name: outcome.definition.name, autonomyLevel: outcome.definition.autonomy_level,
    createdAt: String(outcome.definition.created_at), warnings: outcome.warnings };
});

app.post('/v1/agent-definitions/lint', {
  preHandler: [app.authenticate, app.requirePermission('definitions:deploy')],
  schema: { body: z.object({ graph: z.record(z.string(), z.unknown()) }), response: { 200: z.object({ issues: z.array(lintIssueSchema) }) } },
}, async (req) => ({ issues: registry.lintAgent(req.body.graph as unknown as AgentWorkflow) }));

app.get('/v1/agent-definitions', {
  preHandler: [app.authenticate, app.requirePermission('definitions:read')],
  schema: { response: { 200: z.object({ items: z.array(agentDefinitionSummarySchema) }) } },
}, async (req) => ({ items: await registry.listAgents(req.auth!.tenantId) }));
```

## 2 · RBAC — reaproveita, sem permissão nova (a menos que o dono prefira separar)

Proposta: `definitions:deploy`/`definitions:read` (as MESMAS do process-definitions) — o
papel que hoje publica processos BPMN (`analyst`, `admin`) é o mesmo que publicaria grafos de
agente; nenhuma linha de `rbac.ts` muda. **Alternativa a confirmar**: se o dono quiser um
controle mais fino (ex.: nem todo `analyst` deveria publicar AGENTES, só processos), caberia
uma permissão nova `agents:deploy`/`agents:read` — mas isso é decisão de granularidade de
RBAC, não uma necessidade técnica. Sinalizo e aguardo a escolha.

## 3 · Fora deste shape (decisão do dono já registrada)

- **A ponte `?load=<versionId>` do Squad Studio** (ADENDO-02) fica de fora enquanto P3 estiver
  pausado — ela é superfície de SQUAD (ler um grafo pronto num editor visual), não de deploy.
  Sem P3, não há "Squad Studio" para carregar `?load=` nele.
- **Nenhuma tela de console nova nesta fatia.** Sem P3, não há consumidor de UI óbvio para
  `POST /v1/agent-definitions` v1 — a rota fica pronta para ser chamada externamente (pela lib
  `bpmn`/AG-1, ou por uma ferramenta de linha de comando) até que uma tela precise dela.
  **Pergunta para confirmar**: tudo bem publicar a rota SEM nenhuma UI de console em v1 (API
  pura, como o resto do produto às vezes expõe capacidade antes da tela — ex. `/v1/audit/export`
  em CSV também não tem uma tela dedicada além do A7), ou o dono quer pelo menos uma tela
  mínima de "colar o JSON do grafo e ver o resultado do lint" (um `PublishModal` sem editor
  visual nenhum, só o dry-run + deploy) mesmo sem P3?

## 4 · Ordem de código (quando o gate abrir)

1. `PlatformRegistry` ganha `deployAgent`/`lintAgent`/`listAgents` (`registry/store.ts`).
2. `apps/api/src/routes/definitions.ts`: as três rotas (§1).
3. `packages/api-contracts`: schemas de request/response (`agentDefinitionSummarySchema` etc.).
4. SDK regen (console) — mesmo que nenhuma tela use ainda, o contrato fica público e
   type-safe para quem consumir.
5. (Se o dono pedir a tela mínima do §3) uma versão sem editor visual do `PublishModal`,
   reaproveitando o MESMO componente/voz de rejeição do studio.tsx.
6. Testes: e2e HTTP (deploy válido 201, grafo com erro 422+issues, lint dry-run sem gravar,
   list); nenhum teste de banco muda (a lógica de baixo já está coberta).
