# BuildToValue — estado do design (contexto persistente)

Projeto: **Console + plataforma BuildToValue** (BPMS multi-tenant). Repos: `danzeroum/buildtovalue-platform` (produto, privado) e `danzeroum/bpmn` (biblioteca, Apache-2.0).
Papel do Claude aqui: **designer oficial da plataforma**. Rito de entrega: protótipos + parecer em três blocos, sinalizando **ESCOPO** o que muda comportamento (passa pelo plano, não direto ao dev).

## Identidade visual (vinculante — decisão C da F3)
Linguagem da biblioteca, promovida a `packages/shared-ui`. IBM Plex Sans/Mono + Source Serif 4.
Paleta: canvas `#e9e6dd` · shell `#f3f1ea`/borda `#d8d3c6` · branco `#fff`/borda `#e2ddd3` · verde `#1a6a54` (ok/read/ativo) tints `#e7f2ec`/`#f4faf6` · dourado `#9a7b1e` (write/gate/candidata) tints `#fdfaf1`/`#f6edd4` · vermelho `#b3372f` (irreversível/proibida) · violeta `#5b57b8` (squad/delegação) tint `#ecebf6` · escuro `#262220` (evidência/código) · texto `#262220`/`#44403a`/`#6f675a`.
Efeito: read=verde · write-reversible=dourado · external-commitment/irreversible=dourado+“exige gate” vermelho · proibida=vermelho. Sinais nunca só por cor (ícone+rótulo). Piso ~11px em metadados; axe serious = 0 nas telas novas.

## Frentes e estado
- **F3 (MVP BPMS)** — Console: /tasks /forms /operate + publicação no /studio + iniciar instância + estados não-ideais. Prototipado e aprovado.
  - **A** nav = nomes humanos (Tarefas · Formulários · Operação · Estúdio); rota literal na URL.
  - **B** delegação = reatribuição simples (pessoa + motivo auditado); “Delegar…” → “Reatribuir…” (D24).
  - **C** identidade = biblioteca → `shared-ui`.
- **F-AG (agentes & squads · ADENDO-02, critério de lançamento)** — superfícies de plataforma P1–P7 aprovadas.
  - v1: P1 gate (world-delta) · P2 execução/Operate (timeline unificada) · P4 inteligência do tenant (chave só via secret manager; kill-switch auditado) · P6 deploy+lint — completos; P5 catálogo mínimo; P7 Evidence Bundle card; P3 squad leitura.
  - Respostas: (a) P1 = modo da Tasklist, não rota; (b) trilha no drill-down do Operate; (c) Squad Studio por ponte `?load=`; (d) mantém a fatia + world-delta + kill-switch confirmado.
  - Assinaturas: gate como contrato de confiança · autonomia como dial · timeline unificada humano+agente · parada honesta em âmbar (não vermelho).
  - Invariante D27: interior do `agentTask` NÃO é determinístico — D6/replay não se aplica dentro dele.
- **Governança (Atlas · ADENDO-03, ISO 42001 / EU AI Act)** — E1–E6 aprovados.
  - Atlas por camada (banco→runtime→ledger→APIs→logs→trilhas→frontend) + jornada; E4 recibo; E5 negação(404/403)/retenção(tombstone).
  - **Assinatura: “selo de procedência”** = ator (humano·sistema·agente, envelope D33) + estado de evidência (auditado·ancorado-verificável·mascarado·negado). Vai para `shared-ui`.
  - Princípio-mãe: **evidência nunca é conteúdo**; `evidência-verificada` só do runtime real (D30); ledger nunca contém conteúdo pessoal.

## Insumos de contrato para a AG-2 (design → engenharia)
A v1 deve **gravar já** (senão a F4 vira migração retroativa de trilha imutável):
envelope `actor{type,id,requestId}` consultável · `event_type`/`resource_type`/`resource_id` estáveis (publicar catálogo de event_types) · `motivo` · **referência de ancoragem recuperável por evento/intervalo**.
Rotas: `GET /v1/audit/export` (filtros período/ator/event_type/resource_type; JSON/CSV; `audit:export` auditada; recibo com digest ancorado) · `POST verificar integridade` (resultado + bloco, ela própria auditada).
Migração 0006 (D32/D33) no mesmo pacote de gate.

## Fora de escopo v1 (F4/F5)
P3 rico/animado · matriz de governança de tools editável · delegação multi-nível · budget avançado · LangGraph import na UI · Live Mode/telemetria rica · colaboração em tempo real · Console de Auditoria como tela (só API na v1) · drag-and-drop no /forms · migração de instâncias entre versões · process mining visual.

## Circuito do designer (contínuo)
Análise heurística de Nielsen nos PRs de interface (G-UX-1); telas novas de fluxo principal revisadas antes do código (G-UX-3); estados erro/vazio/carregando obrigatórios + axe serious = 0; Atlas/dossiê (`docs/compliance/dossie.md`) atualizados a cada fechamento de fase.
Gate de Piloto: 13 itens (adendos 02+03) — provisionar cedo os de infra (secret manager, WAL imutável no Postgres do piloto).

## Artefatos entregues
`Parecer Console BuildToValue.dc.html` · `Prototipos Agentes e Squads.dc.html` + `Parecer Agentes e Squads.dc.html` · `Atlas de Governanca.dc.html` + `Prototipos Governanca.dc.html` + `Parecer Governanca.dc.html`. Handoffs empacotados em `docs/handoff/`.
