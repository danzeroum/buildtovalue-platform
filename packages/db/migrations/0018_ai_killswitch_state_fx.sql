-- AG-3.2 (P4 — inteligência do tenant + kill-switch) — estado do kill-switch p/
-- o banner da Operação + câmbio por tenant.
--
-- BANNER (leitura em dois níveis, decisão do dono):
--   O banner de kill-switch vive na Operação INTEIRA (fora da Admin). O FATO da
--   pausa (quem/quando) é amplo; a RAZÃO é reservada ao admin. Estas colunas dão
--   ao banner uma leitura O(1) do "último estado" — a fonte de verdade continua
--   sendo `tenant_audit_events` (a trilha imutável). `kill_switch_reason` só é
--   PROJETADO pela rota admin; a rota ampla NUNCA o seleciona (reserva na
--   projeção, não só na coluna).
ALTER TABLE tenant_ai_config
  ADD COLUMN kill_switch_reason text,        -- NÍVEL 2 — só via GET /v1/ai/config (admin)
  ADD COLUMN kill_switch_by     text,        -- ator do último toggle (envelope D33) — nível 1
  ADD COLUMN kill_switch_at     timestamptz, -- desde quando — nível 1 (amplo)
  -- CÂMBIO POR TENANT (env → config, decisão do dono). Usado no MOMENTO do cálculo
  -- de custo; o resultado gravado carrega a taxa vigente (realWalker.fxRate, D30) —
  -- mudar a taxa NUNCA reescreve custo histórico. `null` → cai no default do
  -- sistema (env `FX_USD_BRL` vira piso, não fonte única).
  ADD COLUMN fx_usd_brl         numeric(10,4) CHECK (fx_usd_brl IS NULL OR fx_usd_brl > 0);

COMMENT ON COLUMN tenant_ai_config.kill_switch_reason IS
  'Razão do último toggle do kill-switch (pode conter contexto de incidente — dado reservado). Projetado SÓ pela rota admin (ai:read-config); a rota ampla (ai:read-state) nunca o seleciona.';
COMMENT ON COLUMN tenant_ai_config.fx_usd_brl IS
  'Câmbio USD→BRL por tenant p/ cálculo de custo (costOf fxRates). null → default do sistema. A taxa é aplicada no cálculo e o custo gravado é imutável (a taxa vigente vai na trilha, D30).';
