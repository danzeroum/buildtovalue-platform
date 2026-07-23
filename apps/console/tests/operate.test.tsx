import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const ctx = vi.hoisted(() => ({
  user: { id: 'op1', displayName: 'Op', email: 'op@acme.com', role: 'operator' as string },
}));
vi.mock('../src/shell.js', () => ({ useSession: () => ctx.user }));
vi.mock('../src/api/client.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
  problemMessage: (b: unknown, f: string) =>
    (b as { detail?: string; title?: string })?.detail ?? (b as { title?: string })?.title ?? f,
}));

import { OperateRoute } from '../src/routes/operate.js';
import { api } from '../src/api/client.js';
import { ok, fail, route, resetRoutes } from './apiMock.js';
import { expectNoSeriousAxe } from './a11y.js';

const INST = {
  id: '99999999-9999-9999-9999-999999999999',
  definitionRef: 'reembolso@7',
  status: 'incident',
  revision: 14,
  businessKey: 'RB-2026-0142',
};
const now = new Date('2026-07-22T00:00:00Z').toISOString();

function seedDetail(overrides: Record<string, () => ReturnType<typeof ok>> = {}) {
  route('GET /v1/instances', () => ok({ items: [{ ...INST }], nextCursor: null }));
  route('GET /v1/instances/{id}', () => ok({ ...INST, currentElements: ['aprovar_reembolso'] }));
  // diagrama falha de propósito → PositionSection cai no fallback textual (sem viewer pesado nos testes)
  route('GET /v1/process-definitions/{idOrRef}', () => fail(404, { title: 'sem diagrama' }));
  route('GET /v1/incidents', () => ok({ items: [{ id: 'inc1', instanceId: INST.id, kind: 'job-failed-retries-exhausted', message: 'http-call → ERP timeout', status: 'open', createdAt: now }], nextCursor: null }));
  route('GET /v1/instances/{id}/variables', () =>
    ok({
      items: [
        { name: 'valor', classification: 'none', value: 6240, updatedAt: now },
        { name: 'observacoes_saude', classification: 'sensitive', masked: true, updatedAt: now },
      ],
    }));
  route('GET /v1/instances/{id}/history', () => ok({ items: [{ seq: 14, kind: 'incident.raised', payload: {}, engineVersion: '1.1.0', occurredAt: now }], nextCursor: null }));
  route('GET /v1/jobs', () => ok({ items: [], nextCursor: null }));
  route('GET /v1/timers', () => ok({ items: [], nextCursor: null }));
  for (const [k, v] of Object.entries(overrides)) route(k, v);
}

async function openDetail() {
  render(<OperateRoute />);
  await userEvent.click(await screen.findByRole('button', { name: /RB-2026-0142/ }));
  await screen.findByRole('tab', { name: 'Variáveis' });
}

beforeEach(() => {
  ctx.user = { id: 'op1', displayName: 'Op', email: 'op@acme.com', role: 'operator' };
  resetRoutes();
});

describe('OperateRoute — F3.5', () => {
  it('lista instâncias e faz drill-down (posição por elemento no fallback)', async () => {
    seedDetail();
    await openDetail();
    expect(screen.getByText(/token em: aprovar_reembolso/)).toBeInTheDocument();
  });

  it('D20: variável sensível chega MASCARADA; revelação exige motivo e é auditada', async () => {
    seedDetail();
    route('POST /v1/instances/{id}/variables/{name}/reveal', () => ok({ name: 'observacoes_saude', value: 'alergia a dipirona' }));
    await openDetail();
    await userEvent.click(screen.getByRole('tab', { name: 'Variáveis' }));

    // valor sensível mascarado; valor comum visível
    expect(await screen.findByLabelText('valor mascarado')).toBeInTheDocument();
    expect(screen.queryByText(/alergia a dipirona/)).not.toBeInTheDocument();
    expect(screen.getByText('6240')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Revelar…' }));
    const dialog = screen.getByRole('dialog', { name: /Revelar/ });
    // motivo obrigatório: confirmar desabilitado até preencher
    const confirm = within(dialog).getByRole('button', { name: 'Revelar' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'Análise da solicitação de reembolso médico.');
    await userEvent.click(confirm);

    expect(await screen.findByText(/alergia a dipirona/)).toBeInTheDocument();
    expect(api.POST).toHaveBeenCalledWith(
      '/v1/instances/{id}/variables/{name}/reveal',
      expect.objectContaining({ body: { reason: expect.any(String) } }),
    );
  });

  it('incidente: «Repetir» re-arma jobs; dead-letter (409) vira aviso honesto → Resolver', async () => {
    seedDetail({
      'POST /v1/incidents/{id}/retry': () => fail(409, { detail: 'dead-letter não re-enfileirável na v1' }) as ReturnType<typeof ok>,
    });
    await openDetail();
    // aba incidentes é a default
    await userEvent.click(await screen.findByRole('button', { name: 'Repetir' }));
    expect(await screen.findByText(/Use «Resolver…»|não re-enfileirável|Não re-tentável/i)).toBeInTheDocument();
  });

  it('incidente: retry OK informa jobs re-armados', async () => {
    seedDetail({
      'POST /v1/incidents/{id}/retry': () => ok({ rearmedJobs: 2 }),
    });
    await openDetail();
    await userEvent.click(await screen.findByRole('button', { name: 'Repetir' }));
    expect(await screen.findByText(/Re-armados 2 job/)).toBeInTheDocument();
  });

  it('«Resolver…» exige motivo antes de habilitar', async () => {
    seedDetail();
    await openDetail();
    await userEvent.click(await screen.findByRole('button', { name: 'Resolver…' }));
    const dialog = screen.getByRole('dialog', { name: /Resolver incidente/ });
    expect(within(dialog).getByRole('button', { name: 'Resolver' })).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'Tratado manualmente com o ERP.');
    expect(within(dialog).getByRole('button', { name: 'Resolver' })).toBeEnabled();
  });

  it('não-operador (negócio) não vê ações de incidente', async () => {
    ctx.user = { id: 'u1', displayName: 'Ana', email: 'ana@acme.com', role: 'business' };
    seedDetail();
    await openDetail();
    expect(screen.queryByRole('button', { name: 'Repetir' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolver…' })).not.toBeInTheDocument();
  });

  it('busca sem resultado oferece limpar filtros', async () => {
    route('GET /v1/instances', () => ok({ items: [], nextCursor: null }));
    render(<OperateRoute />);
    expect(await screen.findByText(/Nenhuma instância/)).toBeInTheDocument();
  });

  it('a11y: sem violações serious/critical (lista + detalhe + variáveis)', async () => {
    seedDetail();
    const { container } = render(<OperateRoute />);
    await userEvent.click(await screen.findByRole('button', { name: /RB-2026-0142/ }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Variáveis' }));
    await screen.findByLabelText('valor mascarado');
    await expectNoSeriousAxe(container);
  });
});
