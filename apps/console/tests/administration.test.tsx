import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const ctx = vi.hoisted(() => ({
  user: { id: 'dpo1', displayName: 'DPO', email: 'dpo@acme.com', role: 'admin' as string },
}));
vi.mock('../src/shell.js', () => ({ useSession: () => ctx.user }));
vi.mock('../src/api/client.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
  problemMessage: (b: unknown, f: string) =>
    (b as { detail?: string; title?: string })?.detail ?? (b as { title?: string })?.title ?? f,
}));

import { AdministrationRoute } from '../src/routes/Administration.js';
import { ok, fail, route, resetRoutes } from './apiMock.js';
import { expectNoSeriousAxe } from './a11y.js';

const RECEIPT = {
  digest: 'sha256:9f2cabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123',
  algorithm: 'sha256' as const,
  count: 3412,
  filters: { from: '2026-06-24T00:00:00.000Z', to: '2026-07-24T14:22:10.000Z', source: 'both' as const },
  anchorRef: 'sha256:9f2cabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123;from=2026-06-24T00:00:00.000Z;to=2026-07-24T14:22:10.000Z',
  assurance: 'self-recorded' as const,
  assuranceNote: 'Digest e âncora gravados pela própria plataforma no evento audit.export; ainda não há notarização externa/WAL imutável (infra do Gate de Piloto).',
  coverage: {
    perTrail: {
      tenant: { throughXid: '100:1', throughTime: '2026-07-24T14:20:00.000Z' },
      instance: { throughXid: null, throughTime: null },
    },
    unanchoredCount: 0,
    note: 'todas as linhas deste export estão dentro da cobertura ancorada',
  },
  generatedAt: '2026-07-24T14:22:10.000Z',
  generatedBy: { type: 'user' as const, id: 'dpo@acme', requestId: 'req-77' },
};

/**
 * A7 (marcação `a7-marcacao-export-auditoria.md`): o ponto inteiro da tela é
 * NUNCA sugerir garantia que o sistema não tem. Estes testes provam
 * negativamente ("bloco"/"verificado"/"ancorado ·"/"export_id" nunca
 * aparecem) tanto quanto positivamente (a voz correta aparece).
 */
