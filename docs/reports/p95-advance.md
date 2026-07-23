# Medição p95 do avanço (F3, leva 7)

> Número exigido pelo aceite da F3 (o cartão "P95 ADVANCE" do protótipo do
> Operate). Reproduzível; o método vale mais que o número absoluto (varia com a
> máquina).

## O que é medido

A latência de **UM avanço de instância** contra Postgres real: a transação que
`SELECT … FOR UPDATE` a instância, carrega a definição, aplica o evento de
engine (determinístico, D11), persiste o novo estado com `revision+1` e
enfileira os efeitos na outbox (D22). Usamos o **start** do walking skeleton
(`skeleton@1`) — um avanço limpo, sem I/O externo — via
`runtime.createAndStart`. `FOR UPDATE` serializa por instância e não há retry de
revisão, então esta é a forma mais pura do "custo de um passo".

## Como rodar

```bash
# Postgres acessível em TEST_PG_ADMIN_URL (default: postgres://postgres:postgres@localhost:5432/postgres)
BENCH_N=500 pnpm --filter @platform/api run bench:p95
```

O harness (`apps/api/bench/advance-p95.ts`) cria um database descartável, roda
as migrações reais, semeia um tenant, faz `WARMUP` avanços de aquecimento e
mede os `N` seguintes com `process.hrtime.bigint()`.

## Resultado (2026-07-23, ambiente da sessão de dev)

Postgres 16.13 · N=500 sequencial · WARMUP=30

| métrica | ms |
|--------:|-----|
| p50 | **5.96** |
| p95 | **7.89** |
| p99 | **11.44** |
| max | 25.88 |

**p95 ≈ 7.9 ms** — folga confortável sob a referência ilustrativa do protótipo
(38 ms). Leitura: com `FOR UPDATE` serializando por instância, o caminho de
avanço é O(1) queries + O(efeitos) inserts e não tem hot spot no subconjunto v1.

## Ressalvas honestas

- **Sequencial** (uma conexão lógica por vez): é o baseline do custo de um
  passo, não um teste de carga concorrente. Sob contenção na MESMA instância, o
  `FOR UPDATE` serializa (esperado); instâncias distintas avançam em paralelo.
- Sem I/O externo no passo medido (o efeito vai para a outbox; o dispatch e o
  handler HTTP/e-mail são assíncronos e ficam fora deste número — por design).
- Máquina de dev compartilhada; reproduza no alvo de produção para um número de
  capacidade. O objetivo aqui é fixar o MÉTODO e uma ordem de grandeza sadia.
