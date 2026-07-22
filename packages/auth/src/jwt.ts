import { jwtVerify, SignJWT } from 'jose';
import type { Role } from './rbac.js';

/**
 * Tokens da plataforma (F1.4): access curto + refresh opaco.
 * O ACCESS é JWT (HS256 na v1; assimétrico quando houver >1 emissor) com
 * claims mínimos. O REFRESH não é JWT: é um segredo opaco cujo HASH vive em
 * `refresh_tokens` (revogável por linha, D21-friendly) — aqui só o access.
 */
export interface AccessClaims {
  /** userId */
  sub: string;
  tenantId: string;
  role: Role;
}

export interface TokenPair {
  accessToken: string;
  expiresInSeconds: number;
}

export interface JwtOptions {
  secret: string;
  accessTtlSeconds: number;
  issuer?: string;
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

const encoder = new TextEncoder();

export async function signAccessToken(
  claims: AccessClaims,
  options: JwtOptions,
): Promise<TokenPair> {
  const accessToken = await new SignJWT({ tenantId: claims.tenantId, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(options.issuer ?? 'buildtovalue')
    .setIssuedAt()
    .setExpirationTime(`${options.accessTtlSeconds}s`)
    .sign(encoder.encode(options.secret));
  return { accessToken, expiresInSeconds: options.accessTtlSeconds };
}

export async function verifyAccessToken(
  token: string,
  options: JwtOptions,
): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(options.secret), {
      issuer: options.issuer ?? 'buildtovalue',
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.tenantId !== 'string' ||
      typeof payload.role !== 'string'
    ) {
      throw new InvalidTokenError('claims obrigatórios ausentes');
    }
    return { sub: payload.sub, tenantId: payload.tenantId, role: payload.role as Role };
  } catch (error) {
    if (error instanceof InvalidTokenError) throw error;
    throw new InvalidTokenError(`token inválido: ${(error as Error).message}`);
  }
}
