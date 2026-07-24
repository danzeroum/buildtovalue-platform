# Runbook — ensaio do agente com PROVIDER REAL (AG-2.5)

O ensaio exercita, ponta a ponta, um `agentTask` executado com **chave REAL** da
Anthropic (backend `secret://` de arquivo), medindo **custo REAL** (usage da API ×
tabela de preço versionada). É o ensaio que destrava o provider real **sem** cofre
gerenciado — deixando claro que **cofre gerenciado é requisito do GATE, não do
ensaio** (§4).

> **O CI NUNCA roda isto.** O provider real recusa `NODE_ENV=test`/`VITEST`/`CI`
> e recusa chave placeholder (`createRealAiProvider`, guardas duras). O interior
> do `agentTask` não é reproduzível (D27) — o CI usa fixtures, custo zero.

---

## 1. O que o ensaio demonstra

1. **Execução real** — um `agentTask` (grafo governado pelo registry) caminha com
   o `realWalker`: cada nó `llm` alcançado chama a Anthropic de verdade; a saída
   real roteia a decisão a jusante.
2. **Custo real, honesto** — o custo vem do **usage real** × `ANTHROPIC_PRICE_TABLE`
   (centavos de BRL). A trilha grava **qual versão** da tabela calculou. Modelo
   fora da tabela → **parada honesta** (`price-missing`), nunca zero.
3. **Budget real** — o custo REAL acumulado (não a projeção do `CostModel`) barra
   a próxima chamada ao estourar `budget_cents/100`.
4. **Paradas honestas** — falha/timeout/rate-limit do provider → `provider-unavailable`
   (âmbar, **sem retry**); kill-switch entre passos → parada honesta com trilha
   parcial. O operador **retoma** pelo caminho de resume (§5.2 do ADENDO-02).
5. **REPROVAR o gate** (negativo) — humano recusa a proposta do agente → o efeito
   **não executa** → a instância roteia pela **aresta de reprovação** definida.
   (Comportamento já coberto por `packages/db/tests/agent-gate-e2e.test.ts`.)

**Fora do ensaio:** staleness de tool; multi-hop de prompt (saída de um `llm`
alimentando o *prompt* do próximo — ver §5, limitação declarada).

---

## 2. Formato do segredo — o que colocar no arquivo (para o dono)

Backend de **arquivo** (`SECRET_BACKEND=file`), diretório `SECRET_DIR`
(default do compose: `/run/secrets/btv`). A referência que vai no banco é um
**ponteiro**, nunca a chave.

| campo | valor |
|---|---|
| **Caminho do arquivo** | `${SECRET_DIR}/tenants/<slug>/ai-key` — ex. `/run/secrets/btv/tenants/acme/ai-key` |
| **Conteúdo do arquivo** | a chave REAL `sk-ant-…`, **uma linha** (o `\n` final é aparado). Nada mais no arquivo. |
| **Permissão** | `chmod 600` (o resolvedor **recusa** permissão frouxa — fail-closed) |
| **`tenant_ai_config.key_ref`** | `secret://tenants/<slug>/ai-key` (o mesmo caminho, com o esquema `secret://`) |
| **`tenant_ai_config.provider`** | `anthropic` |
| **`tenant_ai_config.model`** | um modelo **precificado**: `claude-opus-4-8`, `claude-sonnet-5` ou `claude-haiku-4-5-20251001` |

```bash
# na VPS, como o usuário do worker:
umask 077
mkdir -p /run/secrets/btv/tenants/acme
printf '%s' 'sk-ant-...SUA-CHAVE-REAL...' > /run/secrets/btv/tenants/acme/ai-key
chmod 600 /run/secrets/btv/tenants/acme/ai-key
```

> A chave **nunca** entra no Postgres nem em log/trilha (D29). O worker resolve o
> ponteiro no runtime. Uma chave de **exemplo** (`sk-ant-xyz`, `…your-key…`, curta
> demais) é **recusada** pela guarda — o ensaio não sobe com placeholder.

---

## 3. Rodar o ensaio

Pré: ambiente da VPS de pé (`deploy-vps.md`), tenant semeado, agente publicado no
registry, segredo posto (§2), `tenant_ai_config` apontando o `key_ref`/`model`.

```bash
# worker sobe com o backend de arquivo:
#   SECRET_BACKEND=file  SECRET_DIR=/run/secrets/btv   (já no docker-compose.yml)
docker compose up -d worker
# inicie a instância que dispara o agentTask (pelo Console ou via API /v1).
```

O worker locka o job `agent`, injeta `createRealWalker({ provider: createRealAiProvider(...) })`
e caminha o grafo. No **Operate**, o drill-down mostra a timeline unificada
(humano + agente), o **custo real** por chamada e a **versão da tabela** que o
calculou. Numa parada honesta, o card fica **âmbar** com a saída honesta — nunca
vermelho (§5).

**Ver a parada honesta de custo:** ponha `budget_cents` abaixo do custo esperado
de uma chamada → o walk para em `budget` após a 1ª chamada, trilha parcial
preservada.

**Ver o REPROVAR:** no gate da proposta, o humano **recusa** → o efeito não roda,
a instância segue à rota de reprovação (aresta `decisao = "reprovar"`).

---

## 4. O que o ensaio satisfaz do Gate 8.4 — e o que NÃO

**Satisfaz / exercita de verdade:**
- Provider real por trás da interface `AiProvider` (troca de provedor não toca o walker).
- Custo real medido e **auditável** contra a versão da tabela (nada de estimativa).
- Paradas honestas reais (provider/preço/budget/kill-switch) — âmbar, retomáveis.
- Segredo **fora do banco**, resolvido no runtime, fail-closed.

**NÃO satisfaz (é do GATE, não do ensaio):**
- **Cofre gerenciado (Vault/KMS)** — aqui é backend de **arquivo** local. A interface
  `secret://` é a mesma; troca-se o backend sem tocar o resto. *(Gate 8.4)*
- **KMS na cifra de campos** — `FIELD_KEY_SECRET` segue estático (D20). *(Gate 8.4)*
- **WAL imutável / PITR** — ancoragem continua `self-recorded`. *(Gate 8.4)*
- **Câmbio USD→BRL "ao vivo"** — a tabela pina o câmbio na `version`; não há cotação
  em runtime (honesto por construção: o número histórico não escorrega).

---

## 5. Limitação declarada — multi-hop de prompt (AG-4)

O `agentflow` **não** ship execução real: `AgentRunner.run?` é **opcional e
ABSENTE** por construção (cerca §0 — sem rede/SDK/credencial), e `simulate` é um
replay de fixtures que **nunca monta prompt nem chama provider**. Por isso o
`realWalker` é uma peça do **host**: ele resolve, **um nó `llm` por vez na ordem de
visita**, chamando o provider e re-simulando com a saída real (a decisão a jusante
passa a rotear sobre dados reais).

O que a v1 **não** faz: costurar a **saída de um `llm` dentro do *prompt* de outro
`llm`** (o `resolvePrompt` monta o prompt do nó a partir do `promptRef`/Library,
não do output corrente de nós anteriores). Para o ensaio isso basta — o grafo do
ensaio é um `llm` alimentando uma **decisão**, não uma cadeia de `llm`s. O
**executor passo-a-passo com estado costurado** (prompt do nó N vê a saída de N-1)
é o motor real da **AG-4**; o seam (`AgentWalker`) já está pronto para recebê-lo
sem tocar o `runAgentJob`.
