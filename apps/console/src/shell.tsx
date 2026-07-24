import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { KillSwitchBannerContainer } from './killSwitchBanner.js';
import { Button } from './ui/ui.js';
import { clearSession, currentUser, login, refresh, storedRefreshToken, useSession } from './session.js';

// reexportado por compatibilidade — quem já importava `useSession` daqui segue
// funcionando; a implementação vive em `session.ts` (evita ciclo com o banner).
export { useSession } from './session.js';

/**
 * Navegação D23: RÓTULO HUMANO primário, na ordem da persona de negócio
 * (Tarefas primeiro); a rota literal vira sublabel mono discreta (decisão A
 * do parecer). Chrome idêntico em toda rota (D15 — Console único).
 */
const NAV = [
  { to: '/tasks', label: 'Tarefas', route: '/tasks' },
  { to: '/forms', label: 'Formulários', route: '/forms' },
  { to: '/operate', label: 'Operação', route: '/operate' },
  { to: '/studio', label: 'Estúdio', route: '/studio' },
] as const;

/** Porta de sessão: sem usuário → login. Tenta refresh silencioso ao montar. */
export function AppShell() {
  const user = useSession();
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    if (currentUser()) {
      setBooting(false);
      return;
    }
    if (storedRefreshToken()) {
      void refresh().finally(() => setBooting(false));
    } else {
      setBooting(false);
    }
  }, []);

  if (booting) {
    return (
      <div className="shell-boot" aria-busy="true">
        Iniciando…
      </div>
    );
  }
  if (!user) return <LoginScreen />;

  return (
    <div className="shell">
      {/* G-UX-3 (marcação do banner §6): PRIMEIRO no DOM — antes da navegação —
          para que quem chega no meio da emergência (leitor de tela) seja
          informado antes de tudo. Visualmente fica ABAIXO do header via
          `order` (CSS) — o header também usa `order`, então a ordem de leitura
          (DOM) e a ordem visual divergem de propósito, só aqui. */}
      <KillSwitchBannerContainer />
      <header className="shell-header">
        <span className="brand">BUILDTOVALUE</span>
        <nav aria-label="Navegação principal">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className="nav-item">
              <span className="nav-label">{item.label}</span>
              <span className="nav-route">{item.route}</span>
            </NavLink>
          ))}
        </nav>
        <div className="shell-user">
          <span className="user-name">{user.displayName}</span>
          <span className="user-role" data-role={user.role}>
            {user.role}
          </span>
          <Button intent="neutral" onClick={() => clearSession()} aria-label="Sair">
            Sair
          </Button>
        </div>
      </header>
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}

function LoginScreen() {
  const [tenant, setTenant] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login({ tenant, email, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no login');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit} aria-label="Entrar">
        <span className="brand">BUILDTOVALUE</span>
        <label className="field">
          <span>Organização</span>
          <input value={tenant} onChange={(e) => setTenant(e.target.value)} autoComplete="organization" required />
        </label>
        <label className="field">
          <span>E-mail</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label className="field">
          <span>Senha</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <p className="login-error" role="alert" aria-live="assertive">
            {error}
          </p>
        )}
        <button type="submit" className="ui-btn" data-intent="primary" aria-busy={busy || undefined} disabled={busy}>
          Entrar
        </button>
      </form>
    </div>
  );
}
