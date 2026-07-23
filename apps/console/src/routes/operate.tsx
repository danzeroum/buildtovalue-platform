import { Suspense, lazy, useState } from 'react';
import type { BpmnDiagram } from '@buildtovalue/core';
import '@buildtovalue/react/styles.css';
import { api, problemMessage } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import type {
  Incident,
  InstanceDetail,
  InstanceItem,
  Job,
  Timer,
  VariableView,
} from '../api/types.js';
import { can } from '../capabilities.js';
import { relativeTime, shortId } from '../format.js';
import { useSession } from '../shell.js';
import { Button, NonIdeal, StatusPill, Tag } from '../ui/ui.js';

type StatusFilter = '' | 'active' | 'incident' | 'completed' | 'cancelled';
type OpTab = 'incidents' | 'jobs' | 'timers' | 'variables' | 'history';

/**
 * /operate (F3.5) — persona de operador. Lista com cursor + filtros, drill-down
 * com a POSIÇÃO no diagrama (viewer da biblioteca + overlay de token),
 * incidentes (retry/resolve auditados), jobs/timers, histórico, export XES e
 * VARIÁVEIS com sensível SEMPRE mascarada (D20) — revelação por permissão,
 * com motivo, auditada.
 */
export function OperateRoute() {
  const [status, setStatus] = useState<StatusFilter>('');
  const [businessKey, setBusinessKey] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const bump = () => setReloadKey((n) => n + 1);

  const list = useResource(
    (signal) =>
      api.GET('/v1/instances', {
        params: {
          query: {
            limit: 50,
            ...(status ? { status } : {}),
            ...(query.trim() ? { businessKey: query.trim() } : {}),
          },
        },
        signal,
      }),
    [status, query, reloadKey],
  );

  const items: InstanceItem[] = list.value.state === 'ready' ? list.value.data.items : [];

  return (
    <section className="route operate" aria-label="Operação">
      <div className="operate-list" aria-label="Instâncias">
        <div className="operate-filters">
          <input
            className="rail-search"
            placeholder="business key…"
            aria-label="Buscar por business key"
            value={businessKey}
            onChange={(e) => setBusinessKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setQuery(businessKey);
            }}
          />
          <select
            aria-label="Filtrar por status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as StatusFilter);
              setSelected(null);
            }}
          >
            <option value="">status: todos</option>
            <option value="active">ativas</option>
            <option value="incident">com incidente</option>
            <option value="completed">concluídas</option>
            <option value="cancelled">canceladas</option>
          </select>
        </div>
        <div className="quick-filters">
          <button
            type="button"
            className="chip danger"
            data-selected={status === 'incident' || undefined}
            onClick={() => {
              setStatus(status === 'incident' ? '' : 'incident');
              setSelected(null);
            }}
          >
            só incidentes
          </button>
        </div>

        <div className="operate-items">
          {list.value.state === 'loading' && <NonIdeal kind="loading" title="Carregando instâncias…" />}
          {list.value.state === 'forbidden' && (
            <NonIdeal kind="forbidden" title="Sem acesso à operação" detail={list.value.detail} />
          )}
          {list.value.state === 'error' && (
            <NonIdeal
              kind="error"
              title="Não foi possível carregar"
              detail={list.value.message}
              action={<Button onClick={() => list.reload()}>Tentar novamente</Button>}
            />
          )}
          {list.value.state === 'ready' && items.length === 0 && (
            <NonIdeal
              kind="empty"
              title={query ? `Nada com «${query}»` : 'Nenhuma instância'}
              detail="Confira a business key ou limpe os filtros. Campos sensíveis não são buscáveis por conteúdo."
              action={
                query || status ? (
                  <button type="button" className="link-btn" onClick={() => { setStatus(''); setQuery(''); setBusinessKey(''); }}>
                    Limpar filtros
                  </button>
                ) : undefined
              }
            />
          )}
          {list.value.state === 'ready' &&
            items.map((i) => (
              <button
                key={i.id}
                type="button"
                className="operate-item"
                data-selected={i.id === selected || undefined}
                data-incident={i.status === 'incident' || undefined}
                aria-current={i.id === selected || undefined}
                onClick={() => setSelected(i.id)}
              >
                <div>
                  <div className="mono oi-key">{i.businessKey ?? shortId(i.id)}</div>
                  <div className="oi-def">{i.definitionRef}</div>
                </div>
                <StatusPill status={i.status} />
              </button>
            ))}
        </div>
      </div>

      <div className="operate-detail">
        {selected ? (
          <InstanceDetailPane key={selected} instanceId={selected} onChanged={bump} />
        ) : (
          <NonIdeal kind="empty" title="Selecione uma instância" detail="Posição, incidentes, variáveis e histórico aparecem aqui." />
        )}
      </div>
    </section>
  );
}