describe('AdministrationRoute (A7) — recibo com a garantia real, nunca falsa', () => {
  beforeEach(() => {
    ctx.user = { id: 'dpo1', displayName: 'DPO', email: 'dpo@acme.com', role: 'admin' };
    resetRoutes();
  });

  it('sem audit:export → tela de acesso negado, nunca o formulário', () => {
    ctx.user = { id: 'u1', displayName: 'Ana', email: 'ana@acme.com', role: 'business' };
    render(<AdministrationRoute />);
    expect(screen.getByText('Sem acesso')).toBeInTheDocument();
    expect(screen.queryByText('Exportar com recibo')).not.toBeInTheDocument();
  });

  it('export com recibo: garantia real, NUNCA "bloco"/"verificado"/"notarizado"/"export_id"', async () => {
    route('GET /v1/audit/export', () => ok({ receipt: RECEIPT, records: [] }));
    const { container } = render(<AdministrationRoute />);
    await userEvent.click(screen.getByRole('button', { name: 'Exportar com recibo' }));

    expect(await screen.findByText('Registro próprio')).toBeInTheDocument();
    expect(screen.getByText(/Não há notarização externa\./)).toBeInTheDocument();
    expect(screen.getByText(/Todas as 3412 linhas deste export estão dentro da cobertura registrada\./)).toBeInTheDocument();
    expect(screen.getByText(/trilha do tenant/)).toBeInTheDocument();
    expect(screen.getByText(/trilha da instância — sem cobertura registrada/)).toBeInTheDocument();

    // negativo: nenhuma palavra que sugira notarização externa/terceiro atestando.
    expect(container.textContent).not.toMatch(/bloco\s*#|verificado|notarizad|export_id/i);

    // ator via ActorBadge (fechado pelo dono) — não texto solto "DPO · audit:export".
    expect(screen.getByText('Pessoa')).toBeInTheDocument();
    expect(screen.getByText('dpo@acme')).toBeInTheDocument();
  });

  it('unanchoredCount > 0: veredito ÂMBAR, nunca vermelho (não é falha do sistema)', async () => {
    route('GET /v1/audit/export', () =>
      ok({
        receipt: { ...RECEIPT, coverage: { ...RECEIPT.coverage, unanchoredCount: 3, note: '3 linha(s) fora' } },
        records: [],
      }),
    );
    const { container } = render(<AdministrationRoute />);
    await userEvent.click(screen.getByRole('button', { name: 'Exportar com recibo' }));
    const verdict = await screen.findByText(/3 linha\(s\) deste export estão fora da cobertura registrada\./);
    expect(verdict.closest('.audit-verdict')).toHaveClass('audit-verdict-warn');
    expect(container.textContent).not.toMatch(/bloco\s*#/i);
  });

  it('export vazio (count 0): "Nenhum evento neste recorte." + recibo válido ao lado — nunca a tela de erro', async () => {
    route('GET /v1/audit/export', () => ok({ receipt: { ...RECEIPT, count: 0 }, records: [] }));
    render(<AdministrationRoute />);
    await userEvent.click(screen.getByRole('button', { name: 'Exportar com recibo' }));
    expect(await screen.findByText('Nenhum evento neste recorte.')).toBeInTheDocument();
    expect(screen.queryByText('Falha ao exportar')).not.toBeInTheDocument();
    expect(screen.getByText('Registro próprio')).toBeInTheDocument(); // o recibo segue aparecendo
  });

  it('falha ao exportar: erro explícito com Tentar novamente — nunca 0 eventos disfarçado', async () => {
    route('GET /v1/audit/export', () => fail(500, { title: 'boom' }));
    render(<AdministrationRoute />);
    await userEvent.click(screen.getByRole('button', { name: 'Exportar com recibo' }));
    expect(await screen.findByText('Falha ao exportar')).toBeInTheDocument();
    expect(screen.queryByText('Nenhum evento neste recorte.')).not.toBeInTheDocument();
  });

  it('CSV: recibo vem do header X-Audit-Receipt — mesma apresentação do JSON', async () => {
    route('GET /v1/audit/export', () => ({
      data: 'source,at,eventType\ntenant,2026-07-24T00:00:00Z,audit.export\n',
      error: undefined,
      response: new Response('source,at,eventType\n', {
        status: 200,
        headers: { 'X-Audit-Receipt': JSON.stringify(RECEIPT) },
      }),
    }));
    render(<AdministrationRoute />);
    await userEvent.selectOptions(screen.getByLabelText('Formato'), 'csv');
    await userEvent.click(screen.getByRole('button', { name: 'Exportar com recibo' }));
    expect(await screen.findByText('Registro próprio')).toBeInTheDocument();
    expect(screen.getByText(/Não há notarização externa\./)).toBeInTheDocument();
  });

  it('verificar: matches:true → "Confere"; matches:false → âmbar com os dois digests, nunca vermelho', async () => {
    render(<AdministrationRoute />);
    await userEvent.click(screen.getByText(/ou cole o recibo/));
    const textarea = screen.getByLabelText('Recibo colado (JSON)');

    route('POST /v1/audit/verify', () => ok({ matches: true, expectedDigest: RECEIPT.digest, actualDigest: RECEIPT.digest, count: 3412, anchorRef: RECEIPT.anchorRef }));
    fireEvent.change(textarea, { target: { value: JSON.stringify(RECEIPT) } });
    await userEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByText(/Confere — o arquivo é idêntico ao registrado\./)).toBeInTheDocument();

    route('POST /v1/audit/verify', () => ok({ matches: false, expectedDigest: RECEIPT.digest, actualDigest: 'sha256:0000', count: 3400, anchorRef: RECEIPT.anchorRef }));
    fireEvent.change(textarea, { target: { value: JSON.stringify(RECEIPT) } });
    await userEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    const notMatch = await screen.findByText(/Não confere — a trilha mudou desde este export\./);
    expect(notMatch.closest('.audit-verdict')).toHaveClass('audit-verdict-warn');
  });

  it('a11y: tela com recibo renderizado sem violação séria', async () => {
    route('GET /v1/audit/export', () => ok({ receipt: RECEIPT, records: [] }));
    const { container } = render(<AdministrationRoute />);
    await userEvent.click(screen.getByRole('button', { name: 'Exportar com recibo' }));
    await screen.findByText('Registro próprio');
    await expectNoSeriousAxe(container);
  });
});
