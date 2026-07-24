import { assertRealKey, createDb, createLocalSecretResolver, getTenantAiConfig } from '@platform/db';

/**
 * DOCTOR do secret:// (AG-2.5 bootstrap) — verifica, ANTES do ensaio, que:
 *  · SECRET_BACKEND/SECRET_DIR/FX_USD_BRL estão setados (itens 4/5 do bootstrap);
 *  · o `key_ref` do tenant_ai_config RESOLVE pelo backend de arquivo;
 *  · a chave passa a guarda de placeholder (fail-closed) — SEM imprimir o valor.
 *
 * NUNCA imprime a chave: só comprimento + prefixo `sk-` (não é segredo). Uso:
 *   docker compose run --rm --entrypoint node worker dist/secret-doctor.js <tenantId>
 */
const tenantId = process.argv[2];
const backend = (process.env.SECRET_BACKEND ?? 'env') as 'env' | 'file';
const dir = process.env.SECRET_DIR ?? '/run/secrets/btv';
const fx = process.env.FX_USD_BRL;

console.log(
  JSON.stringify({ check: 'secret-doctor', SECRET_BACKEND: backend, SECRET_DIR: dir, FX_USD_BRL: fx ?? '(AUSENTE)' }),
);
if (!fx) {
  console.error('AVISO: FX_USD_BRL ausente — um modelo em USD (DeepSeek) fará parada honesta (fx-missing).');
}
if (!tenantId) {
  console.error('uso: node dist/secret-doctor.js <tenantId>');
  process.exit(2);
}

const sql = createDb(process.env.DATABASE_URL ?? '', { max: 1 });
try {
  const cfg = await getTenantAiConfig(sql, tenantId);
  if (!cfg) {
    console.error(`FALHA: tenant ${tenantId} sem tenant_ai_config (rode o passo de INSERT).`);
    process.exit(1);
  }
  console.log(JSON.stringify({ provider: cfg.provider, model: cfg.model, base_url: cfg.baseUrl, key_ref: cfg.keyRef }));

  const resolver = createLocalSecretResolver({ backend, baseDir: dir });
  const key = await resolver.resolve(cfg.keyRef); // fail-closed: perm frouxa/ausente lança
  assertRealKey(key); // lança se placeholder/curta — sem imprimir o valor
  console.log(
    JSON.stringify({
      result: 'OK',
      message: 'chave resolvida do secret:// e passou a guarda (fail-closed) — pronta para o ensaio',
      keyLength: key.length,
      keyStartsWithSk: key.startsWith('sk-'),
    }),
  );
} catch (e) {
  console.error('FALHA:', e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  await sql.end();
}
