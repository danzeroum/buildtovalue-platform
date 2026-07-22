# Pendências — decisões e bloqueios para o dono analisar

> Mantido pelo desenvolvedor sob o regime de autonomia (2026-07-22): PRs
> estratégicas com merge em CI verde; o que exige VOCÊ fica aqui.

## 1. BLOQUEIO ATIVO — publish no npm (engine e, na sequência, forms)

**Único item que trava o fechamento da F1.** ATUALIZAÇÃO (Release #2,
22/07 12:42 UTC): o pipeline inteiro está provado — gate de 28 projetos
verde, guarda pre-mode-aware passou — e o publish morreu com `ENEEDAUTH`:
**o secret `NPM_TOKEN` não resolveu no runner** (chegou vazio). Checklist:

1. Repo `bpmn` → Settings → Secrets and variables → **Actions** →
   *Repository secrets* → nome EXATO `NPM_TOKEN` (environment/Dependabot/
   Codespaces secrets não valem para este workflow).
2. Token do npm tipo *Automation* (ou granular com **Read and write** na
   org `@buildtovalue`), não expirado.
3. Re-executar `release.yml` com dry-run desmarcado. A PR bpmn#168
   (fail-fast) faz futuras ausências do secret falharem em segundos com a
   mensagem exata, em vez de após 4min de gate.

- **O que preciso de você (um dos dois):**
  - (a) rodar `release.yml` na UI do Actions da `main` do `bpmn` com
    **dry-run desmarcado** — publica `engine@1.1.0-next.0` (e
    `forms@1.0.0-next.0` quando a PR das forms mergear); pacotes já
    publicados nas mesmas versões são pulados; **ou**
  - (b) conceder `actions: write` à integração (recomendação da sua própria
    triagem: elimina o gargalo recorrente; o gate humano continua sendo a
    revisão de PR antes do merge na `main`).
- **O que destrava:** pino exato do engine na plataforma (D5) → crash test
  das 100 instâncias → fechamento F1.8 → tag `phase-1` → F2.
- **Pré-requisito já satisfeito:** a `main` do `bpmn` contém o engine
  (PR #165 de restauração — o merge original da #162 às 01:39 UTC capturou
  só os docs; os commits do engine entraram na branch DEPOIS. Restaurados
  por cherry-pick, revalidados sobre a main pós-SL-12/13).

## 2. Decisões tomadas em autonomia (validar quando puder — nada bloqueia)

1. **Refresh token opaco prefixado** `${tenantId}.${segredo}` (resolve o
   contexto RLS no refresh sem tabela global; só o hash persiste).
2. **`instances.definition_ref` é TEXT** (`'skeleton@1'`) até a F2
   introduzir `process_definitions`/registry — comentado na migração 0002.
3. **`jobs.wait_key UNIQUE`** como âncora do exatamente-uma-vez na criação
   de jobs sob re-dispatch (complementa a UNIQUE de `effect_key` na outbox).
4. **`forms.date` = data-calendário ISO `YYYY-MM-DD`** sem hora/fuso
   (campo de data com hora entraria como tipo novo em minor).
5. **Storybook do forms-react**: instalado como devDependency do monorepo
   público (peso de install considerável) — se preferir Storybook em repo
   separado ou docs estáticos, dá para mudar depois sem tocar no renderer.

## 2.1 ADR-0002 (tombstones LGPD×ledger) — PROPOSTO, aguarda seu aceite

`docs/architecture/ADR-0002-tombstones-ledger-lgpd.md`: Anexo B adotado
(conteúdo fora do ledger + tombstone de eliminação + salt por registro),
com as alternativas B/C e trade-offs. A política 3.2 pede sua aprovação —
a implementação da costura (KeyProvider + teste "ledger sem conteúdo
pessoal") entra na F2 assim que aceitar (ou ajustar).

## 3. Registro de fluxo (sem ação sua)

- Issue #2 deste repo: regra de lint D19 "boundary só sobre atividade de
  espera" (alvo F3.1), com casos de teste.
- Ensaio de restore documentado em `docs/runbooks/database.md` (2026-07-22)
  — item de aceite da F1 que a triagem pediu para não perder de vista.
