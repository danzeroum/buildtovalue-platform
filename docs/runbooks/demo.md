# Runbook — fluxo-alvo da F3 (executável por não-desenvolvedor)

> Aceite da F3: **uma pessoa não-desenvolvedora executa o fluxo-alvo seguindo
> este runbook** — login → iniciar um processo → trabalhar a tarefa (formulário
> pinado, validado no servidor) → ver a instância concluída no Operate.
>
> Tudo aqui foi verificado contra Postgres real nesta máquina. Os comandos
> assumem a raiz do repositório e `pnpm` instalado (Node ≥ 22).

## 0. O que sobe

| Peça | Papel | Porta |
|------|-------|-------|
| Postgres | dados (RLS por tenant) | 5432 |
| API (`@platform/api`) | contrato `/v1` | 3000 |
| Worker (`@platform/worker`) | **materializa a user task da outbox**, timers, jobs | métricas 9100 |
| Console (`@platform/console`) | UI (Estúdio/Formulários/Tarefas/Operação) | 5173 (proxy `/v1` → 3000) |

> **O worker é obrigatório**: iniciar uma instância só enfileira efeitos na
> outbox; é o worker que cria a linha de `user_tasks`. Sem ele, a tarefa nunca
> aparece em `/tasks`.

## 1. Instalar e compilar

```bash
pnpm install
pnpm -r build            # compila @platform/* e regenera o SDK do console
```

## 2. Banco: criar, papéis, migrar

Os papéis `app_api` (aplicação, **sem** bypass de RLS) e `app_migrator`
(migração) são separados (D7/8.4). Com um Postgres onde você é superusuário:

```bash
# cria o papel de migração se ainda não existir
psql "$PGADMIN" -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_migrator') THEN
    CREATE ROLE app_migrator LOGIN PASSWORD 'app_migrator_dev' NOBYPASSRLS CREATEROLE;
  END IF; END \$\$;"
# banco do demo, dono = app_migrator
psql "$PGADMIN" -c "CREATE DATABASE buildtovalue OWNER app_migrator"

# migrações (criam o papel app_api + tabelas + RLS)
DATABASE_MIGRATION_URL=postgres://app_migrator:app_migrator_dev@localhost:5432/buildtovalue \
  pnpm --filter @platform/db run migrate
```

`$PGADMIN` é a sua URL de superusuário, ex.:
`postgres://postgres:postgres@localhost:5432/postgres`.

## 3. Config (`.env` na raiz — NUNCA comitar)

```dotenv
API_PORT=3000
API_HOST=127.0.0.1
DATABASE_URL=postgres://app_api:app_api_dev@localhost:5432/buildtovalue
DATABASE_MIGRATION_URL=postgres://app_migrator:app_migrator_dev@localhost:5432/buildtovalue
JWT_SECRET=dev-only-change-me-32-bytes-minimum!!
FIELD_KEY_SECRET=troque-este-segredo-dev-1234
```

## 4. Semear o demo

Cria o tenant `acme`, um usuário por persona (senha `demo1234`), o formulário
`reembolso@1` e o processo `Reembolso de despesas@1` (start → user task
`aprovar_reembolso` → fim):

```bash
pnpm --filter @platform/api run seed:demo
```

> **Avaliador de forms unificado (colapso §2.7).** O `reembolso@1` do demo usa
> expressões RICAS de verdade — `validation: value > 0 and value <= 50000` e
> `visibleWhen: valor > 5000 or decisao = "reprovar"` — avaliadas pelo MESMO
> `formExpressionEvaluator` de `@buildtovalue/forms` no preview do console E no
> `validateSubmission` do servidor. Não há mais o interim só-igualdade: o que o
> `/forms` desenha é exatamente o que o servidor aceita na conclusão.

Personas (todas senha `demo1234`, organização `acme`):

| e-mail | papel | faz |
|--------|-------|-----|
| `ana@acme.test` | business | trabalha tarefas; inicia (ver §7 RBAC) |
| `nara@acme.test` | analyst | publica no Estúdio/Formulários; inicia |
| `olavo@acme.test` | operator | Operação: incidentes, variáveis, cancelamento |
| `admin@acme.test` | admin | tudo (use para o passo-a-passo completo) |

## 5. Subir a pilha (3 terminais)

```bash
pnpm --filter @platform/api dev        # API :3000
pnpm --filter @platform/worker dev     # WORKER (obrigatório)
pnpm --filter @platform/console dev    # console :5173
```

## 6. O fluxo-alvo (no navegador)

1. Abra `http://localhost:5173` → **Entrar**: Organização `acme`,
   `admin@acme.test`, `demo1234`.
2. **Tarefas → + Iniciar processo** → selecione *Reembolso de despesas* →
   *Iniciar instância* (o POST leva `Idempotency-Key`: clique-duplo não duplica).
3. Em segundos a tarefa **Aprovar reembolso** aparece na lista (o worker a criou
   a partir da outbox). Selecione-a.
4. **Assumir tarefa** (claim persistente D21 → token rotacionado). O formulário
   pinado (`reembolso@1`) habilita — o MESMO renderer de `/forms`.
5. Preencha (ex.: Colaborador, Valor `1200`, Decisão *Aprovar*) → **Concluir
   tarefa**. A submissão é revalidada no servidor pelo mesmo schema; erro volta
   por campo (deixe a **Decisão** em branco para ver o 422 — campo obrigatório).
   *(Nota: o form do demo usa `visibleWhen` de igualdade — «Justificativa»
   aparece só quando a Decisão é «Reprovar» — porque o avaliador do servidor
   ainda é o de igualdade; a unificação com o avaliador rico do preview é a
   pendência §2.6.)*
6. **Operação**: a instância aparece **concluída**; abra o drill-down (posição
   no diagrama, histórico, variáveis com sensível mascarada, XES).

## 7. Notas de RBAC (por que cada persona vê o quê)

- `business` tem `instances:start` mas **não** `definitions:read` → o console
  **não** mostra «Iniciar processo» para ela (o modal não conseguiria listar as
  definições). Use `admin`/`analyst` para iniciar. (Registrado em
  `pendencias.md §2.5` — decisão de RBAC do dono.)
- `operator` não inicia nem trabalha tarefas, mas é dono da Operação.

## 8. Provas automatizadas (sem navegador)

- **Fluxo-alvo ponta-a-ponta** (sobe API+worker, dirige por HTTP, checa
  `completed`): `pnpm --filter @platform/api run smoke:flow` (banco semeado).
- **e2e do contrato** (roda no CI, Postgres real): `pnpm --filter @platform/api test`
  (`tests/*.e2e.test.ts` — inclui o fencing formal de user task, D21/D24).
- **p95 do avanço**: `pnpm --filter @platform/api run bench:p95`
  (ver `docs/reports/p95-advance.md`).
- **e2e de navegador (Playwright)**: `pnpm e2e` (ver `apps/e2e/README.md`).

## 9. Reset

```bash
psql "$PGADMIN" -c "DROP DATABASE IF EXISTS buildtovalue WITH (FORCE)"
# repita §2 e §4
```