const PositionViewer = lazy(async () => {
  const [viewer, sim] = await Promise.all([
    import('@buildtovalue/react/viewer'),
    import('@buildtovalue/react/simulation'),
  ]);
  function Position({ diagram, tokenNodeIds }: { diagram: BpmnDiagram; tokenNodeIds: string[] }) {
    return (
      <viewer.BpmnViewer
        diagram={diagram}
        messages={viewer.PT_BR}
        overlay={
          <sim.SimulationOverlaySvg
            tokenNodeIds={tokenNodeIds}
            traversedEdges={[]}
            travels={[]}
            clearTravel={() => {}}
          />
        }
      />
    );
  }
  return { default: Position };
});

function InstanceDetailPane({ instanceId, onChanged }: { instanceId: string; onChanged: () => void }) {
  const user = useSession()!;
  const canAct = can(user.role, 'operate:act');
  const canReadOp = can(user.role, 'operate:read');
  const detail = useResource(
    (signal) => api.GET('/v1/instances/{id}', { params: { path: { id: instanceId } }, signal }),
    [instanceId],
  );
  // Incidentes/Jobs/Timers exigem operate:read; sem ela, começa em Variáveis
  // (que usa instances:read). Não oferecemos aba que só devolveria 403.
  const [tab, setTab] = useState<OpTab>(canReadOp ? 'incidents' : 'variables');
  const [cancelling, setCancelling] = useState(false);

  if (detail.value.state === 'loading') return <NonIdeal kind="loading" title="Carregando instância…" />;
  if (detail.value.state === 'forbidden')
    return <NonIdeal kind="forbidden" title="Sem acesso" detail={detail.value.detail} />;
  if (detail.value.state === 'error')
    return (
      <NonIdeal
        kind="error"
        title="Não foi possível carregar"
        detail={detail.value.message}
        action={<Button onClick={() => detail.reload()}>Tentar novamente</Button>}
      />
    );

  const inst = detail.value.data;
  const canCancel = canAct; // a rota de cancelamento exige operate:act
  const tabs: [OpTab, string][] = [
    ...(canReadOp
      ? ([
          ['incidents', 'Incidentes'],
          ['jobs', 'Jobs'],
          ['timers', 'Timers'],
        ] as [OpTab, string][])
      : []),
    ['variables', 'Variáveis'],
    ['history', 'Histórico'],
  ];

  async function exportXes() {
    const { data } = await api.GET('/v1/instances/{id}/export', {
      params: { path: { id: instanceId }, query: { format: 'xes' } },
      parseAs: 'text',
    });
    if (typeof data === 'string' && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(new Blob([data], { type: 'application/xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `instancia-${shortId(instanceId)}.xes`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  return (
    <div className="instance-detail">
      <div className="doc-bar">
        <div>
          <h1 className="mono">{shortId(inst.id)}</h1>
          <div className="inst-sub mono">
            {inst.definitionRef} · revision {inst.revision} · <StatusPill status={inst.status} />
          </div>
        </div>
        <div className="doc-actions">
          {canReadOp && (
            <Button intent="neutral" onClick={exportXes}>
              Exportar XES
            </Button>
          )}
          {canCancel && inst.status === 'active' && (
            <Button intent="danger" onClick={() => setCancelling(true)}>
              Cancelar instância…
            </Button>
          )}
        </div>
      </div>

      <PositionSection instance={inst} />

      <div className="op-tabs" role="tablist" aria-label="Detalhe da instância">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className="op-tab"
            data-selected={tab === key || undefined}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="op-tabpanel" role="tabpanel">
        {tab === 'incidents' && <IncidentsTab instanceId={inst.id} canAct={canAct} onChanged={onChanged} />}
        {tab === 'jobs' && <JobsTab instanceId={inst.id} />}
        {tab === 'timers' && <TimersTab instanceId={inst.id} />}
        {tab === 'variables' && <VariablesTab instanceId={inst.id} canReveal={can(user.role, 'variables:reveal-sensitive')} />}
        {tab === 'history' && <HistoryTab instanceId={inst.id} />}
      </div>

      {cancelling && (
        <CancelModal
          instanceId={inst.id}
          onClose={() => setCancelling(false)}
          onDone={() => {
            setCancelling(false);
            detail.reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** Posição atual: viewer da biblioteca + overlay de token; texto é o fallback honesto. */
function PositionSection({ instance }: { instance: InstanceDetail }) {
  const diagram = useResource(
    (signal) =>
      api.GET('/v1/process-definitions/{idOrRef}', {
        params: { path: { idOrRef: instance.definitionRef } },
        signal,
      }),
    [instance.definitionRef],
  );
  const tokens = instance.currentElements;
  return (
    <section className="position" aria-label="Posição atual">
      <header className="section-label">POSIÇÃO ATUAL (VIEWER DA BIBLIOTECA)</header>
      {diagram.value.state === 'ready' ? (
        <div className="position-canvas">
          <Suspense fallback={<NonIdeal kind="loading" title="Carregando diagrama…" />}>
            <PositionViewer
              diagram={diagram.value.data.diagram as unknown as BpmnDiagram}
              tokenNodeIds={tokens}
            />
          </Suspense>
        </div>
      ) : diagram.value.state === 'loading' ? (
        <NonIdeal kind="loading" title="Carregando diagrama…" />
      ) : (
        <p className="position-fallback">Diagrama indisponível para esta definição — posição por elemento abaixo.</p>
      )}
      <p className="position-caption mono" aria-live="polite">
        {tokens.length === 0 ? 'sem token vivo' : `token em: ${tokens.join(', ')}`}
      </p>
    </section>
  );
}

function IncidentsTab({ instanceId, canAct, onChanged }: { instanceId: string; canAct: boolean; onChanged: () => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  const res = useResource(
    (signal) => api.GET('/v1/incidents', { params: { query: { instanceId, limit: 100 } }, signal }),
    [instanceId, reloadKey],
  );

  async function retry(id: string) {
    setNote(null);
    const { data, error, response } = await api.POST('/v1/incidents/{id}/retry', { params: { path: { id } } });
    if (error || !data) {
      // 409 = dead-letter não re-enfileirável na v1 (ERRATA §7) → aponta Resolver
      setNote({ id, text: problemMessage(error, `Não re-tentável (HTTP ${response.status}). Use «Resolver…».`) });
      return;
    }
    setNote({ id, text: `Re-armados ${data.rearmedJobs} job(s). Incidente marcado como re-tentado.` });
    setReloadKey((n) => n + 1);
    onChanged();
  }

  if (res.value.state === 'loading') return <NonIdeal kind="loading" title="Carregando incidentes…" />;
  if (res.value.state === 'forbidden') return <NonIdeal kind="forbidden" title="Sem acesso" detail={res.value.detail} />;
  if (res.value.state === 'error')
    return <NonIdeal kind="error" title="Falha ao carregar" detail={res.value.message} action={<Button onClick={() => res.reload()}>Tentar novamente</Button>} />;
  const incidents: Incident[] = res.value.data.items;
  if (incidents.length === 0) return <NonIdeal kind="empty" title="Nenhum incidente" detail="Nada exige intervenção nesta instância." />;

  return (
    <ul className="incident-list">
      {incidents.map((i) => (
        <li key={i.id} className="incident-card" data-status={i.status}>
          <div className="incident-body">
            <strong className="incident-kind">{i.kind}</strong>
            <span>{i.message}</span>
            <span className="mono incident-meta">
              <StatusPill status={i.status} /> · {relativeTime(i.createdAt)}
            </span>
            {note?.id === i.id && (
              <span className="incident-note" role="status" aria-live="polite">
                {note.text}
              </span>
            )}
          </div>
          {canAct && i.status === 'open' && (
            <div className="incident-actions">
              <Button intent="neutral" onClick={() => retry(i.id)}>
                Repetir
              </Button>
              <Button intent="neutral" onClick={() => setResolving(i.id)}>
                Resolver…
              </Button>
            </div>
          )}
        </li>
      ))}
      {resolving && (
        <ResolveModal
          incidentId={resolving}
          onClose={() => setResolving(null)}
          onDone={() => {
            setResolving(null);
            setReloadKey((n) => n + 1);
            onChanged();
          }}
        />
      )}
    </ul>
  );
}

function TabStates({ res }: { res: ReturnType<typeof useResource> }) {
  if (res.value.state === 'loading') return <NonIdeal kind="loading" title="Carregando…" />;
  if (res.value.state === 'forbidden') return <NonIdeal kind="forbidden" title="Sem acesso" detail={res.value.detail} />;
  return (
    <NonIdeal
      kind="error"
      title="Falha ao carregar"
      detail={res.value.state === 'error' ? res.value.message : ''}
      action={<Button onClick={() => res.reload()}>Tentar novamente</Button>}
    />
  );
}

function JobsTab({ instanceId }: { instanceId: string }) {
  const res = useResource(
    (signal) => api.GET('/v1/jobs', { params: { query: { instanceId, limit: 100 } }, signal }),
    [instanceId],
  );
  if (res.value.state !== 'ready') return <TabStates res={res} />;
  const jobs: Job[] = res.value.data.items;
  if (jobs.length === 0) return <NonIdeal kind="empty" title="Nenhum job" />;
  return (
    <table className="op-table">
      <thead>
        <tr>
          <th>Tipo</th>
          <th>Estado</th>
          <th>Retries</th>
          <th>Erro</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id}>
            <td className="mono">{j.type}</td>
            <td>
              <StatusPill status={j.status} />
            </td>
            <td>{j.retriesLeft}</td>
            <td className="job-error">{j.error ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TimersTab({ instanceId }: { instanceId: string }) {
  const res = useResource(
    (signal) => api.GET('/v1/timers', { params: { query: { instanceId, limit: 100 } }, signal }),
    [instanceId],
  );
  if (res.value.state !== 'ready') return <TabStates res={res} />;
  const timers: Timer[] = res.value.data.items;
  if (timers.length === 0) return <NonIdeal kind="empty" title="Nenhum timer" />;
  return (
    <table className="op-table">
      <thead>
        <tr>
          <th>Elemento</th>
          <th>Dispara em</th>
          <th>Estado</th>
        </tr>
      </thead>
      <tbody>
        {timers.map((t) => (
          <tr key={t.id}>
            <td className="mono">{t.elementId}</td>
            <td className="mono">{t.fireAt}</td>
            <td>
              <StatusPill status={t.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VariablesTab({ instanceId, canReveal }: { instanceId: string; canReveal: boolean }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, unknown>>({});
  const res = useResource(
    (signal) => api.GET('/v1/instances/{id}/variables', { params: { path: { id: instanceId } }, signal }),
    [instanceId, reloadKey],
  );

  if (res.value.state === 'loading') return <NonIdeal kind="loading" title="Carregando variáveis…" />;
  if (res.value.state === 'forbidden') return <NonIdeal kind="forbidden" title="Sem acesso" detail={res.value.detail} />;
  if (res.value.state === 'error')
    return <NonIdeal kind="error" title="Falha ao carregar" detail={res.value.message} action={<Button onClick={() => res.reload()}>Tentar novamente</Button>} />;
  const vars: VariableView[] = res.value.data.items;
  if (vars.length === 0) return <NonIdeal kind="empty" title="Sem variáveis" />;

  return (
    <>
      <p className="var-note">
        Variáveis <strong>sensíveis</strong> chegam mascaradas (D20). A revelação é individual, exige motivo e é
        auditada (LGPD art. 37).
      </p>
      <table className="op-table var-table">
        <thead>
          <tr>
            <th>Nome</th>
            <th>Classificação</th>
            <th>Valor</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {vars.map((v) => {
            const shown = v.name in revealed;
            // FAIL-CLOSED (D20): mascara se o servidor sinalizou `masked` OU se a
            // classificação é `sensitive` — nunca confia num único flag para não
            // vazar caso o servidor esqueça de mascarar. Só a revelação auditada abre.
            const mustMask = v.masked === true || v.classification === 'sensitive';
            return (
              <tr key={v.name} data-sensitive={v.classification === 'sensitive' || undefined}>
                <td className="mono">{v.name}</td>
                <td>
                  {v.classification === 'sensitive' ? (
                    <Tag tone="sensitive">SENSÍVEL</Tag>
                  ) : v.classification === 'personal' ? (
                    <Tag tone="personal">PESSOAL</Tag>
                  ) : (
                    <Tag tone="neutral">comum</Tag>
                  )}
                </td>
                <td className="var-value">
                  {mustMask && !shown ? (
                    <span className="masked" aria-label="valor mascarado">
                      ••••••
                    </span>
                  ) : (
                    <span className="mono">{JSON.stringify(shown ? revealed[v.name] : v.value)}</span>
                  )}
                </td>
                <td>
                  {mustMask && !shown && canReveal && (
                    <Button intent="neutral" onClick={() => setRevealing(v.name)}>
                      Revelar…
                    </Button>
                  )}
                  {shown && <span className="revealed-note">revelado — não fica salvo na tela</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {revealing && (
        <RevealModal
          instanceId={instanceId}
          name={revealing}
          onClose={() => setRevealing(null)}
          onRevealed={(name, value) => {
            setRevealed((r) => ({ ...r, [name]: value }));
            setRevealing(null);
          }}
        />
      )}
      <button type="button" className="link-btn tiny reload-vars" onClick={() => { setRevealed({}); setReloadKey((n) => n + 1); }}>
        recarregar (re-mascara)
      </button>
    </>
  );
}

function HistoryTab({ instanceId }: { instanceId: string }) {
  const res = useResource(
    (signal) => api.GET('/v1/instances/{id}/history', { params: { path: { id: instanceId }, query: { limit: 100 } }, signal }),
    [instanceId],
  );
  if (res.value.state === 'loading') return <NonIdeal kind="loading" title="Carregando histórico…" />;
  if (res.value.state === 'forbidden') return <NonIdeal kind="forbidden" title="Sem acesso" detail={res.value.detail} />;
  if (res.value.state === 'error')
    return <NonIdeal kind="error" title="Falha ao carregar" detail={res.value.message} action={<Button onClick={() => res.reload()}>Tentar novamente</Button>} />;
  const events = res.value.data.items;
  if (events.length === 0) return <NonIdeal kind="empty" title="Sem histórico" />;
  return (
    <ol className="history-list mono">
      {events.map((e) => (
        <li key={e.seq}>
          <span className="seq">seq {e.seq}</span> · <strong>{e.kind}</strong> ·{' '}
          <span className="hist-when">{relativeTime(e.occurredAt)}</span>
        </li>
      ))}
    </ol>
  );
}

function ReasonModal({
  title,
  note,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  note: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<string | null>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <header>
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>
        <p className="modal-note">{note}</p>
        <label className="field">
          <span>Motivo (obrigatório — vai para a auditoria)</span>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </label>
        {error && (
          <p className="inline-banner tone-danger" role="alert" aria-live="assertive">
            {error}
          </p>
        )}
        <footer className="modal-actions">
          <Button intent="neutral" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            intent="primary"
            disabled={reason.trim().length === 0}
            onClick={async () => {
              const err = await onConfirm(reason.trim());
              if (err) setError(err);
            }}
          >
            {confirmLabel}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function CancelModal({ instanceId, onClose, onDone }: { instanceId: string; onClose: () => void; onDone: () => void }) {
  return (
    <ReasonModal
      title="Cancelar instância"
      note="Fecha TODAS as esperas da instância. O motivo é obrigatório e vai para o histórico (auditoria)."
      confirmLabel="Cancelar instância"
      onClose={onClose}
      onConfirm={async (reason) => {
        const { data, error, response } = await api.POST('/v1/instances/{id}/cancellation', {
          params: { path: { id: instanceId } },
          body: { reason },
        });
        if (error || !data) return problemMessage(error, `Cancelamento recusado (HTTP ${response.status}).`);
        onDone();
        return null;
      }}
    />
  );
}

function ResolveModal({ incidentId, onClose, onDone }: { incidentId: string; onClose: () => void; onDone: () => void }) {
  return (
    <ReasonModal
      title="Resolver incidente"
      note="Marca o incidente como resolvido manualmente. O motivo é obrigatório e auditado."
      confirmLabel="Resolver"
      onClose={onClose}
      onConfirm={async (reason) => {
        const { data, error, response } = await api.POST('/v1/incidents/{id}/resolution', {
          params: { path: { id: incidentId } },
          body: { reason },
        });
        if (error || !data) return problemMessage(error, `Resolução recusada (HTTP ${response.status}).`);
        onDone();
        return null;
      }}
    />
  );
}

function RevealModal({
  instanceId,
  name,
  onClose,
  onRevealed,
}: {
  instanceId: string;
  name: string;
  onClose: () => void;
  onRevealed: (name: string, value: unknown) => void;
}) {
  return (
    <ReasonModal
      title={`Revelar «${name}»`}
      note="Revela UMA variável sensível. O motivo é obrigatório e a revelação é auditada (LGPD art. 37)."
      confirmLabel="Revelar"
      onClose={onClose}
      onConfirm={async (reason) => {
        const { data, error, response } = await api.POST('/v1/instances/{id}/variables/{name}/reveal', {
          params: { path: { id: instanceId, name } },
          body: { reason },
        });
        if (error || !data) return problemMessage(error, `Revelação recusada (HTTP ${response.status}).`);
        onRevealed(data.name, data.value);
        return null;
      }}
    />
  );
}
