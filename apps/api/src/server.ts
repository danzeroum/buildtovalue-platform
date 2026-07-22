import { loadConfig } from '@platform/config';
import { createDb, createRefreshTokenRepository, createRuntime, createUserRepository } from '@platform/db';
import { buildApp } from './app.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);

const app = await buildApp({
  config,
  users: createUserRepository(sql),
  refreshTokens: createRefreshTokenRepository(sql),
  runtime: createRuntime(sql),
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
