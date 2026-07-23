import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const ctx = vi.hoisted(() => ({
  user: { id: 'u1', displayName: 'Ana', email: 'ana@acme.com', role: 'business' as string },
}));
vi.mock('../src/shell.js', () => ({ useSession: () => ctx.user }));
vi.mock('../src/api/client.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
  problemMessage: (b: unknown, f: string) =>
    (b as { detail?: string; title?: string })?.detail ?? (b as { title?: string })?.title ?? f,
}));

import { TasksRoute } from '../src/routes/tasks.js';
import { api } from '../src/api/client.js';
import { ok, fail, route, resetRoutes } from './apiMock.js';
import { expectNoSeriousAxe } from './a11y.js';

const TASK = {
  id: '11111111-1111-1111-1111-111111111111',
  instanceId: '22222222-2222-2222-2222-222222222222',
  elementId: 'aprovar_reembolso',
  formRef: 'reembolso@3',
  assignee: null as string | null,
  candidateRoles: ['business'],
  status: 'open',
  claimedAt: null as string | null,
  createdAt: new Date('2026-07-20T00:00:00Z').toISOString(),
};
const SCHEMA = {
  formId: 'reembolso',
  version: 3,
  title: 'Reembolso — aprovação',
  fields: [{ key: 'parecer', label: 'Parecer', type: 'text', dataClassification: 'internal', required: true }],
};

function seedHappyPath(overrides: Record<string, () => ReturnType<typeof ok>> = {}) {
  route('GET /v1/user-tasks', () => ok({ items: [TASK], nextCursor: null }));
  route('GET /v1/user-tasks/{id}', () => ok({ ...TASK, payload: {} }));
  route('GET /v1/form-definitions/{ref}', () => ok({ id: 'f1', formId: 'reembolso', version: 3, ref: 'reembolso@3', createdAt: TASK.createdAt, schema: SCHEMA }));
  route('POST /v1/user-tasks/{id}/claim', () => ok({ claimToken: '33333333-3333-3333-3333-333333333333' }));
  route('POST /v1/user-tasks/{id}/completion', () => ok({ instanceStatus: 'active' }));
  for (const [k, v] of Object.entries(overrides)) route(k, v);
}

beforeEach(() => {
  ctx.user = { id: 'u1', displayName: 'Ana', email: 'ana@acme.com', role: 'business' };
  resetRoutes();
});

