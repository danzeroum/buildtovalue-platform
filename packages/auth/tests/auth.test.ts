import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  hasPermission,
  InvalidTokenError,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from '../src/index.js';

const jwtOptions = { secret: 's'.repeat(32), accessTtlSeconds: 900 };

describe('password (scrypt)', () => {
  it('hash e verificação corretos; senha errada falha', async () => {
    const hash = await hashPassword('correta#123');
    expect(await verifyPassword('correta#123', hash)).toBe(true);
    expect(await verifyPassword('errada', hash)).toBe(false);
  });

  it('hashes de mesma senha diferem (salt aleatório)', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
  });

  it('formato desconhecido não verifica (nunca lança)', async () => {
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
  });
});

describe('JWT de acesso', () => {
  it('roundtrip preserva claims', async () => {
    const { accessToken } = await signAccessToken(
      { sub: 'u1', tenantId: 't1', role: 'analyst' },
      jwtOptions,
    );
    const claims = await verifyAccessToken(accessToken, jwtOptions);
    expect(claims).toEqual({ sub: 'u1', tenantId: 't1', role: 'analyst' });
  });

  it('segredo errado é rejeitado', async () => {
    const { accessToken } = await signAccessToken(
      { sub: 'u1', tenantId: 't1', role: 'admin' },
      jwtOptions,
    );
    await expect(
      verifyAccessToken(accessToken, { ...jwtOptions, secret: 'x'.repeat(32) }),
    ).rejects.toThrow(InvalidTokenError);
  });

  it('token adulterado é rejeitado', async () => {
    const { accessToken } = await signAccessToken(
      { sub: 'u1', tenantId: 't1', role: 'admin' },
      jwtOptions,
    );
    await expect(verifyAccessToken(accessToken.slice(0, -3) + 'abc', jwtOptions)).rejects.toThrow(
      InvalidTokenError,
    );
  });
});

describe('refresh token opaco', () => {
  it('gera token com hash correspondente e entropia', () => {
    const { token, hash } = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hash);
    expect(token.length).toBeGreaterThanOrEqual(43); // 256 bits base64url
    expect(generateRefreshToken().token).not.toBe(token);
  });
});

describe('RBAC v1', () => {
  it('admin tem tudo; business não opera; operator revela sensível', () => {
    expect(hasPermission('admin', 'operate:act')).toBe(true);
    expect(hasPermission('business', 'operate:read')).toBe(false);
    expect(hasPermission('business', 'tasks:work')).toBe(true);
    expect(hasPermission('operator', 'variables:reveal-sensitive')).toBe(true);
    expect(hasPermission('analyst', 'variables:reveal-sensitive')).toBe(false);
    expect(hasPermission('analyst', 'definitions:deploy')).toBe(true);
  });

  it('[AG-2.3 GATE-D] papel auditor: só leitura + audit:export, ZERO escrita', () => {
    // concessão nova: admin e auditor exportam auditoria
    expect(hasPermission('admin', 'audit:export')).toBe(true);
    expect(hasPermission('auditor', 'audit:export')).toBe(true);
    // demais papéis NÃO exportam
    for (const r of ['analyst', 'business', 'operator'] as const) {
      expect(hasPermission(r, 'audit:export')).toBe(false);
    }
    // leitura de metadados: permitida
    expect(hasPermission('auditor', 'instances:read')).toBe(true);
    expect(hasPermission('auditor', 'operate:read')).toBe(true);
    expect(hasPermission('auditor', 'me:read')).toBe(true);
    // ESCRITA: negada em TUDO (separação de deveres)
    const writes = [
      'definitions:deploy',
      'instances:start',
      'instances:cancel',
      'tasks:work',
      'operate:act',
      'variables:reveal-sensitive', // lê procedência, NUNCA conteúdo
    ] as const;
    for (const p of writes) expect(hasPermission('auditor', p)).toBe(false);
  });
});
