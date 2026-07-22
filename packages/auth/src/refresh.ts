import { createHash, randomBytes } from 'node:crypto';

/**
 * Refresh token OPACO: 256 bits aleatórios em base64url. No banco vive só o
 * SHA-256 (vazamento de banco não vira sessão); o valor cru vai uma única vez
 * ao cliente. Rotação: cada uso emite um novo e revoga o anterior (F1.5).
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
