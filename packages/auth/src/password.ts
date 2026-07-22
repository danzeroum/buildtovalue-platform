import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });
}

// Parâmetros scrypt (OWASP 2025): N=2^15, r=8, p=1 — nativo do Node, sem
// dependência binária. Formato versionado para permitir upgrade de algoritmo
// sem migração de dados (verificação lê os parâmetros do próprio hash).
const N = 2 ** 15;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
  return `scrypt$${N}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const derived = await scryptAsync(password, salt, expected.length, {
    N: cost,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
  return timingSafeEqual(derived, expected);
}
