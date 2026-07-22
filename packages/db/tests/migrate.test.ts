import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

describe('runner de migrações forward-only', () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_a (id int primary key);');
    // Banco SEM as migrações reais: este teste exercita o runner isolado.
    db = await createTestDatabase('migrate_test', { runMigrations: false });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('aplica em ordem e é idempotente por registro', async () => {
    const first = await migrate(db.migratorUrl, dir);
    expect(first.applied).toEqual(['0001_a.sql']);
    const second = await migrate(db.migratorUrl, dir);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('0001_a.sql');
  });

  it('rejeita migração aplicada que foi EDITADA (imutabilidade)', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_a (id bigint primary key);');
    await expect(migrate(db.migratorUrl, dir)).rejects.toThrow(/checksum diferente/);
    // restaura para não contaminar os demais testes
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_a (id int primary key);');
  });

  it('aplica migrações novas incrementalmente', async () => {
    await writeFile(join(dir, '0002_b.sql'), 'CREATE TABLE t_b (id int primary key);');
    const result = await migrate(db.migratorUrl, dir);
    expect(result.applied).toEqual(['0002_b.sql']);
  });
});
