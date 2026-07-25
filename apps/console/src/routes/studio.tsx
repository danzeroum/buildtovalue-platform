import { Suspense, lazy, useEffect, useState } from 'react';
import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import { api, problemMessage } from '../api/client.js';
import { Button, NonIdeal } from '../ui/ui.js';

// O DESIGNER é da biblioteca (parecer: "editor vem da biblioteca"); carregado
// preguiçosamente para não pesar o bundle nem exigir canvas nos testes do
// DELTA de publicação (que é o que a plataforma acrescenta — F3.2).
const BpmnEditor = lazy(async () => {
  const mod = await import('@buildtovalue/react');
  return { default: mod.BpmnEditor };
});

export interface LintIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  elementId?: string;
  edgeId?: string;
}

/** Forma comum às duas famílias de lint (processo: elementId/edgeId; agente:
 *  nodeId/remediation, P6/AG-3.6) — já resolvida para UM rótulo de referência. */
interface DisplayLintIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  ref?: string;
  remediation?: string;
}

/**
 * Lista de rejeições/avisos — REJEIÇÃO sempre antes de AVISO, cor+RÓTULO nunca
 * só cor (D19). Compartilhada por `PublishModal` (processo) e `AgentDeployModal`
 * (agente, P6) — "mesma UI de rejeição", ao pé da letra.
 */
function LintIssuesList({ rejections, warnings }: { rejections: DisplayLintIssue[]; warnings: DisplayLintIssue[] }) {
  if (rejections.length === 0 && warnings.length === 0) return null;
  return (
    <ul className="lint-list">
      {rejections.map((i, n) => (
        <li key={`e${n}`} className="lint-item" data-severity="error">
          <span className="lint-badge" data-severity="error">
            REJEIÇÃO
          </span>
          <span className="mono">{i.code}</span>
          {i.ref && <span className="mono lint-ref">{i.ref}</span>}
          <span>{i.message}</span>
          {i.remediation && <span className="lint-remediation"> — {i.remediation}</span>}
        </li>
      ))}
      {warnings.map((i, n) => (
        <li key={`w${n}`} className="lint-item" data-severity="warning">
          <span className="lint-badge" data-severity="warning">
            AVISO
          </span>
          <span className="mono">{i.code}</span>
          {i.ref && <span className="mono lint-ref">{i.ref}</span>}
          <span>{i.message}</span>
          {i.remediation && <span className="lint-remediation"> — {i.remediation}</span>}
        </li>
      ))}
    </ul>
  );
}

function starterDiagram(): BpmnDiagram {
  const d = createDiagram({ name: 'Reembolso de despesas' });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 'Início', x: 0, y: 0 });
  const review = createNode({ id: 'review', type: 'userTask', label: 'Aprovar reembolso', x: 200, y: 0 });
  review.properties.formRef = 'reembolso@1';
  review.properties.candidateRoles = ['business'];
  d.nodes.review = review;
  d.nodes.end = createNode({ id: 'end', type: 'endEvent', label: 'Fim', x: 400, y: 0 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'review' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 'review', targetId: 'end' });
  return d;
}

export function StudioRoute() {
  const [diagram, setDiagram] = useState<BpmnDiagram>(starterDiagram);
  const [publishing, setPublishing] = useState(false);
  // P6 (deploy de agente, AG-3.6): sem editor visual nem ponte ?load= (fora de
  // escopo enquanto P3/squad não decide) — só o mínimo para o cliente publicar
  // sozinho, colando o JSON exportado do editor da lib.
  const [deployingAgent, setDeployingAgent] = useState(false);
  return (
    <section className="route studio" aria-label="Estúdio">
      <div className="doc-bar">
        <h1>{diagram.name}</h1>
        <div className="doc-bar-actions">
          <Button intent="neutral" onClick={() => setDeployingAgent(true)}>
            Publicar grafo de agente (colar JSON)…
          </Button>
          <Button intent="primary" onClick={() => setPublishing(true)}>
            Publicar definição no registry…
          </Button>
        </div>
      </div>
      <div className="studio-canvas" data-dimmed={publishing || deployingAgent || undefined}>
        <Suspense fallback={<NonIdeal kind="loading" title="Carregando o designer…" />}>
          <BpmnEditor diagram={diagram} onChange={setDiagram} />
        </Suspense>
      </div>
      {publishing && <PublishModal diagram={diagram} onClose={() => setPublishing(false)} />}
      {deployingAgent && <AgentDeployModal onClose={() => setDeployingAgent(false)} />}
    </section>
  );
}

