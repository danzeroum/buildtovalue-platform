import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/**
 * Primitivos de UI do console contra os tokens D25 (o `@platform/shared-ui`
 * é SÓ tokens — sem componentes). Regras do parecer: `<button>` reais com
 * foco visível + `aria-busy` + anti duplo-clique; status por COR + RÓTULO;
 * piso de 11px para metadados; erros anunciados via `aria-live`.
 */

type Intent = 'primary' | 'danger' | 'neutral';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  intent?: Intent;
  busy?: boolean;
  /** onClick assíncrono; o botão fica `aria-busy` e bloqueia re-cliques. */
  onClick?: () => void | Promise<void>;
  children: ReactNode;
}

export function Button({ intent = 'neutral', busy, onClick, children, disabled, ...rest }: ButtonProps) {
  const [running, setRunning] = useState(false);
  const isBusy = busy ?? running;
  return (
    <button
      type="button"
      className="ui-btn"
      data-intent={intent}
      aria-busy={isBusy || undefined}
      disabled={disabled || isBusy}
      onClick={
        onClick
          ? async () => {
              if (running) return; // anti duplo-clique
              setRunning(true);
              try {
                await onClick();
              } finally {
                setRunning(false);
              }
            }
          : undefined
      }
      {...rest}
    >
      {children}
    </button>
  );
}

/** Tag de classificação/estado — sempre texto (nunca só cor). Piso 11px. */
export function Tag({ tone, children }: { tone: 'personal' | 'sensitive' | 'neutral' | 'success'; children: ReactNode }) {
  return (
    <span className="ui-tag" data-tone={tone}>
      {children}
    </span>
  );
}

/** Pílula de status (cor + rótulo, D25 a11y). */
export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'incident'
      ? 'danger'
      : status === 'active' || status === 'open' || status === 'armed' || status === 'available'
        ? 'success'
        : 'neutral';
  const label: Record<string, string> = {
    active: 'ativa',
    completed: 'concluída',
    cancelled: 'cancelada',
    incident: 'incidente',
    open: 'aberta',
    armed: 'armado',
    fired: 'disparado',
    available: 'disponível',
    failed: 'falhou',
    retried: 're-tentado',
    resolved: 'resolvido',
  };
  return (
    <span className="ui-pill" data-tone={tone}>
      {label[status] ?? status}
    </span>
  );
}

/** Estados não-ideais reutilizáveis (matriz 3.1 do parecer). */
export function NonIdeal({
  kind,
  title,
  detail,
  technical,
  action,
}: {
  kind: 'empty' | 'loading' | 'error' | 'forbidden' | 'conflict';
  title: string;
  detail?: string;
  /** detalhe técnico recolhível (voz por persona — G-UX-2). */
  technical?: string;
  action?: ReactNode;
}) {
  if (kind === 'loading') {
    // `aria-label` dá texto acessível ao estado de carregamento (o esqueleto é
    // puramente visual) — leitor de tela anuncia "Carregando…", não silêncio.
    return (
      <div className="ui-nonideal" data-kind="loading" role="status" aria-busy="true" aria-live="polite" aria-label={title}>
        <div className="ui-skeleton" />
        <div className="ui-skeleton" />
        <div className="ui-skeleton short" />
      </div>
    );
  }
  return (
    <div className="ui-nonideal" data-kind={kind} role={kind === 'error' ? 'alert' : undefined} aria-live="polite">
      <h2>{title}</h2>
      {detail && <p>{detail}</p>}
      {technical && (
        <details className="ui-technical">
          <summary>detalhe técnico</summary>
          <code>{technical}</code>
        </details>
      )}
      {action && <div className="ui-nonideal-action">{action}</div>}
    </div>
  );
}
