# Briefing — Agentes e Squads de IA no Console BuildToValue

> **Para:** Designer oficial da plataforma BuildToValue
> **Assunto:** Nova frente de protótipos — agentes/squads viram CRITÉRIO DE LANÇAMENTO da v1
> **Data:** 2026-07-22
> **O que se espera:** protótipos das superfícies de plataforma (§5), parecer sobre a
> fatia v1 (§7) e propostas de inovação (§6). Depois do parecer: ADENDO-02 → desenvolvedor.

---

## 1. A decisão e o porquê

O dono definiu: **a v1 só lança com agentes de IA e squads contemplados** — diferencial
principal frente a Camunda/BAW e o tema mais quente do BPM em 2026. A biblioteca
`danzeroum/bpmn` está muito mais pronta nesse tema do que os relatórios registravam. O
trabalho não é inventar do zero — é dar ao que existe o seu RUNTIME e as suas telas de
operação.

## 2. O que a biblioteca JÁ TEM (inventário verificado)

**`@buildtovalue/agentflow` (A-1..A-7, ~1.900 linhas, zero deps, no npm):** modelo de
agente com exatamente 3 tipos de nó (`llm`/`tool`/`decision`) + decoradores
(`memory`/`planner`/`errorBoundary`); escala normativa de autonomia 0–5 com a regra
"autonomia ≤ 3 exige gate humano no BPMN antes do efeito"; validação de grafo com códigos
estáveis e proibição de métrica implícita (`confidence` proibido); simulação mock
determinística com paradas honestas (`BlockedDecision`); ToolContract versionado com a
tripla **efeito × autorização × evidência**; interop LangGraph (subset documentado);
templates prontos.

