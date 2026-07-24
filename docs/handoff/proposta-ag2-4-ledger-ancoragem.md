# AG-2.4 — ledger real + ancoragem periódica de digest (D35)

**Estado: APROVADO (triagem do dono) e IMPLEMENTADO.** Este doc é o desenho aprovado,
com as três adições da triagem dobradas. Substitui o hash encadeado por linha (rejeitado
no ADENDO-03 §5.13 — serializa escritas) por **ancoragem periódica de digest**.

## Q1 — ancorar o digest de intervalo SEM serializar as escritas

O caminho de **append** nunca é tocado. Um **job assíncrono** (worker, sweep espaçado,
default 5 min, `WORKER_ANCHOR_INTERVAL_MS`) ancora intervalos JÁ FECHADOS. Single-flight
por `pg_try_advisory_xact_lock` (outro worker apenas pula).

**Marca d'água por SNAPSHOT (não heurística de tempo).** Cada linha das trilhas carrega o
xid8 da transação que a inseriu (`xid xid8 DEFAULT pg_current_xact_id()`, migração 0016). O
job ancora só linhas com **`xid < pg_snapshot_xmin(pg_current_snapshot())`**: abaixo dessa
marca TODA transação está DECIDIDA, então o intervalo em espaço-de-xid é **fechado por
construção** — nenhuma linha pode chegar tarde nele (a opção b, detector de chegada tardia,
ficou desnecessária). A cadeia é de **ÂNCORAS**, não de linhas: `digest = sha256(prev_anchor_digest || canonical(linhas))`.

**Auto-referência resolvida de graça:** o txn do próprio job tem `xid ≥ marca`, então o
evento `audit.anchor.created` sempre cai num intervalo POSTERIOR — nunca no que ele ancora
(mesma disciplina dos meta-eventos do export, agora automática, provada em teste).

## Q2 — a verificação aponta o intervalo adulterado

`verifyAnchors(tenant, trail)` recomputa o digest de CADA intervalo e a ligação `prev`.
Divergência retorna o `[from_xid, to_xid)` + os limites de tempo + a razão
(`digest`/`chain`/`row-count`). Adulterar UMA linha → falha no intervalo dela (aceite
ADENDO-03 §3, provado em `audit-anchor.test.ts`).

## As três adições da triagem (dobradas)

1. **Âncora carrega os DOIS sistemas de coordenadas** — além de `[from_xid, to_xid)`,
   grava `[min_created_at, max_created_at]` das linhas contidas. Sem os limites de tempo o
   export (que filtra por tempo) não se localiza na cobertura ancorada; com eles, recibo↔âncora
   compõem.
2. **O recibo do export DECLARA a fronteira** — `receipt.coverage`: `perTrail` (throughXid +
   throughTime por trilha) + `unanchoredCount` + nota. "N linha(s) deste export ainda NÃO
   ancorada(s)". Garantia se declara, não se infere — vale já com `self-recorded`, e evita
   afirmar cobertura falsa quando virar `externally-anchored`.
3. **Migração honesta sobre o custo** — `pg_current_xact_id()` é VOLATILE → o `ADD COLUMN
   DEFAULT` reescreve a tabela sob `ACCESS EXCLUSIVE`. Indolor agora (trilhas vazias); com
   volume seria operação de janela (add nullable → backfill em lotes → set default → not
   null). Linhas pré-existentes receberiam o xid8 da migração (mesmo primeiro intervalo).
   Documentado na própria 0016.

## Métrica / alerta

`runtime_anchor_lag_rows{tenant,trail}` — linhas commitadas ainda não ancoradas. Job parado
= afirmação de ancoragem apodrecendo sem ninguém ver → o alerta é sobre este gauge.

## Artefatos

- Migração `0016_audit_anchors.sql` (xid nas trilhas + `audit_anchors` append-only, RLS).
- `packages/db/src/audit/anchor.ts` (`anchorTrailOnce`/`verifyAnchors`/`anchorLag`/`anchorFrontier`).
- `packages/db/src/audit/canonical.ts` (canonicalização compartilhada, sem ciclo).
- `export.ts` recibo com `coverage`; contrato `auditReceiptSchema` idem.
- Worker: sweep de ancoragem + métrica.
- Aceite: `packages/db/tests/audit-anchor.test.ts` (dois sistemas, boundary exclusiva,
  adulteração aponta o intervalo, cadeia, cobertura no recibo, auto-referência).

## Fronteira honesta (o que a AG-2.4 NÃO promove sozinha)

O `assurance` continua **`self-recorded`**: o digest é auto-registrado pela plataforma. A
promoção a **`externally-anchored`** (D30) exige o **WAL imutável / notarização** (§C da
auditoria do Gate 8.4) — quando a infra existir, a âncora aponta para um substrato que não
se reescreve, e AÍ o rótulo vale.
