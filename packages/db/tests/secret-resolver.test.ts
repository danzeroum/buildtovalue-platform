import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalSecretResolver, secretEnvName } from '../src/agent/secretResolver.js';

/**
 * Resolvedor de `secret://` (§A) — a plataforma só aceita o ponteiro; a chave é
 * resolvida no runtime, FAIL-CLOSED. Interface estável para trocar por Vault/KMS.
 */
describe('secret resolver (§A)', () => {
  it('backend env: resolve pelo nome canônico; ausente lança', async () => {
    const env = { SECRET_TENANTS_ACME_AI_KEY: 'sk-ant-xyz' } as NodeJS.ProcessEnv;
    const r = createLocalSecretResolver({ backend: 'env', env });
    expect(secretEnvName('tenants/acme/ai-key')).toBe('SECRET_TENANTS_ACME_AI_KEY');
    expect(await r.resolve('secret://tenants/acme/ai-key')).toBe('sk-ant-xyz');
    await expect(r.resolve('secret://tenants/globex/ai-key')).rejects.toThrow(/ausente/);
  });

  it('rejeita ref inválida e travessia de diretório', async () => {
    const r = createLocalSecretResolver({ backend: 'env', env: {} });
    await expect(r.resolve('plain-key')).rejects.toThrow(/inválida/);
    await expect(r.resolve('secret://../../etc/passwd')).rejects.toThrow(/inseguro/);
    await expect(r.resolve('secret:///abs')).rejects.toThrow(/inseguro/);
  });

  it('backend file: lê arquivo 600; RECUSA permissão frouxa (fail-closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'btv-secrets-'));
    const good = join(dir, 'ai-key');
    writeFileSync(good, 'sk-ant-file\n');
    chmodSync(good, 0o600);
    const r = createLocalSecretResolver({ backend: 'file', baseDir: dir });
    expect(await r.resolve('secret://ai-key')).toBe('sk-ant-file'); // trailing \n aparado

    const loose = join(dir, 'loose');
    writeFileSync(loose, 'x');
    chmodSync(loose, 0o644); // legível por grupo/outros
    await expect(r.resolve('secret://loose')).rejects.toThrow(/permissão frouxa/);

    await expect(r.resolve('secret://nao-existe')).rejects.toThrow(/ausente/);
  });
});
