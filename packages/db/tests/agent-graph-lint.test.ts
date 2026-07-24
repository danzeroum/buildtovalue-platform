import { APPROVAL_GATE_AGENT, type AgentWorkflow } from '@buildtovalue/agentflow';
import { describe, expect, it } from 'vitest';
import { lintAgentGraphExecution } from '../src/registry/agentGraphLint.js';

/**
 * Lint de execução do grafo (AG-2.5): a cadeia `llm→llm` completa em SILÊNCIO no
 * executor v1 (o segundo llm não vê a saída do primeiro), então é recusada no
 * deploy — mesmo princípio de EXEC_LOOP_WAIT_UNSUPPORTED.
 */
describe('EXEC_AGENT_LLM_CHAIN_UNSUPPORTED', () => {
  const llm = (id: string) => ({ id, type: 'llm' as const, config: { model: 'deepseek-chat', promptRef: `prm:${id}@1.0.0` } });

  it('dois llm encadeados → erro no llm de jusante', () => {
    const g: AgentWorkflow = {
      kind: 'AgentWorkflow', id: 'agnt-chain', version: '1.0.0', name: 'chain', autonomyLevel: 1,
      inputSchema: { q: 'string' }, outputSchema: { r: 'string' },
      nodes: [llm('llm-a'), llm('llm-b')],
      edges: [{ from: 'llm-a', to: 'llm-b', edgeType: 'data' }],
    };
    const issues = lintAgentGraphExecution(g);
    const err = issues.find((i) => i.code === 'EXEC_AGENT_LLM_CHAIN_UNSUPPORTED');
    expect(err).toBeDefined();
    expect(err?.severity).toBe('error');
    expect(err?.nodeId).toBe('llm-b'); // recusa no de jusante
    expect(err?.remediation).toBeTruthy();
  });

  it('llm atrás de uma decisão a partir de outro llm também é cadeia (canReach ≥1)', () => {
    const g: AgentWorkflow = {
      kind: 'AgentWorkflow', id: 'agnt-chain2', version: '1.0.0', name: 'c2', autonomyLevel: 1,
      inputSchema: { q: 'string' }, outputSchema: { r: 'string' },
      nodes: [
        llm('llm-a'),
        { id: 'dec', type: 'decision', config: { condition: 'output.ok === true', onTrue: { next: 'llm-b' }, onFalse: { next: 'end' } } },
        llm('llm-b'),
      ],
      edges: [{ from: 'llm-a', to: 'dec', edgeType: 'data' }],
    };
    expect(lintAgentGraphExecution(g).some((i) => i.code === 'EXEC_AGENT_LLM_CHAIN_UNSUPPORTED')).toBe(true);
  });

  it('um só llm + decisão (o grafo do ensaio) PASSA', () => {
    expect(lintAgentGraphExecution(APPROVAL_GATE_AGENT)).toEqual([]);
  });
});
