import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import '@platform/shared-ui/tokens.css';
import './app.css';
import { AppShell } from './shell.js';
import { FormsRoute } from './routes/forms.js';
import { StudioRoute } from './routes/studio.js';
import { TasksRoute } from './routes/tasks.js';
import { OperateRoute } from './routes/operate.js';

/**
 * Console único (D15): 4 rotas técnicas na URL, RÓTULOS HUMANOS na navegação
 * (D23). Estúdio (F3.2), Formulários (F3.3), Tarefas (F3.4) e Operação (F3.5).
 */
const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/tasks" replace /> },
      { path: 'tasks', element: <TasksRoute /> },
      { path: 'forms', element: <FormsRoute /> },
      { path: 'operate', element: <OperateRoute /> },
      { path: 'studio', element: <StudioRoute /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
