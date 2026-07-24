import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const ctx = vi.hoisted(() => ({
  user: { id: 'u1', displayName: 'Ana Ruiz', email: 'ana@acme.com', role: 'business' as string },
}));
// `useSession` mora em `session.js` (não em `shell.js`) DE PROPÓSITO — evita
// ciclo shell↔banner (G-UX-3 §6: o banner é montado ANTES do header no DOM).
vi.mock('../src/session.js', () => ({ useSession: () => ctx.user }));
vi.mock('../src/api/client.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
  problemMessage: (b: unknown, f: string) =>
    (b as { detail?: string; title?: string })?.detail ?? (b as { title?: string })?.title ?? f,
}));

import { KillSwitchBannerContainer } from '../src/killSwitchBanner.js';
import { api } from '../src/api/client.js';
import { ok, fail, route, resetRoutes } from './apiMock.js';
import { expectNoSeriousAxe } from './a11y.js';

/**
 * AG-3.2 — banner + tela de estado (marcação `ag3-2-marcacao-banner-killswitch.md`).
 * Aceite do dono: banner aparece em toda a Operação quando pausado e some ao
 * retomar; operador comum vê o fato mas não o botão de retomar; leitor de tela
 * anuncia como alerta.
 */
const PAUSED = {
  state: 'paused' as const,
  by: { type: 'user' as const, id: 'admin-1', displayName: 'Bruno Alves' },
  since: '2026-07-24T21:43:00.000Z',
};
const ACTIVE = { state: 'active' as const, by: null as null, since: null as string | null };
const REASON = 'suspeita de vazamento no fornecedor X';

function seed(overrides: Record<string, () => ReturnType<typeof ok>> = {}) {
  route('GET /v1/ai/kill-switch', () => ok(PAUSED));
  route('GET /v1/ai/config', () =>
    ok({
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      keyRef: 'secret://kms/x',
      keyConfigured: true,
      budgetCents: null,
      fxUsdBrl: null,
      killSwitch: { ...PAUSED, reason: REASON },
      updatedAt: '2026-07-24T21:43:00.000Z',
    }),
  );
  route('POST /v1/ai/kill-switch', () => ok(ACTIVE));
  for (const [k, v] of Object.entries(overrides)) route(k, v);
}

beforeEach(() => {
  vi.restoreAllMocks();
  ctx.user = { id: 'u1', displayName: 'Ana Ruiz', email: 'ana@acme.com', role: 'business' };
  resetRoutes();
});