describe('TasksRoute — F3.4', () => {
  it('claim → token → formulário habilita → conclusão avança a instância', async () => {
    seedHappyPath();
    render(<TasksRoute />);

    await userEvent.click(await screen.findByRole('button', { name: /aprovar_reembolso/ }));
    // antes de assumir: o campo está desabilitado e a ação é «Assumir tarefa»
    const parecer = await screen.findByLabelText(/Parecer/);
    expect(parecer).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Assumir tarefa' }));
    await waitFor(() => expect(parecer).toBeEnabled());

    await userEvent.type(parecer, 'Aprovado dentro do teto.');
    await userEvent.click(screen.getByRole('button', { name: 'Concluir tarefa' }));

    expect(await screen.findByText(/Tarefa concluída/)).toBeInTheDocument();
    expect(api.POST).toHaveBeenCalledWith(
      '/v1/user-tasks/{id}/completion',
      expect.objectContaining({ body: expect.objectContaining({ claimToken: expect.any(String) }) }),
    );
  });

  it('422 do servidor mapeia erro por campo no MESMO renderer', async () => {
    seedHappyPath({
      'POST /v1/user-tasks/{id}/completion': () => fail(422, { errors: { parecer: ['valor não atende à validação'] } }) as ReturnType<typeof ok>,
    });
    render(<TasksRoute />);
    await userEvent.click(await screen.findByRole('button', { name: /aprovar_reembolso/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Assumir tarefa' }));
    const parecer = await screen.findByLabelText(/Parecer/);
    await userEvent.type(parecer, 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Concluir tarefa' }));
    expect(await screen.findByText(/valor não atende à validação/)).toBeInTheDocument();
    expect(screen.queryByText(/Tarefa concluída/)).not.toBeInTheDocument();
  });

  it('claim 409 mostra o detentor (com {user} desde …)', async () => {
    seedHappyPath({
      'POST /v1/user-tasks/{id}/claim': () =>
        fail(409, { detail: 'Task já reivindicada', holder: { user: 'Bruno', since: new Date('2026-07-21T00:00:00Z').toISOString() } }) as ReturnType<typeof ok>,
    });
    render(<TasksRoute />);
    await userEvent.click(await screen.findByRole('button', { name: /aprovar_reembolso/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Assumir tarefa' }));
    expect(await screen.findByText(/Bruno/)).toBeInTheDocument();
  });

  it('«Reatribuir…» é gated por operate:act — operador vê, negócio não', async () => {
    seedHappyPath();
    ctx.user = { id: 'u1', displayName: 'Op', email: 'op@acme.com', role: 'operator' };
    const view = render(<TasksRoute />);
    await userEvent.click(await screen.findByRole('button', { name: /aprovar_reembolso/ }));
    expect(await screen.findByRole('button', { name: 'Reatribuir…' })).toBeInTheDocument();

    // re-render como negócio: sem Reatribuir
    ctx.user = { id: 'u1', displayName: 'Ana', email: 'ana@acme.com', role: 'business' };
    view.unmount();
    render(<TasksRoute />);
    await userEvent.click(await screen.findByRole('button', { name: /aprovar_reembolso/ }));
    await screen.findByLabelText(/Parecer/);
    expect(screen.queryByRole('button', { name: 'Reatribuir…' })).not.toBeInTheDocument();
  });

  it('D3: micro-afordância «por que reembolso@3?» revela a explicação', async () => {
    seedHappyPath();
    render(<TasksRoute />);
    await userEvent.click(await screen.findByRole('button', { name: /aprovar_reembolso/ }));
    const why = await screen.findByRole('button', { name: /por que reembolso@3/ });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await userEvent.click(why);
    expect(screen.getByRole('note')).toHaveTextContent(/versões novas valem só para instâncias futuras/);
  });

  it('sem tasks:work (operador) a tarefa é SOMENTE LEITURA — sem «Assumir»', async () => {
    seedHappyPath();
    ctx.user = { id: 'op1', displayName: 'Op', email: 'op@acme.com', role: 'operator' };
    render(<TasksRoute />);
    await userEvent.click(await screen.findByRole('button', { name: /aprovar_reembolso/ }));
    await screen.findByLabelText(/Parecer/);
    expect(screen.getByText(/somente leitura/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assumir tarefa' })).not.toBeInTheDocument();
  });

  it('Iniciar processo: POST /v1/instances com Idempotency-Key (anti clique-duplo)', async () => {
    seedHappyPath();
    // analista tem instances:start E definitions:read (persona que completa o fluxo)
    ctx.user = { id: 'an1', displayName: 'Nara', email: 'nara@acme.com', role: 'analyst' };
    route('GET /v1/process-definitions', () => ok({ items: [{ id: 'p1', name: 'Reembolso de despesas', version: 8, registryRef: 'reembolso-de-despesas@8', engineVersion: '1.1.0', createdAt: TASK.createdAt }], nextCursor: null }));
    route('POST /v1/instances', () => ok({ id: '44444444-4444-4444-4444-444444444444', definitionRef: 'reembolso-de-despesas@8', status: 'active', revision: 0, businessKey: null }, 201));
    render(<TasksRoute />);

    await userEvent.click(await screen.findByRole('button', { name: /Iniciar processo/ }));
    await userEvent.click(await screen.findByRole('radio', { name: /Reembolso de despesas/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar instância' }));

    await waitFor(() => expect(api.POST).toHaveBeenCalledWith('/v1/instances', expect.anything()));
    const call = (api.POST as unknown as Mock).mock.calls.find((c) => c[0] === '/v1/instances');
    expect(call?.[1]?.headers?.['idempotency-key']).toBeTruthy();
    expect(await screen.findByText(/criada/)).toBeInTheDocument();
  });

  it('«Iniciar processo» exige instances:start E definitions:read (business não vê — evita beco)', async () => {
    seedHappyPath();
    render(<TasksRoute />); // business: tem start, NÃO tem definitions:read
    await screen.findByRole('button', { name: /aprovar_reembolso/ });
    expect(screen.queryByRole('button', { name: /Iniciar processo/ })).not.toBeInTheDocument();
  });

  it('lista vazia (primeiro dia) oferece «ver tarefas do meu papel»', async () => {
    route('GET /v1/user-tasks', () => ok({ items: [], nextCursor: null }));
    render(<TasksRoute />);
    expect(await screen.findByText(/Nenhuma tarefa para você/)).toBeInTheDocument();
  });

  it('a11y: sem violações serious/critical (lista + detalhe assumido)', async () => {
    seedHappyPath();
    const { container } = render(<TasksRoute />);
    await userEvent.click(await screen.findByRole('button', { name: /aprovar_reembolso/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Assumir tarefa' }));
    await screen.findByRole('button', { name: 'Concluir tarefa' });
    await expectNoSeriousAxe(container);
  });
});
