# Relatório — Fase 2: Runtime confiável

> **Data de fechamento:** 2026-07-22 · **Tag:** `phase-2` (sobre `08c1c05`)
> **Status:** ACEITA pelo dono em 22/07 — condicionantes da triagem
> cumpridos na PR #8 (fechamento).
>
> **Errata (22/07, registrada a pedido da triagem):** este relatório saiu na
> PR #7 citando `POST /v1/instances/:id/cancel` na tabela de aceite. O
> contrato foi corrigido na **PR #8** para o sub-recurso
> `POST /v1/instances/{id}/cancellation` com `reason` OBRIGATÓRIO fluindo
> para `history_events` (ADENDO-01 §2.3). A tabela abaixo já reflete o
> contrato corrigido; o arquivo de teste mantém o nome
> `cancel.e2e.test.ts`. Histórico fiel > histórico reescrito.

## Aceite da fase (plano v1.2 §F2) — item a item

| Critério | Evidência |
|---|---|
| **Processo exemplo fim-a-fim** (user task + service task + timer boundary + XOR) | `example@1` embutido no registro: `packages/db/tests/runtime-f2.test.ts` executa as TRÊS rotas — aprovada (submission roteia o XOR no MESMO avanço → job http-call → completed), timeout (varredura dispara o boundary interruptivo → task some → job send-email → completed) e rejeitada (default do XOR). Cancelamento pelo contrato público em `apps/api/tests/cancel.e2e.test.ts`. |
| **Crash/fencing verdes** | Crash test das 100 instâncias (F1.8) intacto e agora gravando história REAL; crash no meio do lote com as tabelas novas (`runtime-f2.test.ts`): re-dispatch sem duplicar história/incidente (seq determinístico). Fencing D12 de jobs pelo contrato público (lease re-tomada → token velho 409; conclusão dupla 409). **Nota honesta:** fencing formal de USER TASK usa `claim_token` (D21) e chega com a API de tasklist na F3 — na F2 a conclusão dupla de task é rejeitada pelo engine (staleWait). |
| **Cancelamento fecha esperas** | `POST /v1/instances/:id/cancellation` (sub-recurso, motivo OBRIGATÓRIO → history_events, ADENDO-01 §2.3) → engine emite CloseUserTask/CancelTimer/CancelJob para TODAS as esperas; teste comprova: task some (`cancelled`), timer não dispara (varredura ignora), segundo cancel = 409. |
| **Métricas expostas** | Worker publica `/metrics` (porta própria): gauges `runtime_outbox_depth`, `runtime_jobs_available`, `runtime_timers_late` (>1min), `runtime_incidents_open` por tenant + counters de dispatch/dead-letter/timers (9.2). Fotografia via `runtimeDepths` testada. |
| **Sequências 1 e 2 documentadas** | `docs/architecture/sequencias.md` (caminho feliz; crash/retomada + timer boundary + fencing + dead-letter). |
| **ADRs aprovados** | ADR-0001 (aprovado, condições a–d) e ADR-0002 (aprovado 22/07 com exigência de materialização — cumprida abaixo). |

## Itens 1–8 do plano §F2

1. **Serviço de avanço**: tx única FOR UPDATE → StateMigrator ENCADEADO
   (D14; "antiga demais" → INCIDENTE `stateSchemaTooOld` com dedupe —
   testado; "do futuro" → abort de deploy, nunca incidente de processo —
   testado) → advance → revision otimista → outbox mesma tx → `pg_notify`
   no commit. Big-O documentado no código (O(1) queries + O(efeitos)).
2. **Dispatcher**: LISTEN em conexão DEDICADA (cliente próprio max 1);
   SKIP LOCKED O(1) amortizado; polling dinâmico 100ms/1s→fallback 60s;
   idempotência por effect_key; SAVEPOINT por linha + backoff 2^n s;
   dead-letter → `incidents` (`effectDispatchFailed`).
3. **Jobs**: lock/lease/lock_token (D12), handler FORA de tx via
   JobHandlerRegistry plugável (G-API-4): `http-call`, `send-email` (stub),
   `webhook` (HMAC opcional), `noop`; tipo desconhecido FALHA o job;
   conclusão SEMPRE por `POST /v1/jobs/{id}/complete|fail` (D22) com
   `result` persistido como variável (D13).
4. **Timers**: varredura `fire_at <= agora` (índice `timers_due_idx`) com o
   relógio INJETADO do host (D2); marcação `fired` na MESMA tx do avanço.
5. **Histórico**: `seq` monotônico por instância = `(revision,
   effect_index)`, determinístico sob re-dispatch + UNIQUE(effect_key)
   (G-DAD-2). **Entregável NOMEADO cumprido: teste "ledger nunca contém
   conteúdo pessoal"** (`packages/db/tests/lgpd-seam.test.ts`) — CPF
   (sensitive) e e-mail (personal) atravessam o fluxo inteiro e a varredura
   integral de history_events + incidents + outbox + state FALHA se
   qualquer valor aparecer em claro.
6. **Costura LGPD**: `KeyProvider` (D20) com provedor dev/CI
   (`FIELD_KEY_SECRET`; produção = KMS na F5 — chave estática reprova o
   gate 8.4); FieldCipher AES-256-GCM com IV por registro; `sensitive`
   persiste CIFRADA e SEM KeyProvider a tx ABORTA (nunca plaintext
   silencioso); `personal` em claro com classificação marcada (alvo da
   anonimização, ADR-0002). Redaction do pino ampliada
   (payload/submission/result) com teste LEAK-FAIL.
7. **ADR-0002**: aprovado; salt-por-registro para hashes de conteúdo entra
   junto da integração do ledger real (`@buildtovalue/audit`, V1 §8.3) —
   nenhum hash de conteúdo é gravado na F2.
8. **Crash + fencing formais**: cobertos acima (job); user task formal na
   F3 com claim (D21).

## Métricas SMART (9.4)

- 100 instâncias sem efeito duplicado: verde (herdado e re-validado com
  história real).
- p95 advance: instrumentação pronta (histogramas + gauges); medição de
  carga fica para o runbook de demo da F3.
- Zero vazamentos de tenant: suíte permanente agora cobre as 11 tabelas.

## Decisões de autonomia desta fase

Registradas em `pendencias.md` §2 itens 6–9 (avaliador de condição v1,
`example@1` embutido, relógio da varredura, fórmula do seq) — validáveis a
qualquer momento; nada bloqueia.
