import {
  canReach,
  nodeIndex,
  type AgentWorkflow,
  type ValidationIssue,
} from '@buildtovalue/agentflow';

/**
 * Lint de EXECUÇÃO do grafo de agente (host, AG-2.5) — complementa o
 * `validateGraph` da lib com o que o RUNTIME REAL v1 não honra, no mesmo espírito
 * de `EXEC_LOOP_WAIT_UNSUPPORTED`: recusar no deploy o que produziria resultado
 * silenciosamente errado em produção.
 *
 * **`EXEC_AGENT_LLM_CHAIN_UNSUPPORTED`** — dois nós `llm` encadeados. O executor
 * v1 (`realWalker`) resolve o prompt de cada `llm` a partir do seu `promptRef`
 * (Library), SEM costurar a saída de um `llm` a montante no *prompt* do de
 * jusante (D38). Verificado: um grafo `llm-a → llm-b` **completa em silêncio** —
 * `b` roda sem ver a saída de `a`, sem bloqueio. Isso é resultado silenciosamente
 * errado; então recusa-se no deploy (erro), até o motor passo-a-passo com estado
 * costurado da AG-4. Grafos de um `llm` + decisão/tool (o caso do ensaio) passam.
 */
export function lintAgentGraphExecution(graph: AgentWorkflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const index = nodeIndex(graph);
  const llmNodes = graph.nodes.filter((n) => n.type === 'llm');

  for (const downstream of llmNodes) {
    // `downstream` recebe fluxo de OUTRO llm sse algum llm distinto o alcança
    // pelo fluxo de controle interno (canReach exige caminho ≥1).
    const upstream = llmNodes.find(
      (u) => u.id !== downstream.id && canReach(graph, u.id, downstream.id, index),
    );
    if (upstream) {
      issues.push({
        code: 'EXEC_AGENT_LLM_CHAIN_UNSUPPORTED',
        severity: 'error',
        nodeId: downstream.id,
        message: `llm '${downstream.id}' recebe fluxo do llm '${upstream.id}' — o executor v1 não costura a saída de um llm no prompt de outro (resultado silenciosamente errado)`,
        remediation:
          'colapse os dois nós llm em um só, ou intercale um passo não-llm que materialize a saída; a cadeia llm→llm chega no motor passo-a-passo da AG-4',
      });
    }
  }
  return issues;
}
