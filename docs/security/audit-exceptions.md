# Exceções do gate `pnpm audit` (rastreabilidade)

O CI roda `pnpm audit --audit-level high` (item 2 do Gate 8.4 — gate de máquina).
Ele bloqueia em **qualquer** advisory `high`. Uma exceção só entra aqui, com
**motivo, aplicabilidade e o fix real** — nunca silenciosa. `pnpm.auditConfig.ignoreGhsas`
no `package.json` carrega a lista; esta tabela é o porquê.

| GHSA | pacote | por que ignorado | fix real (rastreado) |
|---|---|---|---|
| `GHSA-qwww-vcr4-c8h2` | `react-router` (via `react-router-dom`) | **RSC Mode CSRF Bypass** — a falha é do **modo RSC** (React Server Components / server actions). O Console é **SPA data-mode** (`createBrowserRouter` + `RouterProvider`, client-only) — **não usa RSC**, então a superfície da falha não existe aqui. | **Migração para `react-router` ≥ 8.3.0** (o único patch). `react-router-dom` **não tem 8.x** (parou em 7.18.1); v8 removeu o pacote e mudou API — é migração deliberada do Console, não um bump de dep. Decisão de escopo do dono. |

## Regras
1. **Só `high`/moderate genuinamente inaplicável OU sem patch viável** entra aqui.
   Advisory aplicável = corrige, não ignora.
2. Cada linha declara **aplicabilidade** (por que não nos atinge) **e** o **fix real**
   (o que destravaria a remoção da exceção). Sem os dois, não entra.
3. Fixamos na **última versão da linha sem outros advisories** — aqui `react-router@7.18.1`
   (baixar para 7.11 reintroduz 13 outros; subir exige v8). O gate segue ativo para
   todo o resto.
4. Revisar a cada fase: quando o fix real for feito, a linha sai daqui **e** do
   `ignoreGhsas`.
