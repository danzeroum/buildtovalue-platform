import type { AppConfig } from '@platform/config';
import type { RefreshTokenRow, TenantRow, UserRow } from '@platform/db';
import type { ApiDeps } from '../src/app.js';
/**
 * Fakes em memória dos repositórios (DIP): os testes da API exercitam rotas,
 * erros e auth SEM banco — o comportamento do banco real (RLS) tem teste
 * próprio em packages/db.
 */
export interface FakeState {
    tenants: TenantRow[];
    users: UserRow[];
    refreshTokens: (RefreshTokenRow & {
        revoked: boolean;
    })[];
}
export declare function fakeDeps(overrides?: Partial<AppConfig>): ApiDeps & {
    state: FakeState;
};
//# sourceMappingURL=fakes.d.ts.map