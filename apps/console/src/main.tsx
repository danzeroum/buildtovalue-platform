import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import '@platform/shared-ui/tokens.css';
import './app.css';
import { AppShell } from './shell.js';
import { FormsRoute } from './routes/forms.js';
import { StudioRoute } from './routes/studio.js';
import { NonIdeal } from './ui/ui.js';

/**
 * Console único (D15): 4 rotas técnicas na URL, RÓTULOS HUMANOS na navegação
 * (D23). PR1 entrega Estúdio (F3.2) e Formulários (F3.3); Tarefas (F3.4) e
 * Operação (F3.5) chegam na PR2.
 */
function ComingSoon({ title }: { title: string }) {
  return (
    <section className="route" aria-label={title}>
      <NonIdeal kind="empty" title={title} detail="Esta rota chega na PR2 desta leva (Tarefas/Operação)." />
    </section>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/tasks" replace /> },
      { path: 'tasks', element: <ComingSoon title="Tarefas" /> },
      { path: 'forms', element: <FormsRoute /> },
      { path: 'operate', element: <ComingSoon title="Operação" /> },
      { path: 'studio', element: <StudioRoute /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
