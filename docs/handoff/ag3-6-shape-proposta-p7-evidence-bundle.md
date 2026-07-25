# AG-3.6 — Proposta de shape (dev → triagem do dono) · P7 (Evidence Bundle no Operate)

> **Rito:** proposta de shape (este doc) → **triagem do dono [GATE]** → código. Par de:
> `docs/handoff/ADENDO-02-agentes-squads.md` (P7 aprovado como v1: "card + selo de ancoragem,
> sem formato de hash novo — cadeia do core"), levantamento AG-3.6 (achados P6/P7/P3 em chat).
> Decisão do dono já fechada nesta triagem: rota fina sob `operate:read` (não dar
> `audit:export` ao operador) — este shape só formaliza o desenho, não reabre a escolha.

## 0 · O que já existe (nada novo aqui é reinventado)

- **Digest + âncora + recibo**: `exportAudit`/`AuditReceipt` (`packages/db/src/audit/export.ts:72-91,308-365`)
  já produz `digest` (sha256 canônico), `anchorRef`, `assurance: 'self-recorded'` +
  `assuranceNote`, e `coverage` (fronteira ancorada por trilha + `unanchoredCount`) — filtrável
  por `resourceType`/`resourceId`, então escopar a UM instance já funciona mecanicamente hoje
  (`export.ts:227,273`).
- **O componente do card já existe e já roda em produção**: `ReceiptCard` +
  `CoverageSection` (`apps/console/src/routes/Administration.tsx:113-`), usando `EvidenceSeal`
  (`packages/shared-ui/src/selo.tsx`, estado `ancoravel` — nunca "verificado", D30). É
  literalmente o card que o P7 pede ("hash + link"); hoje só aparece na tela A7 (tenant-wide,
  admin/auditor).
- **O que falta**: nada disso é alcançável por quem vive no drill-down do Operate — `GET
  /v1/audit/export` exige `audit:export` (`packages/auth/src/rbac.ts:98-109`), que `operator`
  não tem. `apps/console/src/routes/operate.tsx` (`HistoryTab`, linha 738-832) nunca importa
  `EvidenceSeal` nem renderiza digest algum.

## 1 · Decisão do dono (fechada nesta triagem): rota fina sob `operate:read`

Em vez de conceder `audit:export` ao `operator` (o que abriria a trilha INTEIRA do tenant —
privilégio maior do que o necessário), uma rota nova devolve **só o bundle da instância que o
operador já pode ver** — reaproveita `exportAudit` internamente com filtros TRAVADOS
(`resourceType:'instance', resourceId: <id>, source:'instance'`), ignorando qualquer outro
filtro do corpo/query. Menor privilégio: o operador vê a evidência da própria instância, nunca
a trilha de outra.

```ts
// apps/api/src/routes/operate.ts (ou runtime.ts — onde os outros GET /v1/instances/:id/* vivem)
app.get(
  '/v1/instances/:id/evidence-bundle',
  {
    preHandler: [app.authenticate, app.requirePermission('operate:read')],
    schema: {
      tags: ['operate'],
      summary: 'Recibo de evidência (digest + âncora + cobertura) escopado a UMA instância',
      params: z.object({ id: z.string().uuid() }),
      response: { 200: auditExportResponseSchema, 401: problemSchema, 403: problemSchema },
    },
  },
  async (req) => {
    const { records, receipt } = await runtime.audit.export(
      req.auth!.tenantId,
      { resourceType: 'instance', resourceId: req.params.id, source: 'instance' }, // TRAVADO
      { type: 'user', id: req.auth!.sub, requestId: String(req.id) },
    );
    return { receipt, records };
  },
);
```

Como `exportAudit` já grava `audit.export` na trilha de tenant a cada chamada (auto-auditoria
existente, `export.ts:335-343`), a nova rota herda isso de graça — cada visualização do bundle
por um operador fica, ela mesma, auditada.

## 2 · UI — onde o card entra no Operate

Proposta: reaproveitar `ReceiptCard`/`CoverageSection` (hoje locais a `Administration.tsx`)
extraindo-os para um lugar compartilhável (`shared-ui` ou um módulo do console reusado pelas
duas telas — decisão de organização de código, não de design), e renderizar o card **dentro
da aba "history" já existente** de `InstanceDetailPane` (não uma aba nova) — o bundle é sobre
a MESMA história que a aba já mostra, então uma seção compacta no topo (hash + selo +
cobertura, sem a lista de registros — isso já está na timeline abaixo) parece o encaixe mais
natural. **Pergunta para confirmar**: aba nova "Evidência" ou seção dentro de "Histórico"?

A MESMA lição do A7, inegociável aqui também: o card mostra `assurance: 'self-recorded'` e a
frase "Não há notarização externa" — nunca dá a entender que há mais garantia do que existe.
G-UX-3 confere isso antes do merge, como no A7.

## 3 · RBAC — sem permissão nova

Reaproveita `operate:read` (já concedida a `operator`/`auditor`/`admin`). Nenhuma linha em
`packages/auth/src/rbac.ts` muda.

## 4 · Fora deste shape

Agregação de "bundle de UMA corrida de agente" como objeto de primeira classe (distinto de um
export genérico filtrado) — não existe hoje e não é preciso para o P7 v1 (o filtro por
`resourceId=instanceId` já entrega o que uma instância precisa). Fica para quando P3/squads
precisarem de um bundle multi-agente de verdade.

## 5 · Ordem de código (quando o gate abrir)

1. Extrair `ReceiptCard`/`CoverageSection` para um módulo compartilhável (ou aceitar duplicação
   pequena, se a extração for mais trabalho do que vale — decisão do dev, não do gate).
2. `apps/api/src/routes/operate.ts`: rota nova `GET /v1/instances/:id/evidence-bundle`.
3. `apps/console/src/routes/operate.tsx`: seção do bundle na aba escolhida (§2).
4. Testes: e2e HTTP (operador vê SÓ a própria instância; 403 fora de `operate:read`; o filtro
   não vaza outras instâncias mesmo que o corpo tente sobrescrever); componente (o card nunca
   promete notarização externa); a11y (G-UX-1/G-UX-3 de sempre).
