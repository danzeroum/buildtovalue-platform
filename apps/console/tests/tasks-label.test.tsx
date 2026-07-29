import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TasksRoute } from '../src/routes/tasks.js';
import { ok, route, resetRoutes } from './apiMock.js';

// Ana, papel de negócio — é a persona de quem o rótulo importa.
const ctx = vi.hoisted(() => ({
  user: { id: 'u1', displayName: 'Ana', email: 'ana@acme.test', role: 'business' as string },
}));
vi.mock('../src/shell.js', () => ({ useSession: () => ctx.user }));
vi.mock('../src/api/client.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
  problemMessage: (b: unknown, f: string) =>
    (b as { detail?: string; title?: string })?.detail ?? (b as { title?: string })?.title ?? f,
}));

const BASE = {
  instanceId: '22222222-2222-2222-2222-222222222222',
  formRef: 'reembolso@1',
  assignee: null as string | null,
  candidateRoles: ['business'],
  status: 'open',
  claimedAt: null as string | null,
  createdAt: new Date('2026-07-28T00:00:00Z').toISOString(),
  isGate: false,
  gate: null,
};

/** Rotulada, sem rótulo (pré-migração ou elemento sem name), e rótulo hostil. */
const ROTULADA = { ...BASE, id: '11111111-1111-1111-1111-111111111111', elementId: 't1', elementLabel: 'Etapa 1' };
const SEM_ROTULO = { ...BASE, id: '44444444-4444-4444-4444-444444444444', elementId: 't2', elementLabel: null };
const HOSTIL = {
  ...BASE,
  id: '55555555-5555-5555-5555-555555555555',
  elementId: 'xss',
  elementLabel: '<script>alert("xss")</script>',
};
const APROVAR = { ...BASE, id: '66666666-6666-6666-6666-666666666666', elementId: 'ap', elementLabel: 'Aprovar pedido' };

function seed(items: unknown[]) {
  route('GET /v1/user-tasks', () => ok({ items, nextCursor: null }));
  route('GET /v1/startable-definitions', () => ok({ items: [] }));
}

beforeEach(() => resetRoutes());
afterEach(() => vi.clearAllMocks());

describe('Tasklist — rótulo humano pinado (0022)', () => {
  it('exibe o rótulo como título e o element_id como metadado', async () => {
    seed([ROTULADA]);
    render(<TasksRoute />);
    await waitFor(() => expect(screen.getByText('Etapa 1')).toBeInTheDocument());
    // o id não some — vira o secundário (quem opera o modelo ainda precisa dele)
    expect(screen.getByText('t1')).toBeInTheDocument();
  });

  it('sem rótulo, cai para o element_id — e NÃO repete o id como metadado', async () => {
    seed([SEM_ROTULO]);
    render(<TasksRoute />);
    await waitFor(() => expect(screen.getByText('t2')).toBeInTheDocument());
    // uma única ocorrência: o id é o título, repeti-lo abaixo seria ruído
    expect(screen.getAllByText('t2')).toHaveLength(1);
  });

  it('tarefa anterior à migração (elementLabel ausente do payload) continua listada', async () => {
    const { elementLabel: _omitido, ...semCampo } = ROTULADA;
    seed([semCampo]);
    render(<TasksRoute />);
    await waitFor(() => expect(screen.getByText('t1')).toBeInTheDocument());
  });

  it('rótulo hostil aparece como TEXTO literal, sem executar', async () => {
    const alerta = vi.spyOn(window, 'alert').mockImplementation(() => {});
    seed([HOSTIL]);
    render(<TasksRoute />);
    await waitFor(() => expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument());
    expect(document.querySelector('script')).toBeNull();
    expect(alerta).not.toHaveBeenCalled();
    alerta.mockRestore();
  });

  it('busca acha pelo rótulo — e continua achando pelo id', async () => {
    seed([APROVAR, SEM_ROTULO]);
    render(<TasksRoute />);
    await waitFor(() => expect(screen.getByText('Aprovar pedido')).toBeInTheDocument());
    const busca = screen.getByLabelText('Buscar tarefa');

    await userEvent.type(busca, 'Aprovar');
    await waitFor(() => expect(screen.queryByText('t2')).not.toBeInTheDocument());
    expect(screen.getByText('Aprovar pedido')).toBeInTheDocument();

    await userEvent.clear(busca);
    await userEvent.type(busca, 't2');
    await waitFor(() => expect(screen.queryByText('Aprovar pedido')).not.toBeInTheDocument());
    expect(screen.getByText('t2')).toBeInTheDocument();
  });
});
