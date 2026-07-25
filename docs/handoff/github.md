repo: danzeroum/buildtovalue-platform
branch: main
path: apps/console/src, apps/api/src/routes, packages/shared-ui/src

secondary-repo: danzeroum/bpmn
secondary-branch: main
secondary-path: packages/agentflow, docs/design_handoff_btv_squad_lane, docs/design_handoff_btv_agentflow

## Last sync
date: 2026-07-24T19:20:11Z
commit: c556fdc08b58

### Updated in this project
- Auditoria de lacunas administrativas: cruzei 42 rotas de API × 4 rotas do console × espelho de permissões.
- Achado crítico: kill-switch, config de inteligência do tenant e catálogo de tools não têm rota HTTP nem tela (só SQL).
- Achado verificável: `capabilities.ts` divergiu do servidor — falta `audit:export` e qualquer permissão administrativa.
- Entregue `Parecer Lacunas Administrativas.dc.html` recomendando uma 5ª rota (Administração).

## Screen map
| Artefato de design | Construído a partir de |
|---|---|
| `Parecer Lacunas Administrativas.dc.html` | `apps/console/src/{shell,capabilities,session}.ts(x)`, `apps/console/src/routes/*`, `apps/api/src/routes/*`, `docs/runbooks/agent-ensaio.md`, `docs/privacy/gate-piloto-auditoria.md` |
| `ag3-1-marcacao-p1-gate.md` | `docs/handoff/ag3-1-inventario-p1-gate.md` |
| `ag3-0-ratificacao-shared-ui.md` | `packages/shared-ui/src/{selo.tsx,selo.css,tokens.ts,tokens.css}` |
| `ag2-etapa5-marcacao-superficies.md` | `docs/handoff/ag2-etapa5-inventario-estados.md`, `apps/console/src/voices.ts` |
| `Delta Decisao e Tokens.dc.html` · `Parecer Delta Design.dc.html` | `apps/console/src/app.css`, `packages/shared-ui/src/tokens.css`, `apps/console/src/routes/tasks.tsx` |
| `Prototipos Agentes e Squads.dc.html` (P1–P7) | `danzeroum/bpmn`: `packages/agentflow/src/*`, `docs/design_handoff_btv_squad_lane/` |
| `Atlas de Governanca.dc.html` + `Prototipos Governanca.dc.html` | `ADENDO-03`, migrações 0001–0006, `docs/compliance/dossie.md` |