/**
 * DELTA de publicação (F3.2, tela 04 "EXEMPLAR"): roda o lint D19 do perfil
 * governado ANTES do deploy; separa REJEIÇÃO (error) de AVISO (warning) por
 * COR + RÓTULO; desabilita o publish com o motivo quando há rejeição; publica
 * só com 0 rejeições. Entra pelo botão "Publicar…" do designer da biblioteca.
 */
export function PublishModal({ diagram, onClose }: { diagram: BpmnDiagram; onClose: () => void }) {
  const [issues, setIssues] = useState<LintIssue[] | null>(null);
  const [linting, setLinting] = useState(true);
  // AG-3.0: falha do lint NÃO vira "[]" (que se passaria por "0 rejeições, pode
  // publicar" — estado desonesto). Sem o lint, não dá para afirmar o escopo v1.
  const [lintError, setLintError] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: 'ok'; ref: string } | { kind: 'error'; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error } = await api.POST('/v1/process-definitions/lint', {
        body: { diagram: diagram as unknown as Record<string, never> },
      });
      if (!alive) return;
      if (error) {
        setLintError(problemMessage(error, 'Falha ao rodar o lint D19'));
        setIssues(null);
      } else {
        setLintError(null);
        setIssues((data?.issues as LintIssue[]) ?? []);
      }
      setLinting(false);
    })();
    return () => {
      alive = false;
    };
  }, [diagram]);

  const rejections = (issues ?? []).filter((i) => i.severity === 'error');
  const warnings = (issues ?? []).filter((i) => i.severity === 'warning');
  // sem lint confirmado (rejeição OU erro do próprio lint) a publicação fica travada.
  const blocked = rejections.length > 0 || lintError !== null;

  async function publish() {
    const { data, error, response } = await api.POST('/v1/process-definitions', {
      body: { name: diagram.name, diagram: diagram as unknown as Record<string, never> },
    });
    if (error || !data) {
      setResult({ kind: 'error', message: problemMessage(error, `Falha ao publicar (HTTP ${response.status})`) });
      return;
    }
    setResult({ kind: 'ok', ref: data.registryRef });
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Publicar no registry">
      <div className="modal publish-modal">
        <header>
          <h2>
            Publicar «{diagram.name}» no registry
          </h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>
        <p className="d19-note">
          O lint do perfil governado roda antes do deploy — elemento fora do escopo v1 é{' '}
          <strong>rejeitado, nunca ignorado (D19)</strong>.
        </p>

        {linting ? (
          <NonIdeal kind="loading" title="Rodando o lint D19…" />
        ) : lintError ? (
          <NonIdeal
            kind="error"
            title="Não foi possível rodar o lint D19"
            detail="Sem o lint não dá para confirmar o escopo v1 — a publicação fica bloqueada até rodar de novo."
            technical={lintError}
          />
        ) : result?.kind === 'ok' ? (
          <p className="publish-ok" role="status" aria-live="polite">
            Publicado como <span className="mono">{result.ref}</span>. Instâncias em voo permanecem na versão anterior
            (migração: F5).
          </p>
        ) : (
          <div className="lint-result" aria-live="polite">
            {result?.kind === 'error' && (
              <p className="publish-error" role="alert">
                {result.message}
              </p>
            )}
            {rejections.length === 0 && warnings.length === 0 ? (
              <p className="lint-clean" data-tone="success">
                <strong>0 rejeições · 0 avisos</strong> — definição dentro do escopo v1; pronta para publicar.
              </p>
            ) : (
              <LintIssuesList
                rejections={rejections.map((i) => ({ ...i, ref: i.elementId ?? i.edgeId }))}
                warnings={warnings.map((i) => ({ ...i, ref: i.elementId ?? i.edgeId }))}
              />
            )}
          </div>
        )}

        <footer className="modal-actions">
          <Button intent="neutral" onClick={onClose}>
            Voltar ao designer
          </Button>
          {result?.kind !== 'ok' && (
            <Button
              intent="primary"
              onClick={publish}
              disabled={linting || blocked}
              title={
                lintError
                  ? 'lint indisponível — rode de novo antes de publicar'
                  : rejections.length > 0
                    ? `${rejections.length} rejeição(ões) bloqueiam a publicação`
                    : undefined
              }
            >
              {rejections.length > 0 ? `Publicar (${rejections.length} rejeições)` : 'Publicar'}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

interface AgentLintIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  remediation?: string;
}

type AgentDeployState =
  | { kind: 'idle' }
  | { kind: 'parseError'; message: string }
  | { kind: 'linting' }
  | { kind: 'linted'; issues: AgentLintIssue[] }
  | { kind: 'lintFailed'; message: string }
  | { kind: 'published'; ref: string }
  | { kind: 'publishError'; message: string };

/**
 * P6 (deploy de agente, AG-3.6, shape `ag3-6-shape-proposta-p6-agent-deploy.md`):
 * sem editor visual nem ponte `?load=` (fora de escopo enquanto P3/squad não
 * decide) — só o MÍNIMO para o cliente publicar sozinho, colando o JSON do
 * grafo exportado do editor da lib. Decisão do dono: capacidade só-por-API é
 * capacidade que só a equipe interna exerce (mesma lição do kill-switch por
 * INSERT/export sem botão) — por isso esta tela, não uma rota nua. Lint ANTES
 * do deploy, rejeição bloqueia, aviso não — MESMA disciplina D19, reusando
 * `LintIssuesList`/`PublishModal`.
 */
export function AgentDeployModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<AgentDeployState>({ kind: 'idle' });

  function parseGraph(): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async function runLint() {
    const graph = parseGraph();
    if (!graph) {
      setState({ kind: 'parseError', message: 'JSON inválido — cole o grafo exportado do editor da lib.' });
      return;
    }
    setState({ kind: 'linting' });
    const { data, error } = await api.POST('/v1/agent-definitions/lint', { body: { graph } });
    if (error || !data) {
      setState({ kind: 'lintFailed', message: problemMessage(error, 'Falha ao rodar o lint') });
      return;
    }
    setState({ kind: 'linted', issues: (data.issues as AgentLintIssue[]) ?? [] });
  }

  async function publish() {
    const graph = parseGraph();
    if (!graph) return; // botão só habilita depois de um lint OK — grafo já validou como objeto
    const { data, error, response } = await api.POST('/v1/agent-definitions', { body: { graph } });
    if (error || !data) {
      setState({ kind: 'publishError', message: problemMessage(error, `Falha ao publicar (HTTP ${response.status})`) });
      return;
    }
    setState({ kind: 'published', ref: data.ref });
  }

  const issues = state.kind === 'linted' ? state.issues : [];
  const rejections = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const canPublish = state.kind === 'linted' && rejections.length === 0;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Publicar grafo de agente">
      <div className="modal publish-modal">
        <header>
          <h2>Publicar grafo de agente</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>
        <p className="d19-note">
          Cole o JSON do grafo exportado do editor de agente (biblioteca). O lint roda antes do
          deploy — grafo fora do escopo v1 é <strong>rejeitado, nunca ignorado</strong> (mesma
          disciplina D19 do Estúdio).
        </p>

        <label className="field">
          <span>Grafo (JSON)</span>
          <textarea
            rows={10}
            className="mono agent-graph-textarea"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setState({ kind: 'idle' });
            }}
            placeholder='{"id":"agnt-exemplo","version":"1.0.0", …}'
          />
        </label>

        {state.kind === 'parseError' && (
          <p className="publish-error" role="alert">
            {state.message}
          </p>
        )}
        {state.kind === 'lintFailed' && <NonIdeal kind="error" title="Não foi possível rodar o lint" technical={state.message} />}
        {state.kind === 'published' && (
          <p className="publish-ok" role="status" aria-live="polite">
            Publicado como <span className="mono">{state.ref}</span>.
          </p>
        )}
        {state.kind === 'publishError' && (
          <p className="publish-error" role="alert">
            {state.message}
          </p>
        )}
        {state.kind === 'linted' &&
          (rejections.length === 0 && warnings.length === 0 ? (
            <p className="lint-clean" data-tone="success">
              <strong>0 rejeições · 0 avisos</strong> — grafo dentro do escopo v1; pronto para publicar.
            </p>
          ) : (
            <LintIssuesList
              rejections={rejections.map((i) => ({ ...i, ref: i.nodeId }))}
              warnings={warnings.map((i) => ({ ...i, ref: i.nodeId }))}
            />
          ))}

        <footer className="modal-actions">
          <Button intent="neutral" onClick={onClose}>
            Fechar
          </Button>
          {state.kind !== 'published' && (
            <>
              <Button intent="neutral" onClick={runLint} disabled={!text.trim() || state.kind === 'linting'}>
                Rodar lint
              </Button>
              <Button
                intent="primary"
                onClick={publish}
                disabled={!canPublish}
                title={!canPublish ? 'rode o lint sem rejeições antes de publicar' : undefined}
              >
                {rejections.length > 0 ? `Publicar (${rejections.length} rejeições)` : 'Publicar'}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
