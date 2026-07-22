import { loadConfig } from '@platform/config';
import {
  createDb,
  createEnvKeyProvider,
  createRefreshTokenRepository,
  createRuntime,
  createUserRepository,
} from '@platform/db';
import { buildApp } from './app.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
// Costura LGPD (D20): sem FIELD_KEY_SECRET, gravar um campo sensitive falha
// alto (nunca plaintext silencioso); produção usa KMS na F5.
const keyProvider = config.FIELD_KEY_SECRET
  ? createEnvKeyProvider(config.FIELD_KEY_SECRET)
  : undefined;

const app = await buildApp({
  config,
  users: createUserRepository(sql),
  refreshTokens: createRefreshTokenRepository(sql),
  runtime: createRuntime(sql, undefined, { keyProvider }),
  dbReady: async () => {
    await sql`SELECT 1`;
    return true;
  },
});

const close = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: config.API_PORT, host: config.API_HOST });
