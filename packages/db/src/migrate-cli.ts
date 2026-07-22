import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL não definida (papel de migração, não o da API).');
  process.exit(1);
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const result = await migrate(url, dir);
console.log(
  `Migrações: ${result.applied.length} aplicada(s) [${result.applied.join(', ')}], ${result.skipped.length} já aplicada(s).`,
);
