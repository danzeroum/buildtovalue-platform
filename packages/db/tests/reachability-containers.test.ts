import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BpmnXmlConverter, createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import { describe, expect, it } from 'vitest';
import { lintDiagram } from '../src/registry/lint.js';

/**
 * EXEC_GRAPH_UNREACHABLE só vale para NÓ DE FLUXO.
 *
 * Contêiner (pool/lane), artefato (textAnnotation/group) e dado
 * (dataObject/dataStore) não são alvo de sequence flow — apareciam como
 * "inalcançável" num diagrama conexo, gerando aviso que não diz nada ao lado
 * das rejeições legítimas. Ruído assim treina quem lê a ignorar a lista.
 *
 * O que NÃO pode acontecer: silenciar o código. Diagrama de fato desconexo tem
 * que continuar reprovando — é o segundo bloco de testes.
 */
// Aponta para a cópia ÚNICA da fixture (a do console). Duplicá-la aqui
// colocaria um segundo exemplar de um modelo de processo real do cliente no
// repositório, e as duas cópias divergiriam com o tempo.
const PR01 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'console', 'tests', 'fixtures', 'pr01.bpmn'),
  'utf8',
);

const unreachable = (d: BpmnDiagram) =>
  lintDiagram(d).filter((i) => i.code === 'EXEC_GRAPH_UNREACHABLE');

/** start → t1 → fim, com um pool e uma lane em volta (contêineres). */
function comContainers(): BpmnDiagram {
  const d = createDiagram({ name: 'Com contêineres' });
  d.nodes.pool = createNode({ id: 'pool', type: 'pool', label: 'Organização', x: 0, y: 0 });
  d.nodes.lane = createNode({ id: 'lane', type: 'lane', label: 'Time', x: 0, y: 0 });
  d.nodes.nota = createNode({ id: 'nota', type: 'textAnnotation', label: 'observação', x: 0, y: 300 });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 'Início', x: 40, y: 40 });
  const t = createNode({ id: 't1', type: 'userTask', label: 'Etapa 1', x: 200, y: 40 });
  t.properties.formRef = 'f@1';
  t.properties.candidateRoles = ['business'];
  d.nodes.t1 = t;
  d.nodes.fim = createNode({ id: 'fim', type: 'endEvent', label: 'Fim', x: 400, y: 40 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 't1' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 't1', targetId: 'fim' });
  return d;
}

describe('EXEC_GRAPH_UNREACHABLE — contêineres e artefatos não entram', () => {
  it('pool, lane e anotação NÃO são apontados num diagrama conexo', () => {
    expect(unreachable(comContainers())).toEqual([]);
  });

  it('pr01.bpmn (pool + 4 lanes + anotação) não gera nenhum aviso de alcançabilidade', () => {
    const { diagram } = new BpmnXmlConverter().fromXml(PR01);
    expect(unreachable(diagram)).toEqual([]);
    // O modelo segue REPROVANDO — por elemento fora do subset, condição, timer
    // e formRef. O que sumiu foi só o ruído, não o veredicto.
    const rejeicoes = lintDiagram(diagram).filter((i) => i.severity === 'error');
    expect(rejeicoes.length).toBeGreaterThan(0);
    expect(rejeicoes.some((i) => i.code === 'EXEC_UNSUPPORTED_ELEMENT')).toBe(true);
  });
});

describe('EXEC_GRAPH_UNREACHABLE — desconexão real continua reprovando', () => {
  it('userTask órfã DENTRO de uma lane é apontada, e o apontado é o nó, não o contêiner', () => {
    const d = comContainers();
    const orfa = createNode({ id: 'orfa', type: 'userTask', label: 'Ilha', x: 200, y: 200 });
    orfa.properties.formRef = 'f@1';
    orfa.properties.candidateRoles = ['business'];
    d.nodes.orfa = orfa;
    // pertence à lane, mas nenhuma aresta chega nela
    d.nodes.lane.properties.flowNodeRefs = ['start', 't1', 'fim', 'orfa'];

    const avisos = unreachable(d);
    expect(avisos).toHaveLength(1);
    expect(avisos[0].elementId).toBe('orfa');
    expect(['pool', 'lane', 'nota']).not.toContain(avisos[0].elementId);
  });

  it('ilha inteira (tarefa + fim) desconectada é apontada nó a nó', () => {
    const d = comContainers();
    const orfa = createNode({ id: 'orfa', type: 'userTask', label: 'Ilha', x: 200, y: 200 });
    orfa.properties.formRef = 'f@1';
    orfa.properties.candidateRoles = ['business'];
    d.nodes.orfa = orfa;
    d.nodes.fim2 = createNode({ id: 'fim2', type: 'endEvent', label: 'Fim da ilha', x: 400, y: 200 });
    d.edges.e3 = createEdge({ id: 'e3', sourceId: 'orfa', targetId: 'fim2' });

    expect(unreachable(d).map((i) => i.elementId).sort()).toEqual(['fim2', 'orfa']);
  });

  it('diagrama SEM startEvent: todo nó de fluxo é inalcançável, contêiner nenhum', () => {
    const d = comContainers();
    delete d.nodes.start;
    delete d.edges.e1;
    expect(unreachable(d).map((i) => i.elementId).sort()).toEqual(['fim', 't1']);
  });
});
