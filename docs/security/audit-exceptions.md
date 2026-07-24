# Exceções do gate `pnpm audit` (rastreabilidade)

O CI roda `pnpm audit --audit-level high` (item 2 do Gate 8.4 — gate de máquina).
Ele bloqueia em **qualquer** advisory `high`. Uma exceção só entra aqui, com
**motivo, aplicabilidade e o fix real** — nunca silenciosa. `pnpm.auditConfig.ignoreGhsas`
no `package.json` carrega a lista; esta tabela é o porquê.

| GHSA | pacote | por que ignorado | fix real (rastreado) |
|---|---|---|---|
| `GHSA-qwww-vcr4-c8h2` | `react-router` (via `react-router-dom`) | **RSC Mode CSRF Bypass** — a falha é do **modo RSC** (React Server Components / server actions). O Console é **SPA data-mode** (`createBrowserRouter` + `RouterProvider`, client-only) — **não usa RSC**, então a superfície da falha não existe aqui. | **Migração para `react-router` ≥ 8.3.0** (o único patch). `react-router-dom` **não tem 8.x** (parou em 7.18.1); v8 removeu o pacote e mudou API — é migração deliberada do Console, não um bump de dep. Decisão de escopo do dono. |

## Data de revisão e gatilhos de invalidação (obrigatório — condição do dono)

Sem data de revisão, "temporária" vira permanente por inércia.

- **Revisão periódica: a cada 60 dias.** Última: **2026-07-24** · **próxima: 2026-09-22.**
  Na revisão: a linha 7.x ainda é a melhor? o fix (v8) ficou viável? o advisory mudou
  de classe? Se nada mudou, renova a data; senão, age.
- **Gatilhos que INVALIDAM a exceção na hora (não esperam os 60 dias):**
  1. **O Console adotar RSC / server actions** → a falha (RSC CSRF) passa a se aplicar;
     a exceção cai e o fix vira urgente.
  2. **Advisory NOVO em `react-router`** → o `ignoreGhsas` é GHSA-específico, então o
     gate JÁ pega o novo (não é suprimido). O registro aqui é: um advisory novo **força
     reavaliar a linha 7.x inteira** (pode não haver mais "última 7.x limpa" e a v8
     deixar de ser adiável).

## Pendência nomeada (para `pendencias.md` do dono)
- **[ITEM] Migração do Console para `react-router` v8** — o único caminho que remove
  esta exceção (v7.x não tem patch; `react-router-dom` não tem 8.x). É **leva própria**
  (v8 mudou API), fora da fase de superfícies. **Gatilho: reavaliar na revisão de 60 dias
  (2026-09-22) OU se qualquer um dos dois gatilhos acima disparar.**

## Regras
1. **Só `high`/moderate genuinamente inaplicável OU sem patch viável** entra aqui.
   Advisory aplicável = corrige, não ignora.
2. Cada linha declara **aplicabilidade** (por que não nos atinge) **e** o **fix real**
   (o que destravaria a remoção da exceção). Sem os dois, não entra.
3. Fixamos na **última versão da linha sem outros advisories** — aqui `react-router@7.18.1`
   (baixar para 7.11 reintroduz 13 outros; subir exige v8). O gate segue ativo para
   todo o resto.
4. Revisar a cada 60 dias (acima): quando o fix real for feito, a linha sai daqui **e** do
   `ignoreGhsas`.
