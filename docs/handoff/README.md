# Handoff — Agentes e Squads de IA (frente F-AG da v1)

Pacote de design + governança que entra em `docs/handoff/` junto com o merge da #14.
É o insumo para o desenvolvedor disparar **AG-1 imediatamente** (H22 na biblioteca, em
paralelo à esteira F3) e preparar a proposta de contrato da **AG-2** para aprovação do dono.

## Conteúdo

| Arquivo | O que é |
|---|---|
| `ADENDO-02-agentes-squads.md` | **Governante.** Decisões D26–D31, fase F-AG (AG-1..AG-4), regime de contrato, 9 aceites e itens novos do Gate de Piloto. Anexa ao `PLANO-buildtovalue-platform-v1.2.md` após o ADENDO-01. |
| `BRIEFING-designer-agentes-squads.md` | O briefing que originou a frente: inventário da biblioteca, fronteira biblioteca×plataforma, superfícies P1–P7, convite à inovação, fatia v1 proposta. |
| `Prototipos-Agentes-Squads-P1-P7.dc.html` | Protótipos hi-fi das 7 superfícies de plataforma (P1 gate · P2 execução · P3 squad · P4 inteligência do tenant · P5 catálogo · P6 deploy+lint · P7 Evidence Bundle) + as 4 assinaturas de inovação. |
| `Parecer-Agentes-Squads.dc.html` | Parecer do designer (imprimível): aprovação por superfície, respostas às perguntas a–d, considerações e item de spec. |
| `support.js`, `doc-page.js` | Runtime dos artefatos `.dc.html` (não editar). |

## Como abrir os protótipos e o parecer

Abra os `.dc.html` direto no navegador — eles carregam `./support.js` (e o parecer também
`./doc-page.js`) do mesmo diretório. Mantenha os quatro arquivos na mesma pasta.
O parecer imprime em PDF pelo diálogo de impressão do navegador (documento paginado).

## Ordem de leitura sugerida

1. `BRIEFING` (contexto e por que a frente existe)
2. `Prototipos` P1–P7 (a forma proposta)
3. `Parecer` (o veredito e as decisões a–d)
4. `ADENDO-02` (a tradução em engenharia executável — governante)

## Identidade visual

Mesma linguagem da biblioteca (decisão C do parecer F3 → `packages/shared-ui`): IBM Plex
Sans/Mono + Source Serif 4; creme/verde/dourado, vermelho para efeito irreversível, violeta
para squad/delegação. Os dois mundos (operação BPMN × operação de agente) encaixam sem costura.

## Estado da frente (para retomar contexto)

- **F3:** decisões A (nomes humanos na nav) · B (reatribuição simples) · C (identidade da
  biblioteca → `shared-ui`) já pactuadas.
- **F-AG v1:** P1/P2/P4/P6 completos · P5 mínima · P7 card · P3 leitura · H22 na biblioteca.
- **F4/F5:** P3 rico/animado, matriz editável, delegação multi-nível, budget avançado,
  LangGraph na UI, Live Mode.
- Designer segue no circuito: heurística nos PRs de interface (G-UX-1) e telas novas
  revisadas antes do código (G-UX-3); aceite executável na demo AG-4.
