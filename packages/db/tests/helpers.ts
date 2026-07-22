import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { migrate } from '../src/migrate.js';

/**
 * Infra dos testes de integração: cria um database descartável, roda as
 * migrações reais nele e devolve URLs para os DOIS papéis (migrator e api).
 *
 * Requer um Postgres acessível via TEST_PG_ADMIN_URL (default: local dev).
 * No CI, o service container fornece exatamente isso.
 */
const ADMIN_URL =
  process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export interface TestDatabase {
  name: string;
  adminUrl: string;
  migratorUrl: string;
  apiUrl: string;
  drop(): Promise<void>;
}

function withDb(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withUser(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

export async function createTestDatabase(
  prefix: string,
  options: { runMigrations?: boolean } = {},
): Promise<TestDatabase> {
  const name = `${prefix}_${process.pid}_${Date.now()}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    // Papel de migração separado do papel da API (gate 8.4). Senha dev/CI.
    // EXCEPTION captura a corrida IF-NOT-EXISTS/CREATE entre suítes
    // concorrentes (visto no CI: unique_violation em pg_authid).
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_migrator') THEN
          CREATE ROLE app_migrator LOGIN PASSWORD 'app_migrator_dev' NOBYPASSRLS CREATEROLE;
        END IF;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL; -- outra conexão criou o papel no meio — estado desejado atingido
      END $$;
    `);
    await admin.unsafe(`ALTER DATABASE ${name} OWNER TO app_migrator`);
  } finally {
    await admin.end();
  }

  const adminDbUrl = withDb(ADMIN_URL, name);
  const migratorUrl = withUser(adminDbUrl, 'app_migrator', 'app_migrator_dev');
  if (options.runMigrations !== false) await migrate(migratorUrl, MIGRATIONS_DIR);

  return {
    name,
    adminUrl: adminDbUrl,
    migratorUrl,
    apiUrl: withUser(adminDbUrl, 'app_api', 'app_api_dev'),
    async drop() {
      const cleaner = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      try {
        await cleaner.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleaner.end();
      }
    },
  };
}
