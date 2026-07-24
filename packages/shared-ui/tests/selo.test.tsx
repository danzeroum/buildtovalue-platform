import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import {
  ActorBadge,
  AutonomyDial,
  EvidenceSeal,
  GateSeal,
  ProcedenceSeal,
} from '../src/selo.js';

/**
 * Selo de procedência + gate/autonomia (AG-3.0). Provas: sinal NUNCA só por cor
 * (sempre RÓTULO textual), os quatro casos de ator (incl. Motor/null), os TRÊS
 * estados reais de evidência (sem `negado`), e axe sem violação séria.
 */
describe('ActorBadge — envelope D33 (4 casos)', () => {
  it('renderiza rótulo textual para user/system/agent', () => {
    render(<ActorBadge actor={{ type: 'user' }} />);
    expect(screen.getByText('Pessoa')).toBeInTheDocument();
    render(<ActorBadge actor={{ type: 'system' }} />);
    expect(screen.getByText('Sistema')).toBeInTheDocument();
    render(<ActorBadge actor={{ type: 'agent' }} />);
    expect(screen.getByText('Agente')).toBeInTheDocument();
  });

  it('actor === null → "Motor" (ato sem ator, honesto), nunca "desconhecido"', () => {
    render(<ActorBadge actor={null} />);
    expect(screen.getByText('Motor')).toBeInTheDocument();
    expect(screen.queryByText(/desconhecido/i)).not.toBeInTheDocument();
  });

  it('agent ganha o papel violeta (data-tone=agent); demais neutro', () => {
    const { container: c1 } = render(<ActorBadge actor={{ type: 'agent' }} />);
    expect(c1.querySelector('.ui-selo-actor')).toHaveAttribute('data-tone', 'agent');
    const { container: c2 } = render(<ActorBadge actor={{ type: 'user' }} />);
    expect(c2.querySelector('.ui-selo-actor')).toHaveAttribute('data-tone', 'neutral');
  });

  it('id do ator vai em mono, presente só quando informado', () => {
    render(<ActorBadge actor={{ type: 'agent', id: 'agnt-rsch@1.0.0' }} />);
    expect(screen.getByText('agnt-rsch@1.0.0')).toHaveClass('ui-selo-id');
    const { container: c2 } = render(<ActorBadge actor={{ type: 'user' }} />);
    expect(c2.querySelector('.ui-selo-id')).toBeNull();
  });
});

describe('EvidenceSeal — só os estados REAIS (3)', () => {
  it('auditado/mascarado/ancoravel renderizam rótulo; ancorável carrega a nota self-recorded', () => {
    render(<EvidenceSeal state="auditado" />);
    expect(screen.getByText('auditado')).toBeInTheDocument();
    render(<EvidenceSeal state="mascarado" />);
    expect(screen.getByText('mascarado')).toBeInTheDocument();
    render(<EvidenceSeal state="ancoravel" note="self-recorded" />);
    expect(screen.getByText('ancorável')).toBeInTheDocument();
    // NUNCA "verificado" — a garantia externa espera WAL imutável.
    expect(screen.queryByText(/verificado/i)).not.toBeInTheDocument();
    expect(screen.getByText('self-recorded')).toBeInTheDocument();
  });

  it('correções da ratificação: mascarado usa o papel PRÓPRIO masked (não gate); glyphs sem color-emoji', () => {
    const { container } = render(<EvidenceSeal state="mascarado" />);
    expect(container.querySelector('.ui-selo-evidence')).toHaveAttribute('data-tone', 'masked');
    // sem os color-emoji antigos (🔒/⚓) — glyphs monocromáticos herdam currentColor.
    expect(container.textContent).not.toMatch(/[🔒⚓]/u);
    const { container: anc } = render(<EvidenceSeal state="ancoravel" />);
    expect(anc.textContent).not.toMatch(/[🔒⚓]/u);
  });
});

describe('GateSeal — âmbar, parada honesta (nunca vermelho)', () => {
  it('aguardando/expirado usam o papel gate (dourado), com saída honesta no expirado', () => {
    const { container } = render(<GateSeal state="aguardando" />);
    expect(container.querySelector('.ui-selo-gate')).toHaveAttribute('data-tone', 'gate');
    expect(screen.getByText(/aguardando gate humano/)).toBeInTheDocument();
    render(<GateSeal state="expirado" />);
    expect(screen.getByText(/aprovar indisponível/)).toBeInTheDocument();
  });
});

describe('AutonomyDial — apresentacional, nível sempre em TEXTO', () => {
  it('lê o nível por rótulo textual (não só posição) e clampa 0–5', () => {
    render(<AutonomyDial level={3} />);
    expect(screen.getByText('autonomia 3/5')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'autonomia 3 de 5' })).toBeInTheDocument();
    render(<AutonomyDial level={9} />);
    expect(screen.getByText('autonomia 5/5')).toBeInTheDocument();
  });

  it('requiresGate → dourado gate + "exige gate"; senão violeta agent', () => {
    const { container: g } = render(<AutonomyDial level={4} requiresGate />);
    expect(g.querySelector('.ui-selo-dial')).toHaveAttribute('data-tone', 'gate');
    expect(screen.getByText('exige gate')).toBeInTheDocument();
    const { container: a } = render(<AutonomyDial level={2} />);
    expect(a.querySelector('.ui-selo-dial')).toHaveAttribute('data-tone', 'agent');
  });
});

describe('a11y (axe) — sinal nunca só por cor', () => {
  it('procedência (ator Motor + evidência) sem violação séria', async () => {
    const { container } = render(
      <ProcedenceSeal actor={null}>
        <EvidenceSeal state="ancoravel" note="self-recorded" />
      </ProcedenceSeal>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('dial de autonomia sem violação séria', async () => {
    const { container } = render(<AutonomyDial level={4} requiresGate />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
