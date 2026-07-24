import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import { describe, expect, it } from 'vitest';
import { loopWithWaitViolations, lintDiagram } from '../src/registry/lint.js';

/**
 * LAÇO COM ESPERA — limitação declarada engine/host v1 (achado da etapa 5,
 * generalizado). O engine preserva a identidade do token em movimento simples;
 * o waitKey = ${elementId}:${tokenId} colide na re-entrada → deadlock silencioso.
 * O lint RECUSA no deploy (recusar o que o runtime não honra), para QUALQUER
 * espera (userTask/serviceTask/agentTask/timer), não só agente.
 */
function loopBack(waitType: string): BpmnDiagram {
  const d = createDiagram({ name: 'laço' });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 's', x: 0, y: 0 });
  const wait = createNode({ id: 'espera', type: waitType, label: 'espera', x: 200, y: 0 });
  if (waitType === 'userTask') wait.properties.formRef = 'f@1';
  if (waitType === 'serviceTask') wait.properties.jobType = 'noop';
  if (waitType === 'agentTask') { wait.properties.agentWorkflowRef = 'a'; wait.properties.autonomyLevel = 5; }
  if (waitType === 'intermediateCatchEvent') {
    wait.properties.eventDefinition = 'timer';
    wait.properties.timer = { kind: 'duration', expression: 'P1D' };
  }
  d.nodes.espera = wait;
  d.nodes.gw = createNode({ id: 'gw', type: 'exclusiveGateway', label: 'gw', x: 400, y: 0 });
  d.nodes.fim = createNode({ id: 'fim', type: 'endEvent', label: 'f', x: 600, y: 0 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'espera' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 'espera', targetId: 'gw' });
  d.edges.eLoop = createEdge({ id: 'eLoop', sourceId: 'gw', targetId: 'espera' }); // LAÇO de volta
  d.edges.eLoop.properties.condition = 'x = "de novo"';
  d.edges.eEnd = createEdge({ id: 'eEnd', sourceId: 'gw', targetId: 'fim' });
  d.edges.eEnd.properties.condition = 'x = "fim"';
  return d;
}

/** linear com espera — SEM laço; deve passar. */
function linear(): BpmnDiagram {
  const d = createDiagram({ name: 'linear' });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 's', x: 0, y: 0 });
  const t = createNode({ id: 'tarefa', type: 'userTask', label: 't', x: 200, y: 0 });
  t.properties.formRef = 'f@1';
  d.nodes.tarefa = t;
  d.nodes.fim = createNode({ id: 'fim', type: 'endEvent', label: 'f', x: 400, y: 0 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'tarefa' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 'tarefa', targetId: 'fim' });
  return d;
}

describe('EXEC_LOOP_WAIT_UNSUPPORTED — laço com espera recusado (limitação declarada v1)', () => {
  for (const t of ['userTask', 'serviceTask', 'agentTask', 'intermediateCatchEvent']) {
    it(`recusa laço que re-entra em '${t}' (não só agente)`, () => {
      const issues = loopWithWaitViolations(loopBack(t));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ code: 'EXEC_LOOP_WAIT_UNSUPPORTED', elementId: 'espera', severity: 'error' });
      expect(issues[0].message).toContain('deadlock');
    });
  }

  it('fluxo linear com espera NÃO é recusado (sem laço)', () => {
    expect(loopWithWaitViolations(linear())).toHaveLength(0);
    // e o lint completo também não emite o código para o linear:
    expect(lintDiagram(linear()).some((i) => i.code === 'EXEC_LOOP_WAIT_UNSUPPORTED')).toBe(false);
  });

  it('laço só entre gateways (sem espera no ciclo) NÃO é recusado por esta regra', () => {
    const d = createDiagram({ name: 'gwloop' });
    d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 's', x: 0, y: 0 });
    d.nodes.a = createNode({ id: 'a', type: 'exclusiveGateway', label: 'a', x: 200, y: 0 });
    d.nodes.b = createNode({ id: 'b', type: 'exclusiveGateway', label: 'b', x: 400, y: 0 });
    d.nodes.fim = createNode({ id: 'fim', type: 'endEvent', label: 'f', x: 600, y: 0 });
    d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'a' });
    d.edges.e2 = createEdge({ id: 'e2', sourceId: 'a', targetId: 'b' });
    d.edges.e3 = createEdge({ id: 'e3', sourceId: 'b', targetId: 'a' }); // laço gw↔gw (sem espera)
    d.edges.e4 = createEdge({ id: 'e4', sourceId: 'b', targetId: 'fim' });
    expect(loopWithWaitViolations(d)).toHaveLength(0);
  });
});
