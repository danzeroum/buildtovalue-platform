import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api/client.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
  problemMessage: (b: unknown, f: string) =>
    (b as { detail?: string; title?: string })?.detail ?? (b as { title?: string })?.title ?? f,
}));

import { GateDetail, type GateTask } from '../src/routes/GateDetail.js';
import { api } from '../src/api/client.js';
import { ok, fail, route, resetRoutes } from './apiMock.js';
import { expectNoSeriousAxe } from './a11y.js';

/**
 * P1 — GATE de world-delta (AG-3.1, marcação do designer). Contratos do card:
 * consequência ACIMA do contrato · degrade honesto sem 3ª linha · peso ao
 * aprovar irreversível · sem permissão de revelar → ESCALAR (não aprovar às
 * cegas) · D28: a decisão reenvia a revisão que o card renderizou.
 */

const CLAIM = '33333333-3333-3333-3333-333333333333';

function makeTask(overrides: Partial<GateTask> = {}): GateTask {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    instanceId: '22222222-2222-2222-2222-222222222222',
    elementId: 'gate_pagamento',
    assignee: null,
    payload: {
      tool: 'erp.pagar',
      capability: 'Pagar fornecedor',
      effect: 'write-irreversible',
      authorization: 'gate',
      dataScope: 'Fornecedor ACME',
      evidenceRequired: 'recibo',
      processConsequence: null,
    },
    paramsMasked: true,
    paramsFields: ['valor', 'conta'],
    decisionOptions: ['aprovar', 'reprovar'],
    instanceRevision: 7,
    ...overrides,
  };
}

function seed(overrides: Record<string, () => ReturnType<typeof ok>> = {}) {
  route('POST /v1/user-tasks/{id}/claim', () => ok({ claimToken: CLAIM }));
  route('POST /v1/user-tasks/{id}/completion', () => ok({ instanceStatus: 'active' }));
  route('POST /v1/user-tasks/{id}/gate/reveal', () => ok({ params: { valor: 1200, conta: 'BR-9' } }));
  for (const [k, v] of Object.entries(overrides)) route(k, v);
}

/** Render helper: canWork/canReveal true por padrão (aprovador pleno); os testes
 *  de RBAC passam canReveal=false explicitamente. */
