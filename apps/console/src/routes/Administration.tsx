import { useState, type ChangeEvent } from 'react';
import { ActorBadge, EvidenceSeal, type Actor } from '@platform/shared-ui';
import { api, problemMessage } from '../api/client.js';
import { can } from '../capabilities.js';
import { Button, NonIdeal } from '../ui/ui.js';
import { useSession } from '../shell.js';

/**
 * A7 — export de auditoria + recibo (marcação `a7-marcacao-export-auditoria.md`).
 * Leitura sobre `GET /v1/audit/export` + `POST /v1/audit/verify` (AG-2.3, já
 * existentes) — sem rota nova, sem migração. O ponto inteiro da tela: o
 * recibo mostra a garantia REAL (`self-recorded`), nunca sugere notarização
 * externa que o sistema não tem — a correção mais séria das quatro rodadas
 * deste rito (P1 → kill-switch → timeline → aqui).
 */

type ActorType = 'user' | 'system' | 'agent';
type Source = 'instance' | 'tenant' | 'both';

interface AuditFilters {
  from?: string;
  to?: string;
  actorType?: ActorType;
  actorId?: string;
  eventType?: string;
  resourceType?: string;
  resourceId?: string;
  source?: Source;
}

interface AuditCoverageTrail {
  throughXid: string | null;
  throughTime: string | null;
}
interface AuditReceipt {
  digest: string;
  algorithm: 'sha256';
  count: number;
  filters: AuditFilters;
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
interface AuditRecord {
  source: 'instance' | 'tenant';
  at: string;
  actor: (Actor & { requestId: string | null }) | null;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  motivo: string | null;
  seq: number | null;
  anchorRef: string | null;
}

function shortDigest(digest: string): string {
  return digest.length > 20 ? `${digest.slice(0, 13)}…${digest.slice(-6)}` : digest;
}
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function presetRange(preset: '7d' | '30d'): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (preset === '7d' ? 7 : 30));
  return { from: from.toISOString(), to: to.toISOString() };
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard indisponível (permissão/contexto) — degrade silencioso, o texto segue selecionável na tela */
  }
}

