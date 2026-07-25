import type { AppConfig } from '@platform/config';
import type {
  RefreshTokenRepository,
  RefreshTokenRow,
  TenantRow,
  UserAuthState,
  UserRepository,
  UserRow,
} from '@platform/db';
import type { ApiDeps } from '../app.js';

/**
 * Fakes em memória dos repositórios (DIP): os testes da API exercitam rotas,
 * erros e auth SEM banco — o comportamento do banco real (RLS) tem teste
 * próprio em packages/db.
 */
export interface FakeState {
  tenants: TenantRow[];
  users: UserRow[];
  refreshTokens: (RefreshTokenRow & { revoked: boolean })[];
}

export function fakeDeps(overrides: Partial<AppConfig> = {}): ApiDeps & { state: FakeState } {
  const state: FakeState = { tenants: [], users: [], refreshTokens: [] };

  const users: UserRepository = {
    async findTenantBySlug(slug) {
      return state.tenants.find((t) => t.slug === slug);
    },
    async findByEmail(tenantId, email) {
      return state.users.find(
        (u) => u.tenant_id === tenantId && u.email.toLowerCase() === email.toLowerCase(),
      );
    },
    async findById(tenantId, id) {
      return state.users.find((u) => u.tenant_id === tenantId && u.id === id);
    },
    async getAuthState(tenantId, id): Promise<UserAuthState | undefined> {
      const user = state.users.find((u) => u.tenant_id === tenantId && u.id === id);
      return user ? { active: user.active, mustChangePassword: user.must_change_password } : undefined;
    },
  };

  const refreshTokens: RefreshTokenRepository = {
    async create(tenantId, userId, tokenHash, expiresAt) {
      const id = `rt-${state.refreshTokens.length + 1}`;
      state.refreshTokens.push({
        id,
        tenant_id: tenantId,
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        revoked_at: null,
        revoked: false,
      });
      return id;
    },
    async findByHash(tenantId, tokenHash) {
      return state.refreshTokens.find(
        (r) => r.tenant_id === tenantId && r.token_hash === tokenHash,
      );
    },
    async revoke(tenantId, id) {
      const row = state.refreshTokens.find((r) => r.tenant_id === tenantId && r.id === id);
      if (row) {
        row.revoked = true;
        row.revoked_at = new Date();
      }
    },
    async revokeAllForUser(tenantId, userId, exceptId) {
      for (const row of state.refreshTokens) {
        if (row.tenant_id === tenantId && row.user_id === userId && !row.revoked && row.id !== exceptId) {
          row.revoked = true;
          row.revoked_at = new Date();
        }
      }
    },
  };

  const config: AppConfig = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    API_PORT: 0,
    API_HOST: '127.0.0.1',
    RATE_LIMIT_MAX: 120,
    DATABASE_URL: 'postgres://fake:fake@localhost:5432/fake',
    DATABASE_MIGRATION_URL: undefined,
    JWT_SECRET: 'test-secret-test-secret-test-secret!',
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 3600,
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    OTEL_SERVICE_NAME: 'test',
    ...overrides,
  };

  return { config, users, refreshTokens, dbReady: async () => true, state };
}
