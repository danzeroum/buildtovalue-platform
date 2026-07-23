import { useMemo, useState } from 'react';
import { FormRenderer } from '@buildtovalue/forms-react';
import { applyDefaults, validateSubmission, type FormSchema, type SubmissionErrors } from '@buildtovalue/forms';
import '@buildtovalue/forms-react/styles.css';
import { api, problemMessage } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import type { FormDefByRef, ProcessItem, TaskDetail, TaskItem } from '../api/types.js';
import { can } from '../capabilities.js';
import { consoleEvaluator } from '../sfeel.js';
import { relativeTime, shortId } from '../format.js';
import { useSession } from '../shell.js';
import { Button, NonIdeal, StatusPill, Tag } from '../ui/ui.js';

type Filter = 'mine' | 'role' | 'unassigned';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'mine', label: 'Minhas' },
  { key: 'role', label: 'Do meu papel' },
  { key: 'unassigned', label: 'Não atribuídas' },
];

/**
 * /tasks (F3.4) — persona de negócio. Claim persistente (D21): assumir devolve
 * um claimToken ROTACIONADO que a conclusão exige (fencing); só o dono libera
 * (ou o operador, por /assignment auditado — D24). O formulário é o PINADO
 * (formId@versão), renderizado pelo MESMO renderer de /forms; a submissão é
 * revalidada no servidor. Papel alheio já vem filtrado da lista.
 */
export function TasksRoute() {
  const user = useSession();
  const [filter, setFilter] = useState<Filter>('mine');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const bumpList = () => setReloadKey((n) => n + 1);

  const list = useResource(
    (signal) => api.GET('/v1/user-tasks', { params: { query: { filter, status: 'open', limit: 50 } }, signal }),
    [filter, reloadKey],
  );

  const items: TaskItem[] = list.value.state === 'ready' ? list.value.data.items : [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (t) => t.elementId.toLowerCase().includes(q) || t.formRef.toLowerCase().includes(q) || t.instanceId.includes(q),
    );
  }, [items, search]);

  if (!user) return null;
  const canStart = can(user.role, 'instances:start');

  return (
    <section className="route tasks" aria-label="Tarefas">
      <aside className="tasks-rail" aria-label="Filtros de tarefas">
        {canStart && (
          <Button intent="primary" onClick={() => setStarting(true)}>
            + Iniciar processo
          </Button>
        )}
        <input
          className="rail-search"
          placeholder="Buscar por elemento, formulário ou instância…"
          aria-label="Buscar tarefa"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="filter-group" role="radiogroup" aria-label="Escopo das tarefas">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="radio"
              aria-checked={filter === f.key}
              className="filter-item"
              data-selected={filter === f.key || undefined}
              onClick={() => {
                setFilter(f.key);
                setSelected(null);
              }}
            >
              <span>{f.label}</span>
              {filter === f.key && list.value.state === 'ready' && <span className="count">{items.length}</span>}
            </button>
          ))}
        </div>
      </aside>

      <div className="tasks-list" aria-label="Lista de tarefas">
        <header className="list-head">
          {list.value.state === 'ready' ? `${filtered.length} tarefa(s)` : 'Tarefas'}
        </header>
        {list.value.state === 'loading' && <NonIdeal kind="loading" title="Carregando tarefas…" />}
        {list.value.state === 'forbidden' && (
          <NonIdeal kind="forbidden" title="Sem acesso às tarefas" detail={list.value.detail} />
        )}
        {list.value.state === 'error' && (
          <NonIdeal
            kind="error"
            title="Não foi possível carregar"
            detail={list.value.message}
            action={<Button onClick={() => list.reload()}>Tentar novamente</Button>}
          />
        )}
        {list.value.state === 'ready' && filtered.length === 0 && (
          <NonIdeal
            kind="empty"
            title={filter === 'mine' ? 'Nenhuma tarefa para você' : 'Nada aqui'}
            detail={
              filter === 'mine'
                ? 'Quando um processo chegar a uma etapa sua, ela aparece aqui.'
                : 'Ajuste o filtro ou a busca.'
            }
            action={
              filter !== 'role' ? (
                <button type="button" className="link-btn" onClick={() => setFilter('role')}>
                  ver tarefas do meu papel
                </button>
              ) : undefined
            }
          />
        )}
        {list.value.state === 'ready' &&
          filtered.map((t) => (
            <button
              key={t.id}
              type="button"
              className="task-item"
              data-selected={t.id === selected || undefined}
              aria-current={t.id === selected || undefined}
              onClick={() => setSelected(t.id)}
            >
              <div className="task-item-top">
                <strong>{t.elementId}</strong>
                <span className="task-age mono">{relativeTime(t.createdAt)}</span>
              </div>
              <div className="task-item-meta mono">
                {t.formRef} · inst {shortId(t.instanceId)}
              </div>
              <div className="task-tags">
                {t.assignee && t.assignee === user.id && <Tag tone="success">minha</Tag>}
                {!t.assignee && <Tag tone="neutral">não atribuída</Tag>}
              </div>
            </button>
          ))}
      </div>

      <div className="task-detail-wrap">
        {selected ? (
          <TaskDetailPane key={selected} taskId={selected} onChanged={bumpList} />
        ) : (
          <NonIdeal kind="empty" title="Selecione uma tarefa" detail="Os detalhes e o formulário aparecem aqui." />
        )}
      </div>

      {starting && <StartInstanceModal onClose={() => setStarting(false)} />}
    </section>
  );
}

