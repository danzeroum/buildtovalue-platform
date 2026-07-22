import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from './api/client.js';

/** Navegação D23: rótulo humano primário; rota mono discreta como sublabel. */
const NAV = [
  { to: '/tasks', label: 'Tarefas', route: '/tasks' },
  { to: '/forms', label: 'Formulários', route: '/forms' },
  { to: '/operate', label: 'Operação', route: '/operate' },
  { to: '/studio', label: 'Estúdio', route: '/studio' },
] as const;

export function AppShell() {
  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">BuildToValue</span>
        <nav aria-label="Navegação principal">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className="nav-item">
              <span>{item.label}</span>
              <span className="nav-route">{item.route}</span>
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}

export function PlaceholderRoute({ title }: { title: string }) {
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  useEffect(() => {
    // Exercita o SDK tipado desde a F1 (a rota /v1/me exige auth → 401 = API viva).
    api
      .GET('/v1/me')
      .then(({ response }) => setApiUp(response.status < 500))
      .catch(() => setApiUp(false));
  }, []);
  return (
    <section>
      <h1>{title}</h1>
      <p>Esta tela chega na F3 (protótipos aprovados pelo designer da plataforma).</p>
      <p className="api-status" data-status={apiUp === null ? 'loading' : apiUp ? 'ok' : 'down'}>
        {apiUp === null ? 'Verificando API…' : apiUp ? 'API conectada' : 'API indisponível'}
      </p>
    </section>
  );
}
