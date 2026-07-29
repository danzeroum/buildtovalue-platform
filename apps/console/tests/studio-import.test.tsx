import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportBpmnModal } from '../src/routes/studio.js';
import { api } from '../src/api/client.js';
import { expectNoSeriousAxe } from './a11y.js';

// Mesmo dublê do studio.test.tsx: o que se prova aqui é a PORTA (ler XML, dizer
// o veredicto D19, não trocar o diagrama quando falha), não a rede.
vi.mock('../src/api/client.js', () => ({
  api: { POST: vi.fn() },
  problemMessage: (b: unknown, f: string) => (b as { detail?: string })?.detail ?? f,
}));

const post = api.POST as unknown as Mock;

// Modelo REAL de documentação (pool + 4 lanes + boundary timer + anotação,
// isExecutable="false") — é justamente o caso que importa limpo e não publica.
// `?raw` em vez de fs: sob jsdom o `import.meta.url` não é file://.
import PR01 from './fixtures/pr01.bpmn?raw';

function wireLint(issues: { code: string; severity: 'error' | 'warning'; message: string; elementId?: string }[] = []) {
  post.mockImplementation(() => Promise.resolve({ data: { issues }, error: undefined }));
}

/** Sobe o arquivo pelo input — o mesmo caminho da pessoa usuária. */
async function upload(xml: string, name = 'pr01.bpmn') {
  const file = new File([xml], name, { type: 'application/xml' });
  await userEvent.upload(screen.getByLabelText('Selecionar arquivo .bpmn'), file);
}

beforeEach(() => post.mockReset());
afterEach(() => vi.clearAllMocks());

describe('ImportBpmnModal — importar .bpmn no Estúdio', () => {
  it('parte do estado vazio, sem preview nem botão de substituir', () => {
    wireLint();
    render(<ImportBpmnModal onClose={() => {}} onReplace={() => {}} />);
    expect(screen.getByText('Nenhum modelo escolhido ainda.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /substituir/i })).not.toBeInTheDocument();
  });

  it('lê o modelo e anuncia nome, nós e arestas', async () => {
    wireLint();
    render(<ImportBpmnModal onClose={() => {}} onReplace={() => {}} />);
    await upload(PR01);
    await waitFor(() => expect(screen.getByText(/PR-01/)).toBeInTheDocument());
    // 21 nós / 16 arestas: contagem verificada contra o fromXml da biblioteca.
    expect(screen.getByText(/21 nós/)).toBeInTheDocument();
    expect(screen.getByText(/16 arestas/)).toBeInTheDocument();
  });

  it('com rejeições, diz que dá para navegar mas não publicar — e ainda assim permite substituir', async () => {
    wireLint([
      { code: 'EXEC_UNSUPPORTED_ELEMENT', severity: 'error', message: "elemento 'lane' fora do subconjunto", elementId: 'Lane_PR01_dpo' },
      { code: 'EXEC_FORM_REF_MISSING', severity: 'error', message: 'userTask sem formRef', elementId: 'A1_1' },
    ]);
    render(<ImportBpmnModal onClose={() => {}} onReplace={() => {}} />);
    await upload(PR01);
    await waitFor(() => expect(screen.getByText(/não\s+publicado/)).toBeInTheDocument());
    expect(screen.getAllByText('REJEIÇÃO')).toHaveLength(2);
    // VER não é PUBLICAR: quem bloqueia o deploy é o PublishModal, não este.
    expect(screen.getByRole('button', { name: /substituir/i })).toBeEnabled();
  });

  it('entrega o diagrama lido ao confirmar', async () => {
    wireLint();
    const onReplace = vi.fn();
    render(<ImportBpmnModal onClose={() => {}} onReplace={onReplace} />);
    await upload(PR01);
    await waitFor(() => expect(screen.getByRole('button', { name: /substituir/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /substituir/i }));
    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onReplace.mock.calls[0][0].name).toBe('PR-01 · Emissão de parecer técnico de privacidade');
  });

  it('XML inválido vira estado de erro e NÃO troca o diagrama', async () => {
    wireLint();
    const onReplace = vi.fn();
    render(<ImportBpmnModal onClose={() => {}} onReplace={onReplace} />);
    await upload('<isto não é bpmn', 'quebrado.bpmn');
    await waitFor(() => expect(screen.getByText('Não foi possível ler este arquivo.')).toBeInTheDocument());
    expect(onReplace).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /substituir/i })).not.toBeInTheDocument();
  });

  it('lint indisponível não vira "0 rejeições" — diz que não sabe', async () => {
    post.mockImplementation(() => Promise.resolve({ data: undefined, error: { detail: 'lint fora do ar' } }));
    render(<ImportBpmnModal onClose={() => {}} onReplace={() => {}} />);
    await upload(PR01);
    await waitFor(() => expect(screen.getByText('Não foi possível rodar o lint D19')).toBeInTheDocument());
    expect(screen.queryByText(/0 rejeições/)).not.toBeInTheDocument();
    // o desenho foi lido, então substituir continua disponível
    expect(screen.getByRole('button', { name: /substituir/i })).toBeEnabled();
  });

  it('axe: 0 serious no preview', async () => {
    wireLint([{ code: 'EXEC_FORM_REF_MISSING', severity: 'error', message: 'sem formRef', elementId: 'A1_1' }]);
    const { container } = render(<ImportBpmnModal onClose={() => {}} onReplace={() => {}} />);
    await upload(PR01);
    await waitFor(() => expect(screen.getByText(/21 nós/)).toBeInTheDocument());
    await expectNoSeriousAxe(container);
  });
});
