import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormsRoute } from '../src/routes/forms.js';
import { api } from '../src/api/client.js';
import { expectNoSeriousAxe } from './a11y.js';

vi.mock('../src/api/client.js', () => ({
  api: { POST: vi.fn() },
  problemMessage: (b: unknown, f: string) => (b as { detail?: string })?.detail ?? f,
}));

const post = api.POST as unknown as Mock;
beforeEach(() => post.mockReset());

describe('FormsRoute — F3.3', () => {
  it('D20: marcar «sensível» revela as 4 consequências NO MOMENTO da escolha', async () => {
    render(<FormsRoute />);
    // campo inicial (colaborador=pessoal): sem caixa de consequências
    expect(screen.queryByTestId('sensitive-consequences')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'sensível' }));

    const box = await screen.findByTestId('sensitive-consequences');
    expect(within(box).getByText(/cifrado em repouso/)).toBeInTheDocument();
    expect(within(box).getByText(/mascarado por padrão/)).toBeInTheDocument();
    expect(within(box).getByText(/fora de logs e exports/)).toBeInTheDocument();
    expect(within(box).getByText(/não buscável por conteúdo no Operate/)).toBeInTheDocument();
  });

  it('preview usa o MESMO renderer: visibleWhen mostra «Justificativa» só quando valor > 5000', async () => {
    render(<FormsRoute />);
    const preview = screen.getByTestId('form-preview');
    // valor default indefinido → justificativa oculta no preview
    expect(within(preview).queryByLabelText(/Justificativa/)).not.toBeInTheDocument();

    const valor = within(preview).getByLabelText(/Valor/);
    await userEvent.clear(valor);
    await userEvent.type(valor, '6000');

    expect(await within(preview).findByLabelText(/Justificativa/)).toBeInTheDocument();
  });

  it('publica pelo botão e mostra o ref do registry', async () => {
    post.mockResolvedValue({ data: { ref: 'form:reembolso@1' }, error: undefined, response: { status: 201 } });
    render(<FormsRoute />);

    await userEvent.click(screen.getByRole('button', { name: /Publicar formulário no registry/ }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/form-definitions', expect.anything()),
    );
    expect(await screen.findByText(/form:reembolso@1/)).toBeInTheDocument();
  });

  it('a11y: sem violações serious/critical (incl. estado sensível aberto)', async () => {
    const { container } = render(<FormsRoute />);
    await userEvent.click(screen.getByRole('radio', { name: 'sensível' }));
    await screen.findByTestId('sensitive-consequences');
    await expectNoSeriousAxe(container);
  });
});
