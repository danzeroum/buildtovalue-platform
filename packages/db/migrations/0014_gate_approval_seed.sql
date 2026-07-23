-- Migração 0014 — semente do selo capturada na APROVAÇÃO do gate (AG-2.2 etapa 5
-- slice 3 item 3, D31). Forward-only.
--
-- O efeito roda DEPOIS do aval, por despacho normal — há um intervalo entre
-- aprovar e executar. Para o selo carregar QUEM aprovou e QUANDO até a execução
-- (e para a staleness ser verificada nesse intervalo), a aprovação grava a
-- semente no estado operacional do gate (instance_gate_state, 0010). NUNCA na
-- trilha (auditoria ≠ execução, D13/D32).
ALTER TABLE instance_gate_state ADD COLUMN approved_at    timestamptz;
ALTER TABLE instance_gate_state ADD COLUMN approved_actor jsonb;