/** Detalhe + formulário pinado + ações de claim/conclusão/reatribuição. */
function TaskDetailPane({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const user = useSession();
  const detail = useResource(
    (signal) => api.GET('/v1/user-tasks/{id}', { params: { path: { id: taskId } }, signal }),
    [taskId],
  );

  if (detail.value.state === 'loading') return <NonIdeal kind="loading" title="Carregando tarefa…" />;
  if (detail.value.state === 'forbidden')
    return <NonIdeal kind="forbidden" title="Tarefa de outro papel" detail={detail.value.detail} />;
  if (detail.value.state === 'error')
    return (
      <NonIdeal
        kind="error"
        title="Não foi possível carregar a tarefa"
        detail={detail.value.message}
        action={<Button onClick={() => detail.reload()}>Tentar novamente</Button>}
      />
    );

  const task = detail.value.data;
  return (
    <TaskForm
      task={task}
      me={user!.id}
      canWork={can(user!.role, 'tasks:work')}
      canReassign={can(user!.role, 'operate:act')}
      onChanged={onChanged}
    />
  );
}

function TaskForm({
  task,
  me,
  canWork,
  canReassign,
  onChanged,
}: {
  task: TaskDetail;
  me: string;
  canWork: boolean;
  canReassign: boolean;
  onChanged: () => void;
}) {
  const form = useResource(
    (signal) => api.GET('/v1/form-definitions/{ref}', { params: { path: { ref: task.formRef } }, signal }),
    [task.formRef],
  );
  const [reassigning, setReassigning] = useState(false);

  if (form.value.state === 'loading') return <NonIdeal kind="loading" title="Carregando formulário pinado…" />;
  if (form.value.state === 'forbidden')
    return <NonIdeal kind="forbidden" title="Sem acesso ao formulário" detail={form.value.detail} />;
  if (form.value.state === 'error')
    return (
      <NonIdeal
        kind="error"
        title="Formulário indisponível"
        detail={form.value.message}
        action={<Button onClick={() => form.reload()}>Tentar novamente</Button>}
      />
    );

  return (
    <TaskFormLoaded
      task={task}
      formDef={form.value.data}
      me={me}
      canWork={canWork}
      canReassign={canReassign}
      reassigning={reassigning}
      setReassigning={setReassigning}
      onChanged={onChanged}
    />
  );
}

function TaskFormLoaded({
  task,
  formDef,
  me,
  canWork,
  canReassign,
  reassigning,
  setReassigning,
  onChanged,
}: {
  task: TaskDetail;
  formDef: FormDefByRef;
  me: string;
  canWork: boolean;
  canReassign: boolean;
  reassigning: boolean;
  setReassigning: (v: boolean) => void;
  onChanged: () => void;
}) {
  const schema = formDef.schema as unknown as FormSchema;
  // Semeia SÓ com chaves do schema — payload pode trazer variáveis extra da
  // instância, e a validação (servidor e cliente) rejeita chave desconhecida.
  const initial = useMemo(() => {
    const seed: Record<string, unknown> = {};
    for (const f of schema.fields) if (f.key in task.payload) seed[f.key] = task.payload[f.key];
    return applyDefaults(schema, seed);
  }, [schema, task.payload]);

  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [claimToken, setClaimToken] = useState<string | null>(null);
  const [errors, setErrors] = useState<SubmissionErrors | undefined>();
  const [banner, setBanner] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const [holder, setHolder] = useState<{ user: string; since: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const mine = task.assignee === me;
  const held = task.assignee !== null && !mine;

  async function claim() {
    setBanner(null);
    setHolder(null);
    const { data, error, response } = await api.POST('/v1/user-tasks/{id}/claim', {
      params: { path: { id: task.id } },
    });
    if (error || !data) {
      if (response.status === 409) {
        const h = (error as { holder?: { user: string; since: string } } | undefined)?.holder;
        setHolder(h ?? null);
        setBanner({ tone: 'danger', text: problemMessage(error, 'Tarefa já reivindicada por outra pessoa.') });
        return;
      }
      setBanner({ tone: 'danger', text: problemMessage(error, `Não foi possível assumir (HTTP ${response.status}).`) });
      return;
    }
    setClaimToken(data.claimToken);
    setBanner({ tone: 'success', text: 'Tarefa assumida — o claim é persistente e não expira.' });
    onChanged();
  }

  async function unclaim() {
    const { error, response } = await api.DELETE('/v1/user-tasks/{id}/claim', {
      params: { path: { id: task.id } },
    });
    if (error && response.status !== 204) {
      setBanner({ tone: 'danger', text: problemMessage(error, 'Não foi possível liberar a tarefa.') });
      return;
    }
    setClaimToken(null);
    setBanner({ tone: 'success', text: 'Tarefa liberada.' });
    onChanged();
  }

  async function complete() {
    setErrors(undefined);
    setBanner(null);
    const local = validateSubmission(schema, values, consoleEvaluator);
    if (!local.ok) {
      setErrors(local.errors);
      return;
    }
    if (!claimToken) {
      setBanner({ tone: 'danger', text: 'Assuma a tarefa antes de concluir (o claim gera o token exigido).' });
      return;
    }
    const { data, error, response } = await api.POST('/v1/user-tasks/{id}/completion', {
      params: { path: { id: task.id } },
      body: { claimToken, submission: local.values },
    });
    if (error || !data) {
      if (response.status === 422) {
        const serverErrors = (error as { errors?: SubmissionErrors } | undefined)?.errors;
        setErrors(serverErrors ?? { _form: [problemMessage(error, 'Submissão recusada pelo servidor.')] });
        return;
      }
      if (response.status === 409) {
        setClaimToken(null); // token invalidado (reatribuição/fencing) — reassuma
        setBanner({ tone: 'danger', text: problemMessage(error, 'Conclusão recusada — o claim não é mais válido. Reassuma a tarefa.') });
        return;
      }
      setBanner({ tone: 'danger', text: problemMessage(error, `Falha ao concluir (HTTP ${response.status}).`) });
      return;
    }
    setDone(data.instanceStatus);
    onChanged();
  }

  if (done) {
    return (
      <div className="task-done" role="status" aria-live="polite">
        <h1>Tarefa concluída</h1>
        <p>
          A submissão passou na validação do servidor e a instância avançou — estado agora{' '}
          <StatusPill status={done} />.
        </p>
      </div>
    );
  }

  return (
    <div className="task-form">
      <div className="doc-bar">
        <div>
          <h1>{schema.title || task.elementId}</h1>
          <div className="task-sub mono">
            inst {shortId(task.instanceId)} · {task.elementId} · form pinado{' '}
            <span className="pin-ref">{task.formRef}</span>
            <PinWhy formRef={task.formRef} />
          </div>
        </div>
        <div className="doc-actions">
          {canWork && claimToken && (
            <Button intent="neutral" onClick={unclaim}>
              Desatribuir…
            </Button>
          )}
          {canReassign && (
            <Button intent="neutral" onClick={() => setReassigning(true)}>
              Reatribuir…
            </Button>
          )}
        </div>
      </div>

      <p className="claim-banner">
        Claim persistente (D21) — não expira; só você (ou um operador, com auditoria) pode liberar esta tarefa.
      </p>

      {banner && (
        <div className={`inline-banner tone-${banner.tone}`} role={banner.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
          {banner.text}
          {holder && (
            <span className="holder">
              {' '}
              com <strong>{holder.user}</strong> desde {relativeTime(holder.since)}.
            </span>
          )}
        </div>
      )}

      {errors?._form && (
        <div className="inline-banner tone-danger" role="alert" aria-live="assertive">
          {errors._form.join(' · ')}
        </div>
      )}

      <div className="task-form-body" data-locked={!claimToken || undefined}>
        <FormRenderer
          schema={schema}
          values={values}
          evaluator={consoleEvaluator}
          errors={errors}
          disabled={!claimToken}
          onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
        />
      </div>

      <footer className="task-foot">
        <span className="foot-note">
          A submissão é revalidada no servidor pelo MESMO schema antes de avançar a instância.
        </span>
        <div className="foot-actions">
          {!canWork ? (
            <span className="foot-note">Seu papel não trabalha tarefas — somente leitura.</span>
          ) : !claimToken ? (
            <Button intent="primary" onClick={claim} disabled={held}>
              {mine ? 'Retomar (renova o claim)' : 'Assumir tarefa'}
            </Button>
          ) : (
            <Button intent="primary" onClick={complete}>
              Concluir tarefa
            </Button>
          )}
        </div>
      </footer>

      {reassigning && (
        <ReassignModal taskId={task.id} onClose={() => setReassigning(false)} onDone={() => { setReassigning(false); setClaimToken(null); onChanged(); }} />
      )}
    </div>
  );
}

/** Micro-afordância D3: por que ESTA versão? (instância fixa a versão pinada). */
function PinWhy({ formRef }: { formRef: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="pin-why">
      <button type="button" className="link-btn tiny" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        por que {formRef}?
      </button>
      {open && (
        <span className="pin-why-pop" role="note">
          A instância foi iniciada sob esta versão do formulário e permanece nela — versões novas valem só para
          instâncias futuras (D3: schema é artefato versionado do registry).
        </span>
      )}
    </span>
  );
}

/** Reatribuição por operador (D24) — motivo obrigatório, auditado. */
function ReassignModal({ taskId, onClose, onDone }: { taskId: string; onClose: () => void; onDone: () => void }) {
  const [assignee, setAssignee] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const { data, error: err, response } = await api.POST('/v1/user-tasks/{id}/assignment', {
      params: { path: { id: taskId } },
      body: { assignee: assignee.trim(), reason: reason.trim() },
    });
    if (err || !data) {
      setError(problemMessage(err, `Reatribuição recusada (HTTP ${response.status}).`));
      return;
    }
    onDone();
  }

  const valid = assignee.trim().length > 0 && reason.trim().length > 0;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Reatribuir tarefa">
      <div className="modal">
        <header>
          <h2>Reatribuir tarefa</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>
        <p className="modal-note">
          Invalida o claim atual e passa a tarefa a outra pessoa. A ação é <strong>auditada</strong> com o motivo (D24).
        </p>
        <label className="field">
          <span>Novo responsável</span>
          <input value={assignee} onChange={(e) => setAssignee(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Motivo (obrigatório — vai para a auditoria)</span>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
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
          <Button intent="primary" onClick={submit} disabled={!valid}>
            Reatribuir
          </Button>
        </footer>
      </div>
    </div>
  );
}

/** Iniciar processo (tela 05) — fecha o fluxo-alvo; Idempotency-Key no POST. */
function StartInstanceModal({ onClose }: { onClose: () => void }) {
  const defs = useResource(
    (signal) => api.GET('/v1/process-definitions', { params: { query: { limit: 50 } }, signal }),
    [],
  );
  const [ref, setRef] = useState<string | null>(null);
  const [businessKey, setBusinessKey] = useState('');
  const [result, setResult] = useState<{ id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Chave estável POR SESSÃO do modal: uma re-tentativa manual do MESMO início
  // não cria uma segunda instância (o servidor replica a resposta 201).
  const [idemKey] = useState(() => crypto.randomUUID());

  async function start() {
    setError(null);
    const { data, error: err, response } = await api.POST('/v1/instances', {
      body: { definitionRef: ref!, ...(businessKey.trim() ? { businessKey: businessKey.trim() } : {}) },
      headers: { 'idempotency-key': idemKey },
    });
    if (err || !data) {
      setError(problemMessage(err, `Não foi possível iniciar (HTTP ${response.status}).`));
      return;
    }
    setResult({ id: data.id });
  }

  const items: ProcessItem[] = defs.value.state === 'ready' ? defs.value.data.items : [];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Iniciar processo">
      <div className="modal start-modal">
        <header>
          <h2>Iniciar processo</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>

        {result ? (
          <p className="publish-ok" role="status" aria-live="polite">
            Instância <span className="mono">{shortId(result.id)}</span> criada. Acompanhe em <span className="mono">/operate</span>.
          </p>
        ) : (
          <>
            <p className="modal-note">
              Somente definições <strong>publicadas</strong> no registry. Clique duplo não cria duas instâncias
              (Idempotency-Key no POST).
            </p>
            {defs.value.state === 'loading' && <NonIdeal kind="loading" title="Carregando definições…" />}
            {defs.value.state === 'forbidden' && (
              <NonIdeal kind="forbidden" title="Sem permissão" detail={defs.value.detail} />
            )}
            {defs.value.state === 'error' && (
              <NonIdeal kind="error" title="Falha ao listar" detail={defs.value.message} action={<Button onClick={() => defs.reload()}>Tentar novamente</Button>} />
            )}
            {defs.value.state === 'ready' && items.length === 0 && (
              <NonIdeal kind="empty" title="Nenhuma definição publicada" detail="Publique um processo no Estúdio primeiro." />
            )}
            {defs.value.state === 'ready' && items.length > 0 && (
              <div className="def-list" role="radiogroup" aria-label="Definição">
                {items.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="radio"
                    aria-checked={ref === d.registryRef}
                    className="def-item"
                    data-selected={ref === d.registryRef || undefined}
                    onClick={() => setRef(d.registryRef)}
                  >
                    <span className="def-name">{d.name}</span>
                    <span className="mono def-ref">{d.registryRef}</span>
                  </button>
                ))}
              </div>
            )}
            <label className="field">
              <span>Business key (única por tenant)</span>
              <input
                className="mono"
                value={businessKey}
                onChange={(e) => setBusinessKey(e.target.value)}
                placeholder="opcional — edite se o sistema de origem já tiver uma"
              />
            </label>
            {error && (
              <p className="inline-banner tone-danger" role="alert" aria-live="assertive">
                {error}
              </p>
            )}
          </>
        )}

        <footer className="modal-actions">
          <Button intent="neutral" onClick={onClose}>
            {result ? 'Fechar' : 'Cancelar'}
          </Button>
          {!result && (
            <Button intent="primary" onClick={start} disabled={!ref}>
              Iniciar instância
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