/** Cobertura das duas trilhas: veredito PRIMEIRO (§1 da marcação), nunca lista crua de xid/tempo. */
function CoverageSection({ coverage, count }: { coverage: AuditReceipt['coverage']; count: number }) {
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

function ReceiptCard({ receipt }: { receipt: AuditReceipt }) {
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

type ExportState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; receipt: AuditReceipt; records: AuditRecord[]; raw: string; format: 'json' | 'csv' };

function ExportSection() {
  const [preset, setPreset] = useState<'7d' | '30d' | 'custom'>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [actorType, setActorType] = useState<ActorType | ''>('');
  const [actorId, setActorId] = useState('');
  const [eventType, setEventType] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [state, setState] = useState<ExportState>({ kind: 'idle' });

  const range = preset === 'custom' ? { from: customFrom || undefined, to: customTo || undefined } : presetRange(preset);

  async function runExport() {
    setState({ kind: 'loading' });
    const { data, error, response } = await api.GET('/v1/audit/export', {
      params: {
        query: {
          ...(range.from ? { from: range.from } : {}),
          ...(range.to ? { to: range.to } : {}),
          ...(actorType ? { actorType } : {}),
          ...(actorId.trim() ? { actorId: actorId.trim() } : {}),
          ...(eventType.trim() ? { eventType: eventType.trim() } : {}),
          ...(resourceType.trim() ? { resourceType: resourceType.trim() } : {}),
          ...(resourceId.trim() ? { resourceId: resourceId.trim() } : {}),
          format,
        },
      },
    });
    if (format === 'csv') {
      // CSV: o corpo é texto cru; o recibo vem no header (nunca no corpo JSON).
      if (response.status !== 200) {
        setState({ kind: 'error', message: problemMessage(error, `Não foi possível exportar (HTTP ${response.status}).`) });
        return;
      }
      const receiptHeader = response.headers.get('X-Audit-Receipt');
      const csvText = typeof data === 'string' ? data : await response.clone().text();
      if (!receiptHeader) {
        setState({ kind: 'error', message: 'Recibo ausente na resposta CSV — não é possível confirmar a exportação.' });
        return;
      }
      const receipt = JSON.parse(receiptHeader) as AuditReceipt;
      setState({ kind: 'ready', receipt, records: [], raw: csvText, format: 'csv' });
      return;
    }
    if (error || !data || typeof data === 'string') {
      setState({ kind: 'error', message: problemMessage(error, `Não foi possível exportar (HTTP ${response.status}).`) });
      return;
    }
    setState({ kind: 'ready', receipt: data.receipt as AuditReceipt, records: data.records as AuditRecord[], raw: JSON.stringify(data, null, 2), format: 'json' });
  }

  function download() {
    if (state.kind !== 'ready') return;
    const blob = new Blob([state.raw], { type: state.format === 'csv' ? 'text/csv' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-export.${state.format}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="audit-export">
      <div className="section-label">EXPORTAR TRILHA</div>
      <div className="audit-filters">
        <label className="field">
          <span>Período</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
            <option value="7d">últimos 7 dias</option>
            <option value="30d">últimos 30 dias</option>
            <option value="custom">personalizado</option>
          </select>
        </label>
        {preset === 'custom' ? (
          <>
            <label className="field">
              <span>De</span>
              <input type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </label>
            <label className="field">
              <span>Até</span>
              <input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </label>
          </>
        ) : (
          <span className="audit-resolved-range mono">
            {range.from && formatDateTime(range.from)} – {range.to && formatDateTime(range.to)}
          </span>
        )}
        <label className="field">
          <span>Formato</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <option value="json">JSON · canônico</option>
            <option value="csv">CSV</option>
          </select>
        </label>
        <label className="field">
          <span>Tipo de ator</span>
          <select value={actorType} onChange={(e) => setActorType(e.target.value as ActorType | '')}>
            <option value="">todos</option>
            <option value="user">pessoa</option>
            <option value="agent">agente</option>
            <option value="system">sistema</option>
          </select>
        </label>
        <label className="field">
          <span>Id do ator</span>
          <input value={actorId} onChange={(e) => setActorId(e.target.value)} placeholder="opcional" />
        </label>
        <label className="field">
          <span>Tipo de evento</span>
          <input value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="opcional" />
        </label>
        <label className="field">
          <span>Recurso — tipo</span>
          <input value={resourceType} onChange={(e) => setResourceType(e.target.value)} placeholder="opcional" />
        </label>
        <label className="field">
          <span>Recurso — id</span>
          <input value={resourceId} onChange={(e) => setResourceId(e.target.value)} placeholder="opcional" />
        </label>
      </div>
      <Button intent="primary" busy={state.kind === 'loading'} onClick={runExport}>
        {state.kind === 'loading' ? 'Preparando o export…' : 'Exportar com recibo'}
      </Button>

      {state.kind === 'error' && (
        <NonIdeal kind="error" title="Falha ao exportar" detail={state.message} action={<Button onClick={runExport}>Tentar novamente</Button>} />
      )}
      {state.kind === 'ready' && state.receipt.count === 0 && (
        <NonIdeal kind="empty" title="Nenhum evento neste recorte." />
      )}
      {state.kind === 'ready' && (
        <>
          <div className="audit-receipt-download">
            <Button intent="neutral" onClick={download}>
              Baixar arquivo
            </Button>
          </div>
          <ReceiptCard receipt={state.receipt} />
        </>
      )}
    </div>
  );
}

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; matches: boolean; expectedDigest: string; actualDigest: string };

function parseReceiptLike(text: string): { digest: string; filters: AuditFilters } | null {
  try {
    const parsed = JSON.parse(text) as { receipt?: AuditReceipt } & Partial<AuditReceipt>;
    const receipt = parsed.receipt ?? (parsed as AuditReceipt);
    if (!receipt?.digest || !receipt.filters) return null;
    return { digest: receipt.digest, filters: receipt.filters };
  } catch {
    return null;
  }
}

function VerifySection() {
  const [pasted, setPasted] = useState('');
  const [state, setState] = useState<VerifyState>({ kind: 'idle' });

  async function verify(text: string) {
    const parsed = parseReceiptLike(text);
    if (!parsed) {
      setState({ kind: 'error', message: 'Não reconheci um recibo válido neste arquivo/texto (esperado digest + filtros).' });
      return;
    }
    setState({ kind: 'loading' });
    const { data, error, response } = await api.POST('/v1/audit/verify', {
      body: { expectedDigest: parsed.digest, filters: parsed.filters },
    });
    if (error || !data) {
      setState({ kind: 'error', message: problemMessage(error, `Não foi possível verificar agora (HTTP ${response.status}).`) });
      return;
    }
    setState({ kind: 'result', matches: data.matches, expectedDigest: data.expectedDigest, actualDigest: data.actualDigest });
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => void verify(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  return (
    <div className="audit-verify">
      <div className="section-label">VERIFICAR INTEGRIDADE</div>
      <div className="audit-verify-drop">
        <p>Arraste o arquivo exportado ou selecione-o — o cliente extrai digest e filtros dele.</p>
        <input type="file" accept="application/json,.json" onChange={onFile} aria-label="Selecionar arquivo exportado" />
      </div>
      <details className="audit-verify-paste">
        <summary>ou cole o recibo (JSON) — para quem guardou só o recibo</summary>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={5}
          className="mono"
          aria-label="Recibo colado (JSON)"
        />
        <Button intent="neutral" busy={state.kind === 'loading'} onClick={() => verify(pasted)} disabled={!pasted.trim()}>
          Verificar
        </Button>
      </details>
      {state.kind === 'error' && (
        <NonIdeal kind="error" title="Não foi possível verificar agora." detail={state.message} action={<Button onClick={() => verify(pasted)}>Tentar novamente</Button>} />
      )}
      {state.kind === 'result' && state.matches && (
        <p className="audit-verdict" role="status">
          <span aria-hidden="true">✓</span> Confere — o arquivo é idêntico ao registrado.
        </p>
      )}
      {state.kind === 'result' && !state.matches && (
        <div className="audit-verdict audit-verdict-warn" role="status">
          <p>
            <span aria-hidden="true">⚠</span> Não confere — a trilha mudou desde este export.
          </p>
          <dl className="audit-receipt-fields">
            <div>
              <dt>esperado</dt>
              <dd className="mono">{shortDigest(state.expectedDigest)}</dd>
            </div>
            <div>
              <dt>atual</dt>
              <dd className="mono">{shortDigest(state.actualDigest)}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

export function AdministrationRoute() {
  const user = useSession();
  if (!user || !can(user.role, 'audit:export')) {
    return <NonIdeal kind="forbidden" title="Sem acesso" detail="Esta área exige a permissão audit:export." />;
  }
  return (
    <div className="route admin">
      <h1>Auditoria</h1>
      <p className="section-caption">
        Exporte a trilha completa para análise externa, ou verifique se um arquivo exportado continua íntegro. Não é o
        Console de Auditoria — é a alavanca mínima para o auditor e o DPO trabalharem.
      </p>
      <ExportSection />
      <VerifySection />
    </div>
  );
}
