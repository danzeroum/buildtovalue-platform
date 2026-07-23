# @platform/e2e — e2e de navegador (Playwright)

Dirige o **console real** (Chromium) pelo fluxo-alvo da F3 — o mesmo do
`docs/runbooks/demo.md §6`.

## Rodar

```bash
# 1) Suba a pilha e semeie (runbook §2–5): Postgres migrado, seed:demo, API :3000, worker, console :5173
# 2) então:
pnpm --filter @platform/e2e exec playwright install chromium   # 1ª vez (ou use o Chromium pré-instalado do ambiente)
pnpm --filter @platform/e2e run e2e
```

O `playwright.config.ts` reaproveita o console em `:5173` se já estiver no ar
(`reuseExistingServer`). A **API e o worker precisam estar de pé** — o worker é
quem materializa a user task da outbox. Banco **recém-semeado** (um processo
publicado, sem instâncias) para o seletor da tarefa ser único.

## Status (honesto)

- O spec (`tests/target-flow.spec.ts`) é escrito contra os seletores REAIS do
  console (login `Organização/E-mail/Senha` + `Entrar`; `+ Iniciar processo`;
  `Assumir tarefa`; `Concluir tarefa`; `só incidentes`) e passa no typecheck.
- **Não foi executado no ambiente de dev da sessão**: o sandbox mata comandos
  de tool que sobem vários servidores de rede ao mesmo tempo (API+worker+console
  simultâneos). Rode-o numa máquina de dev/CI comum.
- **Fora do CI de cobertura** (vitest) de propósito — é um alvo próprio. A
  cobertura e2e do fluxo-alvo NO CI vem dos testes de contrato
  (`apps/api/tests/*.e2e.test.ts`, Postgres real) e do smoke HTTP
  (`apps/api/scripts/smoke-flow.ts`). Wire-up de um job de CI com navegador é o
  passo seguinte (ver `docs/reports/fase-3.md`).
