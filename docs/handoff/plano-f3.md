# Plano de fase — F3 (MVP utilizável)

> Derivado do PLANO v1.2 §F3 + ADENDO-01 §6 + triagem da fase-2 (22/07).
> Este documento NOMEIA os compromissos que a triagem mandou registrar.

## Gate de entrada (política 3.2) — ANTES do SDK e de endpoints novos

**Proposta do shape completo da API /v1 do MVP para aprovação do dono**,
contendo já:
- `POST /v1/instances/{id}/cancellation` como está (sub-recurso, motivo
  obrigatório → history_events) — corrigido na PR de fechamento da F2;
- rota de deploy/lint D19 **implementando a issue platform#2**, com o
  catálogo de códigos incluindo `EXEC_BOUNDARY_HOST_NOT_WAITING`
  ("boundary só sobre atividade de espera");
- user-tasks com claim persistente (`claim_token`, D21) + reatribuição
  (D24) + estados 403/conflito de claim (ADENDO §2.2);
- `GET /v1/instances/{id}/variables` com `sensitive` MASCARADA por padrão e
  revelação auditada por RBAC (ADENDO §3 — vale para payload de user task);
- incidents (list/retry/resolve), cursor, Idempotency-Key, problem+json.

Nenhum endpoint novo é implementado antes da aprovação dessa proposta.

## Critérios que a triagem da F2 moveu para o ACEITE da F3 (nomeados)

1. **Fencing formal de user task com `claim_token` (D21)**: teste formal no
   estilo do crash test — claim, lease/registro persistente, conclusão com
   token errado = 409, revogação auditada por operador.
2. **Integração do ledger real (`@buildtovalue/audit`) + salt-por-registro
   (ADR-0002 item 3)**: dono = fluxo de **publish/promoção do registry**
   (F3.2) — hashes de conteúdo só com salt armazenado junto ao conteúdo;
   o teste nomeado "ledger nunca contém conteúdo pessoal" passa a varrer
   TAMBÉM a cadeia real, não só as tabelas do host.

## Escopo restante (plano v1.2 §F3, inalterado)

API MVP completa; /studio mínimo (deploy com lint D19 visível); /forms v1
(aviso "sensitive não buscável"); /tasks (claim/unclaim/formulário pinado/
validação no servidor); /operate mínimo (drill-down, incidentes, XES);
protótipos das 4 rotas antes (G-UX-3); axe serious = 0; e2e Playwright do
fluxo-alvo. Aceite: fluxo-alvo executável por não-desenvolvedor via runbook.
