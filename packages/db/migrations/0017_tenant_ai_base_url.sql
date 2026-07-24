-- AG-2.5 (agnóstico de provedor) — base_url por tenant.
--
-- O adaptador `openai-compatible` (DeepSeek/Groq/Together/OpenRouter/local) muda
-- só base_url + model; a chave segue como ponteiro secret:// (NUNCA no banco).
-- Coluna NULLABLE de propósito: não quebra linhas existentes (o path `anthropic`
-- nativo usa host fixo no adaptador). A OBRIGATORIEDADE para `openai-compatible`
-- é imposta no CÓDIGO — na ESCRITA (upsert) e no uso — validada como https://,
-- sem default silencioso apontando para o provedor errado (decisão do dono).
ALTER TABLE tenant_ai_config ADD COLUMN base_url text;

COMMENT ON COLUMN tenant_ai_config.base_url IS
  'Base URL do provedor para o adaptador openai-compatible (ex. https://api.deepseek.com; o adaptador anexa /chat/completions). Obrigatória p/ openai-compatible, ignorada p/ anthropic — imposto em código na escrita e no uso.';
