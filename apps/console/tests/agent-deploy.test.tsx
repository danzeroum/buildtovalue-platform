import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentDeployModal } from '../src/routes/studio.js';
import { api } from '../src/api/client.js';
import { expectNoSeriousAxe } from './a11y.js';

/**
 * P6 (deploy de agente, AG-3.6): "tela mínima" (decisão do dono — API-only
 * seria capacidade só-nossa) — cola JSON, lint ANTES do deploy, rejeição
 * bloqueia, mesma disciplina D19 do PublishModal (mesmo componente de lista).
 *
 * `fireEvent.change` (não `userEvent.type`) para preencher o textarea: chaves
 * `{}` são sintaxe de teclas especiais no parser de `userEvent` — colar JSON
 * de verdade (o caso real desta tela) exige `fireEvent.change`.
 */
vi.mock('../src/api/client.js', () => ({
  api: { POST: vi.fn() },
  problemMessage: (b: unknown, f: string) => (b as { detail?: string })?.detail ?? f,
}));

const post = api.POST as unknown as Mock;
const GRAPH_JSON = '{"id":"agnt-teste","version":"1.0.0"}';

function pasteGraph(value: string) {
  fireEvent.change(screen.getByLabelText(/Grafo \(JSON\)/), { target: { value } });
}

function wireApi(opts: {
  issues?: { code: string; severity: 'error' | 'warning'; message: string; nodeId?: string }[];
  deploy?: { data?: { ref: string }; error?: unknown; status?: number };
}) {
  post.mockImplementation((path: string) => {
    if (path === '/v1/agent-definitions/lint') {
      return Promise.resolve({ data: { issues: opts.issues ?? [] }, error: undefined });
    }
    const d = opts.deploy ?? { data: { ref: 'agnt-teste@1.0.0' } };
    return Promise.resolve({
      data: d.data,
      error: d.error,
      response: { status: d.status ?? (d.error ? 422 : 201) },
    });
  });
}

beforeEach(() => post.mockReset());
afterEach(() => vi.clearAllMocks());

describe('AgentDeployModal — P6 (AG-3.6)', () => {
  it('JSON inválido → erro de parse; lint NUNCA chamado', async () => {
    render(<AgentDeployModal onClose={() => {}} />);
    pasteGraph('{ isto não é json');
    await userEvent.click(screen.getByRole('button', { name: 'Rodar lint' }));
    expect(await screen.findByText(/JSON inválido/)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('lint limpo habilita publish; publica e mostra o ref', async () => {
    wireApi({ issues: [], deploy: { data: { ref: 'agnt-teste@1.0.0' } } });
    render(<AgentDeployModal onClose={() => {}} />);
    pasteGraph(GRAPH_JSON);
    await userEvent.click(screen.getByRole('button', { name: 'Rodar lint' }));
    expect(await screen.findByText(/0 rejeições · 0 avisos/)).toBeInTheDocument();

    const publish = screen.getByRole('button', { name: 'Publicar' });
    expect(publish).toBeEnabled();
    await userEvent.click(publish);
    expect(await screen.findByText(/agnt-teste@1\.0\.0/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/v1/agent-definitions', expect.anything());
  });

  it('rejeição (error) BLOQUEIA o publish e mostra a contagem — deploy nunca tentado', async () => {
    wireApi({
      issues: [{ code: 'AUTONOMY_CHAIN', severity: 'error', message: 'Cadeia de autonomia inválida.', nodeId: 'llm-1' }],
    });
    render(<AgentDeployModal onClose={() => {}} />);
    pasteGraph(GRAPH_JSON);
    await userEvent.click(screen.getByRole('button', { name: 'Rodar lint' }));

    expect(await screen.findByText('REJEIÇÃO')).toBeInTheDocument();
    expect(screen.getByText('llm-1')).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: /Publicar \(1 rejeições\)/ });
    expect(publish).toBeDisabled();
    await userEvent.click(publish);
    expect(post).not.toHaveBeenCalledWith('/v1/agent-definitions', expect.anything());
  });

  it('aviso (warning) NÃO bloqueia o publish', async () => {
    wireApi({ issues: [{ code: 'GRAPH_UNREACHABLE', severity: 'warning', message: 'Nó inalcançável.' }] });
    render(<AgentDeployModal onClose={() => {}} />);
    pasteGraph(GRAPH_JSON);
    await userEvent.click(screen.getByRole('button', { name: 'Rodar lint' }));

    expect(await screen.findByText('AVISO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publicar' })).toBeEnabled();
  });

  it('erro no DEPLOY (após lint limpo) mostra a falha, não um sucesso silencioso', async () => {
    wireApi({ issues: [], deploy: { error: { detail: 'registry recusou' }, status: 500 } });
    render(<AgentDeployModal onClose={() => {}} />);
    pasteGraph(GRAPH_JSON);
    await userEvent.click(screen.getByRole('button', { name: 'Rodar lint' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Publicar' }));
    expect(await screen.findByText(/registry recusou/)).toBeInTheDocument();
    expect(screen.queryByText(/Publicado como/)).not.toBeInTheDocument();
  });

  it('editar o texto depois de um lint limpo volta ao estado idle (publish desabilita de novo)', async () => {
    wireApi({ issues: [] });
    render(<AgentDeployModal onClose={() => {}} />);
    pasteGraph(GRAPH_JSON);
    await userEvent.click(screen.getByRole('button', { name: 'Rodar lint' }));
    await screen.findByText(/0 rejeições/);

    pasteGraph(GRAPH_JSON + ' ');
    expect(screen.queryByText(/0 rejeições/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publicar' })).toBeDisabled();
  });

  it('a11y: sem violações serious/critical no modal', async () => {
    wireApi({ issues: [] });
    const { container } = render(<AgentDeployModal onClose={() => {}} />);
    pasteGraph(GRAPH_JSON);
    await userEvent.click(screen.getByRole('button', { name: 'Rodar lint' }));
    await waitFor(() => expect(screen.getByText(/0 rejeições/)).toBeInTheDocument());
    await expectNoSeriousAxe(container);
  });
});
