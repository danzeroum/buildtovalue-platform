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
  return (
    <section className="route studio" aria-label="Estúdio">
      <div className="doc-bar">
        <h1>{diagram.name}</h1>
        <Button intent="primary" onClick={() => setPublishing(true)}>
          Publicar definição no registry…
        </Button>
      </div>
      <div className="studio-canvas" data-dimmed={publishing || undefined}>
        <Suspense fallback={<NonIdeal kind="loading" title="Carregando o designer…" />}>
          <BpmnEditor diagram={diagram} onChange={setDiagram} />
        </Suspense>
      </div>
      {publishing && <PublishModal diagram={diagram} onClose={() => setPublishing(false)} />}
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
              <ul className="lint-list">
                {rejections.map((i, n) => (
                  <li key={`e${n}`} className="lint-item" data-severity="error">
                    <span className="lint-badge" data-severity="error">
                      REJEIÇÃO
                    </span>
                    <span className="mono">{i.code}</span>
                    {i.elementId && <span className="mono lint-ref">{i.elementId}</span>}
                    <span>{i.message}</span>
                  </li>
                ))}
                {warnings.map((i, n) => (
                  <li key={`w${n}`} className="lint-item" data-severity="warning">
                    <span className="lint-badge" data-severity="warning">
                      AVISO
                    </span>
                    <span className="mono">{i.code}</span>
                    {i.elementId && <span className="mono lint-ref">{i.elementId}</span>}
                    <span>{i.message}</span>
                  </li>
                ))}
              </ul>
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
