import { useState } from 'react';
import { ActorBadge, EvidenceSeal, type Actor } from '@platform/shared-ui';
import { Button } from './ui/ui.js';

/**
 * Recibo de auditoria (digest + âncora + cobertura) — extraído da tela A7
 * (`Administration.tsx`) para o P7 (Evidence Bundle no Operate, AG-3.6) poder
 * reaproveitar o MESMO componente/voz, sem duplicar a lição mais séria do A7:
 * `assurance: 'self-recorded'` nunca sugere notarização externa que o sistema
 * não tem.
 */

export interface AuditCoverageTrail {
  throughXid: string | null;
  throughTime: string | null;
}

export interface AuditReceipt {
  digest: string;
  algorithm: 'sha256';
  count: number;
  /** Filtros que produziram o recibo — forma varia por chamador (A7: filtros livres
   *  do operador; P7: filtros travados a uma instância). Não renderizado aqui. */
  filters: Record<string, unknown>;
  anchorRef: string;
  assurance: 'self-recorded';
  assuranceNote: string;
  coverage: {
    perTrail: { tenant: AuditCoverageTrail; instance: AuditCoverageTrail };
    unanchoredCount: number;
    note: string;
  };
  generatedAt: string;
  generatedBy: Actor & { requestId: string | null };
}

export function shortDigest(digest: string): string {
  return digest.length > 20 ? `${digest.slice(0, 13)}…${digest.slice(-6)}` : digest;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard indisponível (permissão/contexto) — degrade silencioso, o texto segue selecionável na tela */
  }
}

/** Cobertura das duas trilhas: veredito PRIMEIRO, nunca lista crua de xid/tempo. */
export function CoverageSection({ coverage, count }: { coverage: AuditReceipt['coverage']; count: number }) {
  const ok = coverage.unanchoredCount === 0;
  return (
    <div className="audit-coverage">
      <p className={`audit-verdict${ok ? '' : ' audit-verdict-warn'}`}>
        <span aria-hidden="true">{ok ? '✓' : '⚠'}</span>{' '}
        {ok
          ? `Todas as ${count} linhas deste export estão dentro da cobertura registrada.`
          : `${coverage.unanchoredCount} linha(s) deste export estão fora da cobertura registrada.`}
      </p>
      <ul className="audit-trails">
        <li>
          trilha do tenant —{' '}
          {coverage.perTrail.tenant.throughTime
            ? `coberta até ${formatDateTime(coverage.perTrail.tenant.throughTime)}`
            : 'sem cobertura registrada'}
        </li>
        <li>
          trilha da instância —{' '}
          {coverage.perTrail.instance.throughTime
            ? `coberta até ${formatDateTime(coverage.perTrail.instance.throughTime)}`
            : 'sem cobertura registrada'}
        </li>
      </ul>
    </div>
  );
}

export function ReceiptCard({ receipt }: { receipt: AuditReceipt }) {
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div className="audit-receipt-card">
      <div className="audit-receipt-assurance">
        <EvidenceSeal state="ancoravel" note="self-recorded" />
        <strong>Registro próprio</strong>
      </div>
      <p className="audit-receipt-sentence">
        O digest fica registrado na própria trilha da plataforma. <strong>Não há notarização externa.</strong>
      </p>
      <dl className="audit-receipt-fields">
        <div>
          <dt>digest</dt>
          <dd className="mono">
            {shortDigest(receipt.digest)}{' '}
            <button type="button" className="link-btn tiny" onClick={() => copyText(receipt.digest)}>
              copiar
            </button>
          </dd>
        </div>
        <div>
          <dt>algoritmo</dt>
          <dd className="mono">{receipt.algorithm}</dd>
        </div>
        <div>
          <dt>eventos</dt>
          <dd>{receipt.count}</dd>
        </div>
        <div>
          <dt>gerado em</dt>
          <dd>{formatDateTime(receipt.generatedAt)}</dd>
        </div>
        <div>
          <dt>solicitado por</dt>
          <dd>
            <ActorBadge actor={receipt.generatedBy} />
          </dd>
        </div>
      </dl>
      <CoverageSection coverage={receipt.coverage} count={receipt.count} />
      <details className="audit-receipt-detail" open={showDetail} onToggle={(e) => setShowDetail((e.target as HTMLDetailsElement).open)}>
        <summary>detalhe técnico (anchorRef, identificadores de transação)</summary>
        <dl>
          <div>
            <dt>anchorRef</dt>
            <dd className="mono">{receipt.anchorRef}</dd>
          </div>
          <div>
            <dt>trilha tenant · throughXid</dt>
            <dd className="mono">{receipt.coverage.perTrail.tenant.throughXid ?? '(sem cobertura registrada)'}</dd>
          </div>
          <div>
            <dt>trilha instância · throughXid</dt>
            <dd className="mono">{receipt.coverage.perTrail.instance.throughXid ?? '(sem cobertura registrada)'}</dd>
          </div>
        </dl>
      </details>
      <div className="audit-receipt-actions">
        <Button intent="neutral" onClick={() => copyText(JSON.stringify(receipt, null, 2))}>
          Copiar recibo
        </Button>
      </div>
    </div>
  );
}
