export function fakeDeps(overrides = {}) {
    const state = { tenants: [], users: [], refreshTokens: [] };
    const users = {
        async findTenantBySlug(slug) {
            return state.tenants.find((t) => t.slug === slug);
        },
        async findByEmail(tenantId, email) {
            return state.users.find((u) => u.tenant_id === tenantId && u.email.toLowerCase() === email.toLowerCase());
        },
        async findById(tenantId, id) {
            return state.users.find((u) => u.tenant_id === tenantId && u.id === id);
        },
    };
    const refreshTokens = {
        async create(tenantId, userId, tokenHash, expiresAt) {
            state.refreshTokens.push({
                id: `rt-${state.refreshTokens.length + 1}`,
                tenant_id: tenantId,
                user_id: userId,
                token_hash: tokenHash,
                expires_at: expiresAt,
                revoked_at: null,
                revoked: false,
            });
        },
        async findByHash(tenantId, tokenHash) {
            return state.refreshTokens.find((r) => r.tenant_id === tenantId && r.token_hash === tokenHash);
        },
        async revoke(tenantId, id) {
            const row = state.refreshTokens.find((r) => r.tenant_id === tenantId && r.id === id);
            if (row) {
                row.revoked = true;
                row.revoked_at = new Date();
            }
        },
    };
    const config = {
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
//# sourceMappingURL=fakes.js.map