function renderGate(task: GateTask, opts: { canWork?: boolean; canReveal?: boolean } = {}) {
  return render(
    <GateDetail
      task={task}
      me="u1"
      canWork={opts.canWork ?? true}
      canReveal={opts.canReveal ?? true}
      onChanged={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetRoutes();
});

describe('GateDetail — P1 (AG-3.1)', () => {
  it('consequência vem ANTES do contrato no DOM (hierarquia do card)', () => {
    seed();
    const { container } = render(
      <GateDetail task={makeTask()} me="u1" canWork onChanged={() => {}} />,
    );
    const delta = container.querySelector('.gate-delta');
    const contract = container.querySelector('.gate-contract');
    expect(delta).toBeTruthy();
    expect(contract).toBeTruthy();
    // ordem no documento: a consequência precede o contrato técnico
    expect(delta!.compareDocumentPosition(contract!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('degrade honesto: processConsequence=null → legenda calma, sem "desconhecido"', () => {
    seed();
    renderGate(makeTask());
    expect(screen.getByText(/só as consequências desta ação/)).toBeInTheDocument();
    expect(screen.queryByText(/desconhecido/i)).not.toBeInTheDocument();
  });

  it('processConsequence presente substitui a legenda pela descrição do processo', () => {
    seed();
    const task = makeTask({
      payload: {
        ...makeTask().payload,
        processConsequence: { source: 'annotated', kind: 'branch', description: 'segue para conciliação' },
      },
    });
    renderGate(task);
    expect(screen.getByText(/segue para conciliação/)).toBeInTheDocument();
    expect(screen.queryByText(/só as consequências desta ação/)).not.toBeInTheDocument();
  });

  it('aprovar de efeito IRREVERSÍVEL exige confirmação de peso antes de enviar', async () => {
    seed();
    renderGate(makeTask());
    await userEvent.click(screen.getByRole('button', { name: 'Assumir este gate' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Aprovar' }));

    // primeiro clique NÃO envia: pede confirmação que nomeia o irreversível
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/não pode ser desfeito e roda agora/)).toBeInTheDocument();
    expect((api.POST as unknown as Mock).mock.calls.some((c) => c[0] === '/v1/user-tasks/{id}/completion')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Confirmar e aprovar' }));
    expect(await screen.findByText(/Gate aprovado/)).toBeInTheDocument();
  });

  it('efeito reversível aprova direto (sem peso)', async () => {
    seed();
    const task = makeTask({ payload: { ...makeTask().payload, effect: 'write-reversible' }, paramsMasked: false });
    renderGate(task);
    await userEvent.click(screen.getByRole('button', { name: 'Assumir este gate' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Aprovar' }));
    expect(await screen.findByText(/Gate aprovado/)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('D28: a decisão reenvia expectedInstanceRevision que o card renderizou', async () => {
    seed();
    renderGate(makeTask({ instanceRevision: 7 }));
    await userEvent.click(screen.getByRole('button', { name: 'Assumir este gate' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reprovar' }));
    await waitFor(() =>
      expect((api.POST as unknown as Mock).mock.calls.some((c) => c[0] === '/v1/user-tasks/{id}/completion')).toBe(true),
    );
    const call = (api.POST as unknown as Mock).mock.calls.find((c) => c[0] === '/v1/user-tasks/{id}/completion');
    expect(call?.[1]?.body?.expectedInstanceRevision).toBe(7);
    expect(call?.[1]?.body?.decision).toBe('reprovar');
  });

  it('completion 409 (proposta expirou) → banner ÂMBAR e devolve o claim', async () => {
    seed({
      'POST /v1/user-tasks/{id}/completion': () =>
        fail(409, { detail: 'revisão avançou' }) as ReturnType<typeof ok>,
    });
    renderGate(makeTask());
    await userEvent.click(screen.getByRole('button', { name: 'Assumir este gate' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reprovar' }));
    const banner = await screen.findByText(/revisão avançou/);
    expect(banner.closest('.gate-banner')).toHaveClass('tone-warn');
    // claim devolvido: volta a oferecer «Assumir»
    expect(await screen.findByRole('button', { name: 'Assumir este gate' })).toBeInTheDocument();
  });

  it('§5: aprovador SEM permissão de revelar (RBAC) — ação AUSENTE, escalar à vista SEM clique', () => {
    seed();
    renderGate(makeTask(), { canReveal: false });
    // a ação de revelar NEM APARECE — o motivo já está à vista, ESCALAR disponível.
    expect(screen.queryByRole('button', { name: /Revelar dados sensíveis/ })).not.toBeInTheDocument();
    expect(screen.getByText(/não aprove às cegas/)).toBeInTheDocument();
    expect(screen.getByText(/Escalar/)).toBeInTheDocument();
  });

  it('§5 (defesa em profundidade): 403 do servidor cai no MESMO estado de escalar', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('preciso conferir o valor');
    seed({
      'POST /v1/user-tasks/{id}/gate/reveal': () => fail(403, { title: 'sem escopo' }) as ReturnType<typeof ok>,
    });
    // espelho de UX diz que pode (canReveal), mas o guarda real recusa → escalar.
    renderGate(makeTask());
    await userEvent.click(screen.getByRole('button', { name: /Revelar dados sensíveis/ }));
    expect(await screen.findByText(/não aprove às cegas/)).toBeInTheDocument();
    expect(screen.getByText(/Escalar/)).toBeInTheDocument();
  });

  it('revelar COM permissão mostra os campos (via rota auditada, com motivo)', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('conferência de teto');
    seed();
    renderGate(makeTask());
    await userEvent.click(screen.getByRole('button', { name: /Revelar dados sensíveis/ }));
    expect(await screen.findByText(/BR-9/)).toBeInTheDocument();
    const call = (api.POST as unknown as Mock).mock.calls.find((c) => c[0] === '/v1/user-tasks/{id}/gate/reveal');
    expect(call?.[1]?.body?.reason).toBe('conferência de teto');
  });

  it('mascarado: mostra a CONTAGEM de campos sensíveis sem os valores', () => {
    seed();
    renderGate(makeTask());
    expect(screen.getByText(/2 campo\(s\) sensível\(is\)/)).toBeInTheDocument();
    // nenhum valor sensível vaza antes de revelar
    expect(screen.queryByText(/BR-9/)).not.toBeInTheDocument();
  });

  it('sem tasks:work: «Assumir» desabilitado (somente leitura)', () => {
    seed();
    renderGate(makeTask(), { canWork: false });
    expect(screen.getByRole('button', { name: 'Assumir este gate' })).toBeDisabled();
  });

  it('a11y: sem violações serious/critical (card + confirmação de peso)', async () => {
    seed();
    const { container } = renderGate(makeTask());
    await userEvent.click(screen.getByRole('button', { name: 'Assumir este gate' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Aprovar' }));
    await screen.findByRole('alertdialog');
    await expectNoSeriousAxe(container);
  });
});
