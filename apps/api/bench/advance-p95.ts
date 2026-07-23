/**
 * Medição p95 do AVANÇO (leva 7 / aceite F3). Mede a latência de UM avanço de
 * instância contra Postgres real: a transação que carrega a definição, aplica
 * o evento de engine, persiste o novo estado (revision+1) e enfileira efeitos
 * (D11/D22). Usamos o start do walking skeleton (`skeleton@1`) — um avanço
 * limpo e reproduzível, sem I/O externo — como proxy do "P95 ADVANCE" do
 * protótipo do Operate.
 *
 * Rodar: pnpm --filter @platform/api run bench:p95   (Postgres em TEST_PG_ADMIN_URL)
 * Ajustar amostra: BENCH_N=1000 pnpm ...
 *
 * NÃO é um teste (não roda no CI de cobertura): é uma medição registrada em
 * docs/reports/fase-3.md. Números variam com a máquina; o método é o que vale.
 */
import { createRuntime } from '@platform/db';
import postgres from 'postgres';
import { createTestDatabase } from '../../../packages/db/tests/helpers.js';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

async function main(): Promise<void> {
  const N = Number(process.env.BENCH_N ?? 500);
  const WARMUP = Number(process.env.BENCH_WARMUP ?? 30);

  const db = await createTestDatabase('benchp95');
  const migrator = postgres(db.migratorUrl, { max: 1, onnotice: () => {} });
  let tenant: string;
  try {
    const [t] = await migrator`INSERT INTO tenants (slug, name) VALUES ('bench', 'Bench') RETURNING id`;
    tenant = t.id as string;
  } finally {
    await migrator.end();
  }

  const sql = postgres(db.apiUrl, { max: 8, onnotice: () => {} });
  const runtime = createRuntime(sql);
  const samples: number[] = [];

  try {
    for (let i = 0; i < WARMUP + N; i++) {
      const t0 = process.hrtime.bigint();
      const outcome = await runtime.createAndStart(tenant, {
        definitionRef: 'skeleton@1',
        businessKey: `bench-${i}`,
      });
      const t1 = process.hrtime.bigint();
      if (!outcome.ok) throw new Error(`createAndStart falhou: ${outcome.message}`);
      if (i >= WARMUP) samples.push(Number(t1 - t0) / 1e6); // ns → ms
    }
  } finally {
    await sql.end();
    await db.drop();
  }

  samples.sort((a, b) => a - b);
  const round = (x: number) => Math.round(x * 100) / 100;
  const result = {
    operation: 'advance (evento start) via createAndStart · definição skeleton@1',
    postgres: 'real (TEST_PG_ADMIN_URL)',
    concurrency: 'sequencial (baseline de uma conexão lógica por vez)',
    samples: samples.length,
    ms: {
      p50: round(percentile(samples, 50)),
      p95: round(percentile(samples, 95)),
      p99: round(percentile(samples, 99)),
      max: round(samples[samples.length - 1]),
    },
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
