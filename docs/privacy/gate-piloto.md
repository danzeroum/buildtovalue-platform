# Gate de piloto (D17, plano §8.4) — checklist vivo de evidências

> BLOQUEANTE: nenhum piloto com cliente real antes de TODOS os itens
> evidenciados. Cada linha aponta a evidência quando existir; itens sem
> evidência ficam explícitos como PENDENTES.
>
> **Auditoria a/b/c dos 13 itens + necessidades de infra** (secret manager, KMS,
> WAL imutável — o que `KeyProvider`/`AIProvider` esperam):
> `docs/privacy/gate-piloto-auditoria.md`.

| # | Critério (plano §8.4) | Evidência / Estado |
|---|---|---|
| 1 | RLS com `SET LOCAL` testada; API sem BYPASSRLS; papel de migração separado | `packages/db/tests/rls-isolation.test.ts` (suíte permanente, 11 tabelas com FORCE RLS) — VERDE desde F1, ampliada na F2. |
| 2 | Redaction testada; TLS; secrets em secret manager; audit de dependências verde | Redaction leak-fail verde (`packages/observability/tests/redaction.test.ts`). TLS/secret manager/audit: PENDENTES (infra de piloto). |
| 3 | Backup automatizado + restore ensaiado e documentado | Ensaio de 2026-07-22 em `docs/runbooks/database.md`. Automação do backup: PENDENTE (infra de piloto). |
| 4 | Ledger sem dados pessoais (teste); criptografia ativa para `sensitive` com KeyProvider em secret manager/KMS — **chave estática REPROVA o gate** (D20) | Teste nomeado "ledger nunca contém conteúdo pessoal" VERDE (`packages/db/tests/lgpd-seam.test.ts`); cifra ativa (F2.6). KeyProvider de KMS: PENDENTE (hoje: provedor de ambiente dev/CI — reprova de propósito). |
| 5 | Plano de incidentes escrito + simulação executada e documentada (G-LGPD-4) | PENDENTE. |
| 6 | **Retorno do repo `buildtovalue-platform` a PRIVATE** — D1 revisado em 22/07: público de propósito até o fechamento da v1 (acesso direto de arquiteto/analistas); o retorno a Private é ITEM DO GATE. | PENDENTE (decisão do dono, 22/07 — registrada em `pendencias.md`). Verificação oficial: método externo (selo do cabeçalho/404 anônimo), executada pelo desenvolvedor e registrada aqui. |
