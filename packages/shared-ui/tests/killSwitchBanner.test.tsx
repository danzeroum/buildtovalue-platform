import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { KillSwitchBanner } from '../src/killSwitchBanner.js';

/**
 * Banner de kill-switch (AG-3.2 · marcação `ag3-2-marcacao-banner-killswitch.md`).
 * Provas do G-UX-3: âmbar (nunca vermelho), duas linhas SEMPRE juntas, role
 * "alert"+aria-live assertive (não status/polite), nome de exibição (não id
 * cru) quando resolvido, degrade honesto sem "desconhecido", clique aciona o
 * destino, axe sem violação.
 */
const BASE = {
  sinceIso: '2026-07-24T21:43:00.000Z',
  whenRelative: 'hoje às 21:43',
  whenAbsoluteTitle: 'sexta-feira, 24 de julho de 2026 às 21:43',
  onOpenStatus: vi.fn(),
};

describe('KillSwitchBanner — G-UX-3', () => {
  it('user com nome resolvido: iniciais + "por {nome}" + as DUAS linhas juntas', () => {
    render(<KillSwitchBanner {...BASE} by={{ type: 'user', id: 'u1', displayName: 'Ana Ruiz' }} />);
    expect(screen.getByText('AR')).toBeInTheDocument(); // iniciais
    expect(screen.getByText(/por Ana Ruiz/)).toBeInTheDocument();
    expect(screen.getByText('Agentes de IA pausados')).toBeInTheDocument();
    // linha 2 NÃO é opcional — sempre presente junto da linha 1.
    expect(screen.getByText('Tarefas e aprovações seguem normalmente.')).toBeInTheDocument();
  });

  it('degrade honesto: displayName null → usa o id cru como ÚLTIMO recurso, sem iniciais', () => {
    render(<KillSwitchBanner {...BASE} by={{ type: 'user', id: 'admin', displayName: null }} />);
    expect(screen.getByText(/por admin/)).toBeInTheDocument();
    expect(screen.queryByText('AD')).not.toBeInTheDocument(); // sem iniciais de um id cru
  });

  it('system: glyph ⚙ + "pelo sistema" (não "por desconhecido")', () => {
    render(<KillSwitchBanner {...BASE} by={{ type: 'system', id: 'scheduler', displayName: null }} />);
    expect(screen.getByText(/pelo sistema/)).toBeInTheDocument();
    expect(screen.queryByText(/desconhecido/i)).not.toBeInTheDocument();
  });

  it('by null (inconsistência): degrade honesto, nunca "desconhecido"', () => {
    render(<KillSwitchBanner {...BASE} by={null} />);
    expect(screen.getByText(/ator não registrado/)).toBeInTheDocument();
    expect(screen.queryByText(/desconhecido/i)).not.toBeInTheDocument();
  });

  it('role="alert" + aria-live="assertive" (NUNCA status/polite)', () => {
    const { container } = render(<KillSwitchBanner {...BASE} by={{ type: 'user', id: 'u1', displayName: 'Ana Ruiz' }} />);
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it('as duas linhas vivem DENTRO do mesmo alerta (um único anúncio, não dois)', () => {
    const { container } = render(<KillSwitchBanner {...BASE} by={{ type: 'user', id: 'u1', displayName: 'Ana Ruiz' }} />);
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Agentes de IA pausados');
    expect(alert.textContent).toContain('Tarefas e aprovações seguem normalmente.');
  });

  it('o banner INTEIRO é o alvo de clique (botão único, aciona onOpenStatus)', async () => {
    const onOpenStatus = vi.fn();
    const { container } = render(
      <KillSwitchBanner {...BASE} by={{ type: 'user', id: 'u1', displayName: 'Ana Ruiz' }} onOpenStatus={onOpenStatus} />,
    );
    const trigger = container.querySelector('button')!;
    trigger.click();
    expect(onOpenStatus).toHaveBeenCalledTimes(1);
    // o texto inteiro (fato + alívio) vive dentro do MESMO botão clicável.
    expect(trigger.textContent).toContain('Agentes de IA pausados');
    expect(trigger.textContent).toContain('seguem normalmente');
  });

  it('quando: relativo visível, absoluto no title, ISO no dateTime (machine-readable)', () => {
    const { container } = render(<KillSwitchBanner {...BASE} by={{ type: 'user', id: 'u1', displayName: 'Ana Ruiz' }} />);
    const time = container.querySelector('time')!;
    expect(time.textContent).toBe('hoje às 21:43');
    expect(time).toHaveAttribute('title', BASE.whenAbsoluteTitle);
    expect(time).toHaveAttribute('dateTime', BASE.sinceIso);
  });

  it('nunca vermelho — classe própria do kill-switch (âmbar), não a de gate/danger', () => {
    const { container } = render(<KillSwitchBanner {...BASE} by={{ type: 'user', id: 'u1', displayName: 'Ana Ruiz' }} />);
    const banner = container.querySelector('.ui-killswitch-banner')!;
    expect(banner).toBeInTheDocument();
    expect(banner.className).not.toMatch(/danger|vermelho|red/i);
  });

  it('a11y: sem violações (axe)', async () => {
    const { container } = render(<KillSwitchBanner {...BASE} by={{ type: 'user', id: 'u1', displayName: 'Ana Ruiz' }} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