**No core/react:** o elemento BPMN `agentTask` com a regra autonomia→gate; o **Agent
Studio** implementado; a ponte de escalação assinada; o `copilot` ("IA rascunha, humanos
assinam" — provider sempre injetado pelo host, zero SDK/chave no repo).

**Handoff 22 (Squad Lane):** espec frontend completa de agentes e squads, com **9
protótipos hi-fi já desenhados** (01 catálogo de tools · 02 budget · 03 contrato do
delegate · 04 inspector+problemas · 05 validador de cobertura · 06 Squad Studio · 07
simulação+Evidence Bundle · 08 ponte BPMN · 09 prontidão). Status: espec pronta, NÃO
implementada.

## 3. A fronteira biblioteca × plataforma

O H22 é frontend-only: nenhuma chamada de rede, credencial, SDK ou runtime. Toda execução
real fica atrás de três interfaces injetáveis — `ToolProvider`, `AgentRunner`,
`ExecutionStore`. **A plataforma É esse host**, e o encaixe é quase perfeito com o runtime
já construído:

| Conceito da biblioteca | Encaixe no runtime da plataforma |
|---|---|
| `AgentRunner` real | Handler `agent` no `JobHandlerRegistry` (D4r) — lease, fencing, retry, dead-letter, auditoria de graça |
| Gate humano (autonomia→gate) | User task com formulário — fluxo de aprovação da Tasklist (D21) |
| Parada honesta / `BlockedDecision` | Incidente tipado no Operate (retry/resolve) |
| Trilha de fatos | `history_events` com `seq` determinístico + export XES |
| Evidence Bundle + hash | Ledger (`canonicalJson` + ancoragem — mesma da F3) |
| `AIProvider` injetado | Config por tenant com chave em secret manager (KeyProvider é o precedente) |
| Regras de validação | Lint D19 no deploy — mesmos códigos, mesma UI de rejeição da tela 04 |
| Budget governado | Enforcement no runtime + métricas |

O diferencial não exige runtime novo — exige **telas de operação** sobre o runtime já
provado, mais a implementação do H22 na biblioteca.

## 4. Princípios herdados que viram princípios DE DESIGN (vinculantes)

1. **"IA rascunha, humanos assinam"** — nenhuma superfície sugere que o agente aprova/promove/assina.
2. **Trilha de fatos, não "pensamento"** — intenção → ação/ferramenta → I/O mascarado → decisão/regra → evidência, com origem rotulada (`fixture` | `evidencia-declarada` | `evidencia-verificada`, este último exclusivo do runtime real).
3. **Paradas honestas são feature, não erro** — a UI nunca mascara `BlockedDecision` como falha genérica.
4. **Efeito classifica, permissão decide, evidência explica** — a tripla do ToolContract é o vocabulário visual (nunca só cor — traço+ícone+rótulo).
5. **Autonomia 0–5 como vocabulário de produto** — o nível aparece onde decisões são tomadas, sempre com a derivação.
6. **Estados derivados por código** — `readinessState()` é a única fonte do estado; proibido "pintar estado".

## 5. Superfícies DA PLATAFORMA a prototipar

- **P1 · Tarefa de gate (Tasklist)** — humano aprovando ação de agente com efeito
  `external-commitment`/`write-irreversible`: ação em linguagem de negócio, a tripla, o
  trecho da trilha, o escopo EXATO ("aprova ESTE envio, não a categoria"), budget, saídas
  aprovar/reprovar/escalar. A tela mais importante e a demo de venda.
- **P2 · Execução do agente no Operate (drill-down)** — token no `agentTask`; trilha real
  virtualizada, budget vivo, estado, `BlockedDecision` como incidente.
- **P3 · Squad em execução no Operate** — visão de colaboração (tela 06 do H22) com dados
  reais: quem está ativo, delegações em voo, autonomia da cadeia, ponto do gate humano.
- **P4 · Configuração de Inteligência do tenant** — `AIProvider`, chave via secret manager
  (NUNCA campo em claro), políticas de budget, kill-switch.
- **P5 · Catálogo de tools com governança de tenant** — catálogo (tela 01) + camada da
  plataforma: quais tools o tenant habilita, matriz efeito×autorização, trilha de quem habilitou.
- **P6 · Deploy com lint de agente** — `EFFECT_NEEDS_GATE`, `GATE_NOT_COVERING`,
  `AUTONOMY_CHAIN` na mesma UI de rejeição da tela 04, com remediação em linguagem de negócio.
- **P7 · Evidence Bundle ancorado (Operate/auditoria)** — card da tela 07 + selo de
  ancoragem no ledger real.

## 6. Onde INOVAR (convite explícito)

- **O gate como "contrato de confiança" visual**: a aprovação P1 mostrando um delta — "o
  que muda no mundo se você aprovar" — em vez de um diff técnico.
- **Autonomia como dial, não número**: o nível 0–5 como controle visual, com o gate
  aparecendo/sumindo no diagrama conforme o nível.
- **Timeline unificada humano+agente**: atos humanos e fatos de agente na MESMA linha do tempo.
- **"Paradas honestas" como momento de marca**: tratamento visual próprio (não o vermelho de erro).

## 7. Pragmatismo — a fatia v1 proposta

**Entra na v1:** implementação do H22 na biblioteca; na plataforma P1, P2, P4 e P6
completos; P5 mínima (habilitar/desabilitar tools por tenant); P7 card simples (hash +
link). **Squads:** modelagem completa (H22) + execução com um nível de delegação e P3 em
leitura. **Fica para F4:** P3 rico/animado, matriz de governança editável, delegação
multi-nível, políticas avançadas de budget, LangGraph import na UI.

Perguntas abertas (do designer): (a) P1 é tela própria ou "modo agente" do detalhe de
tarefa? (b) a trilha real cabe no drill-down do Operate ou pede rota própria? (c) o Squad
Studio entra no /studio via ponte (`?load=`) ou embutido? (d) o que da fatia v1 cortaria
ou acrescentaria?

## 8. Processo e artefatos

Parecer em três blocos: (1) por superfície P1–P7, (2) decisões da §7, (3) inovações. Com
ele: ADENDO-02 → dono aprova → desenvolvedor. Referências: `docs/design_handoff_btv_squad_lane/`,
`docs/design_handoff_btv_agentflow/`, `packages/agentflow/README.md`,
`packages/react/src/agent/`, protótipos do Console (01–06), PLANO v1.2 + ADENDO-01.
