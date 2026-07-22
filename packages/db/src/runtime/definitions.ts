import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import { createEngine, type ConditionEvaluator, type Engine } from '@buildtovalue/engine';

/**
 * Registro de definições EMBUTIDAS do runtime. A F3 substitui isto pelo
 * deploy real via registry da biblioteca (process_definitions + lint D19);
 * `instances.definition_ref` já guarda a referência textual para a transição.
 */
export const SKELETON_DEFINITION_REF = 'skeleton@1';

/** Processo exemplo do aceite da F2 (plano §F2): user task + service task +
 * timer boundary interruptivo + XOR. */
export const EXAMPLE_DEFINITION_REF = 'example@1';

function skeletonDiagram(): BpmnDiagram {
  const diagram = createDiagram({ name: 'Walking Skeleton' });
  diagram.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 'Início', x: 0, y: 0 });
  diagram.nodes.work = createNode({ id: 'work', type: 'serviceTask', label: 'Trabalho', x: 200, y: 0 });
  diagram.nodes.work.properties.jobType = 'noop';
  diagram.nodes.end = createNode({ id: 'end', type: 'endEvent', label: 'Fim', x: 400, y: 0 });
  diagram.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'work' });
  diagram.edges.e2 = createEdge({ id: 'e2', sourceId: 'work', targetId: 'end' });
  return diagram;
}

/**
 * example@1:
 *   start → review (userTask, form review@1, timer boundary INTERRUPTIVO 1h)
 *         → decision (XOR): approved = true → notify (http-call) → endApproved
 *                            default        → endRejected
 *   timeout → escalate (send-email) → endEscalated
 */
function exampleDiagram(): BpmnDiagram {
  const d = createDiagram({ name: 'Exemplo F2' });
  const node = (id: string, type: string, x: number) => {
    d.nodes[id] = createNode({ id, type, label: id, x, y: 0 });
    return d.nodes[id];
  };
  const edge = (id: string, sourceId: string, targetId: string) => {
    d.edges[id] = createEdge({ id, sourceId, targetId });
    return d.edges[id];
  };
  node('start', 'startEvent', 0);
  const review = node('review', 'userTask', 200);
  review.properties.formRef = 'review@1';
  review.properties.candidateRoles = ['operator'];
  const timeout = node('reviewTimeout', 'boundaryEvent', 260);
  timeout.properties.attachedToRef = 'review';
  timeout.properties.eventDefinition = 'timer';
  timeout.properties.timer = { kind: 'duration', expression: 'PT1H' };
  node('decision', 'exclusiveGateway', 400);
  const notify = node('notify', 'serviceTask', 600);
  notify.properties.jobType = 'http-call';
  const escalate = node('escalate', 'serviceTask', 600);
  escalate.properties.jobType = 'send-email';
  node('endApproved', 'endEvent', 800);
  node('endRejected', 'endEvent', 800);
  node('endEscalated', 'endEvent', 800);
  edge('e1', 'start', 'review');
  edge('e2', 'review', 'decision');
  edge('e3', 'decision', 'notify').properties.condition = 'approved = true';
  edge('e4', 'decision', 'endRejected'); // sem condição = default implícito
  edge('e5', 'notify', 'endApproved');
  edge('e6', 'reviewTimeout', 'escalate');
  edge('e7', 'escalate', 'endEscalated');
  return d;
}

/**
 * Avaliador de condição v1 do HOST (injetado — o kernel não avalia nada,
 * D2): suporta exatamente `variavel = literal` (true/false/número/"texto").
 * É a costura onde o S-FEEL da biblioteca entra na F3 junto do deploy de
 * definições; expressão fora do suportado retorna { error } e o engine
 * trata como incidente (fail-fast D19, nunca rota silenciosa).
 */
const CONDITION_RE = /^\s*([A-Za-z_]\w*)\s*=\s*(true|false|-?\d+(?:\.\d+)?|"[^"]*")\s*$/;
export const conditionEvaluator: ConditionEvaluator = {
  evaluate(expression, variables) {
    const match = CONDITION_RE.exec(expression);
    if (!match) return { error: `condição não suportada na v1: ${expression}` };
    const [, name, raw] = match;
    const literal: unknown =
      raw === 'true' ? true : raw === 'false' ? false : raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    return { value: variables[name] === literal };
  },
};

const engines = new Map<string, Engine>();

/** Engine (kernel PUBLICADO pinado exato, D5) para uma definition_ref. */
export function engineFor(definitionRef: string): Engine | undefined {
  if (engines.has(definitionRef)) return engines.get(definitionRef);
  let engine: Engine;
  if (definitionRef === SKELETON_DEFINITION_REF) {
    engine = createEngine(skeletonDiagram());
  } else if (definitionRef === EXAMPLE_DEFINITION_REF) {
    engine = createEngine(exampleDiagram(), { conditions: conditionEvaluator });
  } else {
    return undefined;
  }
  engines.set(definitionRef, engine);
  return engine;
}