describe('KillSwitchBannerContainer — G-UX-3 (AG-3.2)', () => {
  it('active → o banner NÃO renderiza (ausência é o sinal, não uma faixa "tudo bem")', async () => {
    seed({ 'GET /v1/ai/kill-switch': () => ok(ACTIVE) });
    const { container } = render(<KillSwitchBannerContainer />);
    await waitFor(() => expect(api.GET).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('falha de leitura → MESMO silêncio do active, nunca um "não verificado" ambiente', async () => {
    seed({ 'GET /v1/ai/kill-switch': () => fail(500, {}) as ReturnType<typeof ok> });
    const { container } = render(<KillSwitchBannerContainer />);
    await waitFor(() => expect(api.GET).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/não verificado/i)).not.toBeInTheDocument();
  });

  it('paused → banner com o FATO (ator resolvido + hora) e as duas linhas', async () => {
    seed();
    render(<KillSwitchBannerContainer />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/por Bruno Alves/)).toBeInTheDocument();
    expect(screen.getByText('Agentes de IA pausados')).toBeInTheDocument();
    expect(screen.getByText('Tarefas e aprovações seguem normalmente.')).toBeInTheDocument();
  });

  it('clique no banner abre a tela de estado — o fato ampliado aparece p/ QUALQUER papel', async () => {
    seed();
    render(<KillSwitchBannerContainer />); // business (ctx padrão)
    await userEvent.click(await screen.findByRole('button'));
    expect(await screen.findByRole('dialog', { name: 'Estado dos agentes de IA' })).toBeInTheDocument();
    expect(await screen.findByText(/Pausado por Bruno Alves/)).toBeInTheDocument();
  });

  it('razão (nível 2) só p/ ai:read-config (admin) — business não vê nem dispara a leitura da config', async () => {
    seed();
    render(<KillSwitchBannerContainer />); // business
    await userEvent.click(await screen.findByRole('button'));
    await screen.findByText(/Pausado por Bruno Alves/);
    expect(screen.queryByText(new RegExp(REASON))).not.toBeInTheDocument();
    expect((api.GET as unknown as Mock).mock.calls.some((c) => c[0] === '/v1/ai/config')).toBe(false);
  });

  it('admin VÊ a razão (mesma tela, mesmo fato — só o nível de leitura muda)', async () => {
    seed();
    ctx.user = { id: 'admin-1', displayName: 'Bruno', email: 'bruno@acme.com', role: 'admin' };
    render(<KillSwitchBannerContainer />);
    await userEvent.click(await screen.findByRole('button'));
    await screen.findByText(/Pausado por Bruno Alves/);
    expect(await screen.findByText(new RegExp(REASON))).toBeInTheDocument();
  });

  it('«Reativar agentes…» AUSENTE (não desabilitado) p/ quem não tem ai:operate — caminho humano, não beco 403', async () => {
    seed();
    render(<KillSwitchBannerContainer />); // business
    await userEvent.click(await screen.findByRole('button'));
    await screen.findByText(/Pausado por Bruno Alves/);
    expect(screen.queryByRole('button', { name: 'Reativar agentes…' })).not.toBeInTheDocument();
    expect(screen.getByText(/Só um administrador pode reativar/)).toBeInTheDocument();
  });

  it('admin aciona «Reativar agentes…» com motivo obrigatório (auditado)', async () => {
    seed();
    ctx.user = { id: 'admin-1', displayName: 'Bruno', email: 'bruno@acme.com', role: 'admin' };
    vi.spyOn(window, 'prompt').mockReturnValue('confirmado, retomar');
    render(<KillSwitchBannerContainer />);
    await userEvent.click(await screen.findByRole('button'));
    await userEvent.click(await screen.findByRole('button', { name: 'Reativar agentes…' }));
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith(
        '/v1/ai/kill-switch',
        expect.objectContaining({ body: { paused: false, reason: 'confirmado, retomar' } }),
      ),
    );
  });

  it('sem motivo (prompt cancelado) NÃO envia — o ato exige motivo nas duas direções', async () => {
    seed();
    ctx.user = { id: 'admin-1', displayName: 'Bruno', email: 'bruno@acme.com', role: 'admin' };
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    render(<KillSwitchBannerContainer />);
    await userEvent.click(await screen.findByRole('button'));
    await userEvent.click(await screen.findByRole('button', { name: 'Reativar agentes…' }));
    expect((api.POST as unknown as Mock).mock.calls.some((c) => c[0] === '/v1/ai/kill-switch')).toBe(false);
  });

  it('falha na TELA DE ESTADO aparece EXPLÍCITA (contraste com o silêncio do banner)', async () => {
    seed();
    render(<KillSwitchBannerContainer />);
    const trigger = await screen.findByRole('button');
    // a modal faz sua PRÓPRIA leitura do fato — troca a rota antes de abrir.
    route('GET /v1/ai/kill-switch', () => fail(500, { detail: 'timeout' }) as ReturnType<typeof ok>);
    await userEvent.click(trigger);
    expect(await screen.findByText(/Não foi possível confirmar o estado dos agentes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('a11y: sem violações serious/critical (banner pausado + tela de estado aberta)', async () => {
    seed();
    ctx.user = { id: 'admin-1', displayName: 'Bruno', email: 'bruno@acme.com', role: 'admin' };
    const { container } = render(<KillSwitchBannerContainer />);
    await userEvent.click(await screen.findByRole('button'));
    await screen.findByText(/Pausado por Bruno Alves/);
    await expectNoSeriousAxe(container);
  });
});
