-- Migração 0016 — ledger de ancoragem periódica de digest (AG-2.4, D35).
-- [GATE+MIGRAÇÃO]. Forward-only.
--
-- Substitui o hash encadeado POR LINHA (rejeitado no ADENDO-03 §5.13: serializa
-- escritas, duplica o ledger) por ancoragem PERIÓDICA de digest de intervalo. O
-- caminho de APPEND nunca é tocado — um job assíncrono (worker) ancora intervalos
-- JÁ FECHADOS. A cadeia é de ÂNCORAS, não de linhas: só o job é serial, fora do
-- caminho quente.
--
-- MARCA D'ÁGUA POR SNAPSHOT (não heurística de tempo): cada linha carrega o xid8
-- da transação que a inseriu (`pg_current_xact_id()`); o job ancora SÓ linhas com
-- `xid < pg_snapshot_xmin(pg_current_snapshot())` — abaixo dessa marca TODA
-- transação está DECIDIDA (commit/abort), então o intervalo em espaço-de-xid é
-- FECHADO POR CONSTRUÇÃO: nenhuma linha pode chegar tarde nele. (Isso também
-- resolve a auto-referência: o txn do próprio job tem xid >= a marca, então o
-- evento de auditoria dele sempre cai num intervalo POSTERIOR.)
--
-- A âncora guarda os DOIS sistemas de coordenadas: `[from_xid, to_xid)` E
-- `[min_created_at, max_created_at]` — sem os limites de TEMPO o export (que
-- filtra por tempo) não se localiza na cobertura ancorada, e recibo↔âncora não
-- compõem para o auditor.
--
-- CUSTO DA MIGRAÇÃO (honesto): `pg_current_xact_id()` é VOLATILE → o
-- `ADD COLUMN ... DEFAULT` NÃO usa o fast-path de default constante: REESCREVE a
-- tabela inteira sob `ACCESS EXCLUSIVE`. Indolor AGORA (trilhas do piloto
-- vazias/pequenas). COM VOLUME, seria operação de JANELA: `ADD COLUMN xid xid8`
-- (nullable, instantâneo) → backfill em lotes → `ALTER ... SET DEFAULT` →
-- `SET NOT NULL` via `NOT VALID`+`VALIDATE`. Linhas PRÉ-EXISTENTES (se houvesse)
-- recebem o **xid8 desta transação de migração** — ou seja, todas cairiam no
-- MESMO primeiro intervalo de ancoragem (aceitável: são anteriores ao ledger; a
-- garantia de integridade começa daqui).

ALTER TABLE history_events     ADD COLUMN xid xid8 NOT NULL DEFAULT pg_current_xact_id();
ALTER TABLE tenant_audit_events ADD COLUMN xid xid8 NOT NULL DEFAULT pg_current_xact_id();

-- O job varre por (tenant, xid); a verificação re-lê por intervalo de xid.
CREATE INDEX history_events_xid_idx      ON history_events (tenant_id, xid);
CREATE INDEX tenant_audit_events_xid_idx ON tenant_audit_events (tenant_id, xid);

-- Ledger de âncoras: uma linha por intervalo ancorado, por trilha. Append-only
-- por PERMISSÃO (como as trilhas): app_api só SELECT+INSERT — a âncora, uma vez
-- gravada, não muda.
CREATE TABLE audit_anchors (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  trail              text NOT NULL CHECK (trail IN ('tenant', 'instance')),
  from_xid           xid8 NOT NULL,
  to_xid             xid8 NOT NULL,
  min_created_at     timestamptz,          -- limites de TEMPO das linhas contidas
  max_created_at     timestamptz,          -- (compõem com o filtro temporal do export)
  row_count          integer NOT NULL,
  algorithm          text NOT NULL DEFAULT 'sha256',
  digest             text NOT NULL,        -- sha256(prev_anchor_digest || canonical(linhas))
  prev_anchor_digest text,                 -- cadeia de ÂNCORAS (null na primeira)
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_anchors_trail_idx ON audit_anchors (tenant_id, trail, to_xid);

ALTER TABLE audit_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_anchors FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_anchors_tenant_isolation ON audit_anchors
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only: SELECT + INSERT, jamais UPDATE/DELETE (par das trilhas na 0006).
GRANT SELECT, INSERT ON audit_anchors TO app_api;
