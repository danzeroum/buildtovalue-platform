import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * Runner de migrações FORWARD-ONLY (plano §7): aplica `migrations/*.sql` em
 * ordem lexicográfica, uma transação por arquivo, registrando nome + checksum
 * em `schema_migrations`. Não existe "down": reversão é fix-forward; o plano
 * de emergência é restore ensaiado (docs/runbooks/database.md).
 *
 * Guardas de integridade:
 * - arquivo já aplicado com checksum DIFERENTE => erro (migração aplicada é
 *   imutável — corrija com uma migração nova);
 * - arquivo aplicado que sumiu do disco => erro (histórico não se apaga).
 */
export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  databaseUrl: string,
  migrationsDir: string,
): Promise<MigrationResult> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const appliedRows = await sql<{ name: string; checksum: string }[]>`
      SELECT name, checksum FROM schema_migrations ORDER BY name`;
    const appliedByName = new Map(appliedRows.map((r) => [r.name, r.checksum]));

    for (const [name] of appliedByName) {
      if (!files.includes(name)) {
        throw new Error(`Migração aplicada "${name}" não existe mais no disco — forward-only.`);
      }
    }

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      const content = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      const known = appliedByName.get(file);
      if (known !== undefined) {
        if (known !== checksum) {
          throw new Error(
            `Migração "${file}" já aplicada com checksum diferente — migração é imutável; corrija com uma migração NOVA.`,
          );
        }
        skipped.push(file);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${file}, ${checksum})`;
      });
      applied.push(file);
    }
    return { applied, skipped };
  } finally {
    await sql.end();
  }
}
