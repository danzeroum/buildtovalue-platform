# Exceções do gate `pnpm audit` (rastreabilidade)

O CI roda `pnpm audit --audit-level high` (item 2 do Gate 8.4 — gate de máquina).
Ele bloqueia em **qualquer** advisory `high`. Uma exceção só entra aqui, com
**motivo, aplicabilidade e o fix real** — nunca silenciosa. `pnpm.auditConfig.ignoreGhsas`
no `package.json` carrega a lista; esta tabela é o porquê.

| GHSA | pacote | por que ignorado | fix real (rastreado) |
|---|---|---|---|
| `GHSA-qwww-vcr4-c8h2` | `react-router` (via `react-router-dom`) | **RSC Mode CSRF Bypass** — a falha é do **modo RSC** (React Server Components / server actions). O Console é **SPA data-mode** (`createBrowserRouter` + `RouterProvider`, client-only) — **não usa RSC**, então a superfície da falha não existe aqui. | **Migração para `react-router` ≥ 8.3.0** (o único patch). `react-router-dom` **não tem 8.x** (parou em 7.18.1); v8 removeu o pacote e mudou API — é migração deliberada do Console, não um bump de dep. Decisão de escopo do dono. |
| `GHSA-mh99-v99m-4gvg` | `brace-expansion` (via `minimatch`, transitivo em `eslint`/`@vitest/coverage-v8`) | **DoS via expansão ilimitada** (`{a,b}` patterns) — as 3 rotas do audit são todas **tooling de build/lint/coverage**, operando sobre padrões **fixos, definidos pelo dev** neste repo (glob de exclusão de cobertura, config do eslint) — nunca sobre entrada de usuário em runtime. A superfície do ataque (parsear um padrão HOSTIL) não existe aqui. | **Nenhum patch compatível existe para as linhas antigas.** `brace-expansion` é uma ÚNICA linha de versão (não forks) que foi de `0.0.0` a `5.0.8`; o fix só chegou a partir de ~`3.0.2`/`5.0.2` — as linhas `1.x` (última `1.1.16`) e `2.x` (última `2.1.2`), que `minimatch@3`/`minimatch@5` ainda usam, **nunca receberam backport**. Uma tentativa de override forçando tudo para `≥5.0.8` foi testada e **quebrou em runtime** (`brace_expansion_1.default is not a function` — a API mudou entre as linhas major, incompatível com o `require()` do `minimatch` antigo) — revertida. O fix real é os consumidores (`eslint`, `@vitest/coverage-v8` → `test-exclude`/`glob`) atualizarem para versões que já usam `minimatch` em linhas mais novas (que trazem `brace-expansion ≥5.x` nativamente) — fora do nosso controle direto, é upstream. |

## Data de revisão e gatilhos de invalidação (obrigatório — condição do dono)

Sem data de revisão, "temporária" vira permanente por inércia.

- **Revisão periódica: a cada 60 dias.** Última: **2026-07-24** · **próxima: 2026-09-22.**
  Na revisão: a linha 7.x ainda é a melhor? o fix (v8) ficou viável? o advisory mudou
  de classe? Se nada mudou, renova a data; senão, age. `brace-expansion` entra na MESMA
  revisão: `eslint`/`@vitest/coverage-v8` já atualizaram para uma versão que traga
  `minimatch` numa linha com `brace-expansion ≥5.x` nativo?
- **Gatilhos que INVALIDAM a exceção na hora (não esperam os 60 dias):**
  1. **O Console adotar RSC / server actions** → a falha (RSC CSRF) passa a se aplicar;
     a exceção cai e o fix vira urgente.
  2. **Advisory NOVO em `react-router` ou em `brace-expansion`** → o `ignoreGhsas` é
     GHSA-específico, então o gate JÁ pega qualquer advisory novo (não é suprimido). O
     registro aqui é: um advisory novo **força reavaliar a linha inteira** (pode não
     haver mais "última versão limpa" e a migração/atualização deixar de ser adiável).
  3. **Qualquer padrão de `brace-expansion`/glob passar a receber entrada NÃO
     confiável** (ex.: um path/pattern vindo de upload de usuário, request, etc.) →
     a premissa de "só padrão fixo do dev" cai e a exceção precisa ser revista IMEDIATAMENTE.

## Pendência nomeada (para `docs/pendencias.md` do dono)
- **[ITEM] Migração do Console para `react-router` v8** — o único caminho que remove
  esta exceção (v7.x não tem patch; `react-router-dom` não tem 8.x). É **leva própria**
  (v8 mudou API), fora da fase de superfícies. **Gatilho: reavaliar na revisão de 60 dias
  (2026-09-22) OU se qualquer um dos dois gatilhos acima disparar.**
- **[ITEM] `brace-expansion` (GHSA-mh99-v99m-4gvg)** — sem ação nossa possível: o fix
  depende de `eslint`/`@vitest/coverage-v8` atualizarem sua própria dependência de
  `minimatch`/`glob` para uma linha que já embuta `brace-expansion ≥5.x`. **Não tentar
  override forçado de novo** — quebra em runtime (API incompatível entre majors da
  mesma linha de versão; testado e revertido nesta entrada). **Gatilho: revisão de 60
  dias (2026-09-22), ou quando `eslint`/`@vitest/coverage-v8` publicarem nova major.**

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
