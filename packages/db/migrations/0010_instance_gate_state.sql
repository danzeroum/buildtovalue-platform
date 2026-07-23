-- Migração 0010 — estado OPERACIONAL do gate de tool (AG-2.2 etapa 5, D31/D28).
-- Forward-only.
--
-- Mesma disciplina do pin (0008): o que o runtime CONSULTA para decidir não vem
-- da trilha (auditoria ≠ execução, D13/D32). Aqui moram:
--  · `proposal_revision` — a revisão da instância quando a proposta abriu o gate.
--    Na aprovação, D28 re-verifica: se a revisão avançou, a proposta EXPIROU
--    (o world-delta pode não valer mais) → estado "proposta expirada", não efeito.
--  · `reproposal_count` — o CAP DURO por elemento (a decisão do dono na Q4:
--    reproposta é ação explícita + backstop de runaway; cada reproposta consome
--    budget, visível na trilha). Estourou o cap → parada honesta "reavaliação manual".
CREATE TABLE instance_gate_state (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  instance_id      uuid NOT NULL REFERENCES instances(id),
  element_id       text NOT NULL,
  proposal_revision integer NOT NULL,
  reproposal_count integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, instance_id, element_id)
);

ALTER TABLE instance_gate_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_gate_state FORCE ROW LEVEL SECURITY;
CREATE POLICY instance_gate_state_tenant_isolation ON instance_gate_state
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Estado MUTÁVEL (a reproposta atualiza contagem + revisão): SELECT+INSERT+UPDATE.
GRANT SELECT, INSERT, UPDATE ON instance_gate_state TO app_api;
