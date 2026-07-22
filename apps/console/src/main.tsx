import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import '@platform/shared-ui/tokens.css';
import './app.css';
import { AppShell, PlaceholderRoute } from './shell.js';

/**
 * Console único (D15): 4 rotas técnicas na URL, RÓTULOS HUMANOS na navegação
 * (D23): Tarefas · Formulários · Operação · Estúdio. As telas reais chegam na
 * F3 (protótipos aprovados + G-UX-3); os placeholders mantêm o roteamento e o
 * SDK compilando desde a F1.
 */
const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <PlaceholderRoute title="Tarefas" /> },
      { path: 'tasks', element: <PlaceholderRoute title="Tarefas" /> },
      { path: 'forms', element: <PlaceholderRoute title="Formulários" /> },
      { path: 'operate', element: <PlaceholderRoute title="Operação" /> },
      { path: 'studio', element: <PlaceholderRoute title="Estúdio" /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
