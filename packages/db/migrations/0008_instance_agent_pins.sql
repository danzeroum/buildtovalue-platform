-- Migração 0008 — pin operacional do agentTask (AG-2.2 etapa 4 [GATE + MIGRAÇÃO]).
-- Forward-only.
--
-- ESTADO OPERACIONAL, não auditoria. O `agent:pinResolved` em history_events é
-- EVIDÊNCIA (append-only, D32) — ninguém EXECUTA a partir dela. Ler a trilha para
-- despachar conflacaria auditoria com estado (a mesma linha que D13 state×variables
-- e D32 trilha-imutável traçam); e a string do `kind` é APRESENTAÇÃO (a etapa 3
-- renomeou agentPinResolved→agent:pinResolved) — o despacho não pode depender dela.
--
-- Esta tabela é a fonte OPERACIONAL do pin: gravada na MESMA TX do start (junto do
-- recordAgentPinsAtStart) e lida no despacho do CreateJob(agent) para substituir a
-- ref DECLARADA (possivelmente flutuante) pela ref EFETIVA. Guarda os DOIS — o
-- auditor precisa ver "declarou @latest, rodou @1.2.0".
CREATE TABLE instance_agent_pins (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  instance_id   uuid NOT NULL REFERENCES instances(id),
  element_id    text NOT NULL,
  declared_ref  text NOT NULL,
  effective_ref text NOT NULL,
  resolved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, instance_id, element_id)
);

-- RLS em TUDO, sempre (D7) — padrão NULLIF.
ALTER TABLE instance_agent_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_agent_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY instance_agent_pins_tenant_isolation ON instance_agent_pins
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Pin resolvido UMA vez no start é IMUTÁVEL (nunca re-resolve): SELECT+INSERT.
-- Sem UPDATE/DELETE — o despacho lê, jamais reescreve.
GRANT SELECT, INSERT ON instance_agent_pins TO app_api;
