import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import { createEngine, type Engine } from '@buildtovalue/engine';

/**
 * Registro de definições do WALKING SKELETON (F1.8): `skeleton@1` é a única
 * definição embutida — start → serviceTask(noop) → end. A F2 substitui isto
 * pelo deploy real via registry da biblioteca (process_definitions + D19);
 * `instances.definition_ref` já guarda a referência textual para a transição.
 */
export const SKELETON_DEFINITION_REF = 'skeleton@1';

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

const engines = new Map<string, Engine>();

/** Engine (kernel PUBLICADO pinado exato, D5) para uma definition_ref. */
export function engineFor(definitionRef: string): Engine | undefined {
  if (engines.has(definitionRef)) return engines.get(definitionRef);
  if (definitionRef !== SKELETON_DEFINITION_REF) return undefined;
  const engine = createEngine(skeletonDiagram());
  engines.set(definitionRef, engine);
  return engine;
}
