# docs/handoff — pacote de design (fonte de verdade)

O **chat** é o canal de revisão com o designer; **este diretório é a fonte de verdade** —
o desenvolvedor trabalha de forma autônoma e só alcança o que está no repo. Todo artefato
normativo vive aqui.

## Governantes (topo)
- `PLANO-buildtovalue-platform-v1.2.md` — plano faseado (mantido pela engenharia).
- `ADENDO-01-parecer-design.md` — decisões A–C da F3 (Console).
- `ADENDO-02-agentes-squads.md` — agentes/squads como critério de lançamento (D26–D31).
- `ADENDO-03-conformidade.md` — governança ISO 42001 / EU AI Act (D32–D37).

## `handoff-agentes/` — superfícies de plataforma P1–P7
| Arquivo | Papel |
|---|---|
| `Prototipos-Agentes-e-Squads-P1-anotado-2026-07-24.html` | **NORMATIVO — referência de construção do payload do gate (etapa 5).** O world-delta do P1 congela o schema: campos do `ToolContract` + consequência derivada do processo, com a fonte marcada por linha. O `ag2-etapa5-gate.md` (desenho do dev) deve apontar de volta para este arquivo. Revisão futura **não** sobrescreve este nome — novo nome com nova data. |
| `Parecer-Agentes-e-Squads.html` | Parecer por superfície + respostas a–d + fatia v1. |
| `BRIEFING-designer-agentes-squads.md` | Briefing que originou a frente. |

## `handoff-design-delta/` — delta AG-2.1/2.2
| Arquivo | Papel |
|---|---|
| `DELTA-design-ag21-ag22.md` | Itens 1–3 ratificados/corrigidos, varredura V1–V5, protocolo de gate, mapa de aplicação. |
| `Delta-Decisao-e-Tokens.html` | Protótipo do controle de decisão canônico + aliasing de token (gold→gate) + papel de agente. |
| `Parecer-Delta-Design.html` | Parecer do delta (três blocos). |

## `handoff-governanca/` — Atlas de Governança
Atlas (E1) + superfícies (E2 selo de procedência · E3 Console de Auditoria · E6) + parecer.
Ver `handoff-governanca/README.md`.

## Como abrir
Os `.html` são autорrenderizáveis: carregam `./support.js` (e os pareceres/Atlas também
`./doc-page.js`) do **mesmo diretório** — por isso cada pasta traz sua cópia dos dois JS.
Mantenha os arquivos juntos. Pareceres e Atlas exportam PDF pelo diálogo de impressão.

## Commit
Subir por **PR de docs** (não pela UI — foi o upload pela UI que trouxe os JS de suporte e
quebrou o lint da #14; `docs/**` já está fora do lint, e a PR mantém histórico limpo).
