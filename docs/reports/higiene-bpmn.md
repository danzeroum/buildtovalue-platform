# Higiene do repo bpmn — cobrança da triagem phase-1/phase-2

> Registro durável dos dois itens de higiene (o checkpoint em chat não conta
> como registro). Atualizado em 2026-07-22.

## 1. Explicação do "engine restaurado" (PR bpmn#165)

Linha do tempo do incidente, commit a commit:

1. A PR **#162** (extração do engine, F0b.2) foi **mergeada às 01:39 UTC**
   de 22/07 — naquele instante a branch remota continha apenas o commit de
   documentação `95c4d62`; os **4 commits do engine** (types/advance/graph/
   testes) ainda não tinham sido enviados (push pendente do meu lado).
2. Meu push seguinte fez a branch designada apontar para uma história
   re-baseada; os 4 commits do engine ficaram **órfãos no remoto** — a
   `main` pós-#162 tinha o ADR e os docs, mas NÃO o código do engine.
3. Recuperação: **cherry-pick dos 4 commits a partir dos objetos locais**
   sobre a `main` nova (pós-SL-12/13), revalidação completa (38 testes do
   engine + typecheck do repo com zero erros) e reabertura como PR **#165**
   ("engine restaurado"), mergeada em CI verde.
4. Causa-raiz: merge da PR antes do push final do autor. Mitigação adotada:
   merges apenas com o CI verde da branch REMOTA no SHA final (o gate atual
   compara head SHA) — o cenário não se repetiu nas PRs seguintes.

Nada foi perdido: diff da #165 confere com o trabalho original validado.

## 2. Inventário das PRs abertas no bpmn (uma linha por PR — 22/07)

| PR | Uma linha |
|---|---|
| #157 | dependabot: bump do grupo de devDependencies (11 pacotes) — exige gate completo (mexe em toolchain de build/test). |
| #111 | dependabot: actions/setup-node 4→7 — major de action de CI; validar em lote com as demais. |
| #91 | do dono: RELEASE.md runbook do publish (I-6) — **desatualizado pós-pre-mode `next`**; recomendo eu revisar o texto sobre a sua base e você mergear. |
| #61 | dependabot: react/react-dom/@types/react — toca demos e forms-react; exige gate completo + smoke visual. |
| #59 | dependabot: actions/checkout 4→7 — major de action de CI; lote. |
| #58 | dependabot: pnpm/action-setup 4→6 — major de action de CI; lote. |
| #57 | dependabot: actions/upload-artifact 4→7 — major de action de CI; lote. |

Recomendação: as 4 de Actions (#111/#59/#58/#57) validam num único lote de
CI quando a F3 assentar; #157 e #61 depois, uma a uma, com o gate de 28
projetos. #91 é sua — posso preparar a revisão quando quiser.
