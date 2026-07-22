import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BpmnDiagram } from '@buildtovalue/core';
import { PublishModal } from '../src/routes/studio.js';
import { api } from '../src/api/client.js';
import { expectNoSeriousAxe } from './a11y.js';

// O cliente da API é dublê: o teste do DELTA de publicação prova a PORTA (lint
// D19 antes do deploy, rejeição bloqueia), não a rede.
vi.mock('../src/api/client.js', () => ({
  api: { POST: vi.fn() },
  problemMessage: (b: unknown, f: string) =>
    (b as { detail?: string })?.detail ?? f,
}));

const post = api.POST as unknown as Mock;
const diagram = { name: 'Reembolso de despesas' } as unknown as BpmnDiagram;

/** Programa o dublê: lint devolve `issues`; deploy devolve `registryRef`. */
function wireApi(opts: {
  issues?: { code: string; severity: 'error' | 'warning'; message: string; elementId?: string }[];
  deploy?: { data?: { registryRef: string }; error?: unknown; status?: number };
}) {
  post.mockImplementation((path: string) => {
    if (path === '/v1/process-definitions/lint') {
      return Promise.resolve({ data: { issues: opts.issues ?? [] }, error: undefined });
    }
    const d = opts.deploy ?? { data: { registryRef: 'proc:reembolso@1' } };
    return Promise.resolve({
      data: d.data,
      error: d.error,
      response: { status: d.status ?? (d.error ? 422 : 201) },
    });
  });
}

beforeEach(() => post.mockReset());
afterEach(() => vi.clearAllMocks());

describe('PublishModal — DELTA de publicação (F3.2)', () => {
  it('roda o lint antes de habilitar publish', async () => {
    wireApi({ issues: [] });
    render(<PublishModal diagram={diagram} onClose={() => {}} />);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/process-definitions/lint', expect.anything()),
    );
    expect(await screen.findByText(/0 rejeições · 0 avisos/)).toBeInTheDocument();
    // ainda não publicou: só o lint foi chamado
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('rejeição (error) BLOQUEIA o publish e mostra a contagem', async () => {
    wireApi({
      issues: [
        {
          code: 'EXEC_UNSUPPORTED_ELEMENT',
          severity: 'error',
          message: 'Elemento fora do escopo v1.',
          elementId: 'task_x',
        },
      ],
    });
    render(<PublishModal diagram={diagram} onClose={() => {}} />);

    expect(await screen.findByText('REJEIÇÃO')).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: /Publicar \(1 rejeições\)/ });
    expect(publish).toBeDisabled();

    await userEvent.click(publish);
    // deploy NUNCA foi tentado
    expect(post).not.toHaveBeenCalledWith('/v1/process-definitions', expect.anything());
  });

  it('aviso (warning) NÃO bloqueia; publish sucede e mostra o registryRef', async () => {
    wireApi({
      issues: [{ code: 'GRAPH_UNREACHABLE', severity: 'warning', message: 'Nó inalcançável.' }],
      deploy: { data: { registryRef: 'proc:reembolso@2' } },
    });
    render(<PublishModal diagram={diagram} onClose={() => {}} />);

    expect(await screen.findByText('AVISO')).toBeInTheDocument();
    const publish = await screen.findByRole('button', { name: 'Publicar' });
    expect(publish).toBeEnabled();

    await userEvent.click(publish);
    expect(await screen.findByText(/proc:reembolso@2/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/v1/process-definitions', expect.anything());
  });

  it('a11y: sem violações serious/critical no modal', async () => {
    wireApi({ issues: [] });
    const { container } = render(<PublishModal diagram={diagram} onClose={() => {}} />);
    await screen.findByText(/0 rejeições/);
    await expectNoSeriousAxe(container);
  });
});
