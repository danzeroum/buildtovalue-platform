import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BpmnDiagram } from '@buildtovalue/core';
import { StudioRoute } from '../src/routes/studio.js';
import { api } from '../src/api/client.js';
import PR01 from './fixtures/pr01.bpmn?raw';

vi.mock('../src/api/client.js', () => ({
  api: { POST: vi.fn() },
  problemMessage: (b: unknown, f: string) => (b as { detail?: string })?.detail ?? f,
}));

// O editor real é canvas pesado (e carregado por lazy). O dublê registra o que
// interessa ao CONTRATO que o defeito violou: qual diagrama foi SEMEADO e
// quantas vezes o editor montou. A prop `diagram` da lib é semente, não estado
// controlado — sem remontar, o canvas segue no diagrama antigo.
let mounts = 0;
let seeded: string[] = [];
vi.mock('@buildtovalue/react', () => ({
  BpmnEditor: ({ diagram }: { diagram: BpmnDiagram }) => {
    // Deps vazias de propósito: o que se conta é MONTAGEM, não re-render.
    useEffect(() => {
      mounts += 1;
      seeded.push(diagram.name);
    }, []);
    return <div data-testid="editor" data-seeded={diagram.name} />;
  },
}));

const post = api.POST as unknown as Mock;

beforeEach(() => {
  post.mockReset();
  post.mockImplementation(() => Promise.resolve({ data: { issues: [] }, error: undefined }));
  mounts = 0;
  seeded = [];
});
afterEach(() => vi.clearAllMocks());

describe('StudioRoute — importar substitui o diagrama do canvas', () => {
  it('semeia o editor com o modelo importado, remontando-o', async () => {
    render(<StudioRoute />);
    await waitFor(() => expect(screen.getByTestId('editor')).toBeInTheDocument());
    expect(seeded).toEqual(['Reembolso de despesas']);

    await userEvent.click(screen.getByRole('button', { name: 'Importar .bpmn…' }));
    await userEvent.upload(
      screen.getByLabelText('Selecionar arquivo .bpmn'),
      new File([PR01], 'pr01.bpmn', { type: 'application/xml' }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /substituir/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /substituir/i }));

    // A regressão: sem `key`, o editor NÃO remontava e seguia semeado com o
    // diagrama antigo, mesmo com o título da barra já trocado.
    await waitFor(() =>
      expect(screen.getByTestId('editor')).toHaveAttribute('data-seeded', 'PR-01 · Emissão de parecer técnico de privacidade'),
    );
    expect(mounts).toBe(2);
    expect(seeded[1]).toBe('PR-01 · Emissão de parecer técnico de privacidade');
    // o modal fecha e o título da barra acompanha
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('PR-01 · Emissão de parecer técnico de privacidade');
  });

  it('editar no canvas NÃO remonta o editor (o histórico de desfazer sobrevive)', async () => {
    render(<StudioRoute />);
    await waitFor(() => expect(screen.getByTestId('editor')).toBeInTheDocument());
    const before = mounts;
    // Abrir e fechar o modal sem importar não pode mexer na semente do canvas.
    await userEvent.click(screen.getByRole('button', { name: 'Importar .bpmn…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(mounts).toBe(before);
    expect(screen.getByTestId('editor')).toHaveAttribute('data-seeded', 'Reembolso de despesas');
  });
});
