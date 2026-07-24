import type { BpmnDiagram } from '@buildtovalue/core';
import type { ToolAuthorization, ToolEffect } from '@buildtovalue/agentflow';
import type { DataClassification } from '../runtime/definitions.js';

/**
 * WORLD-DELTA do gate (AG-2.2 etapa 5, schema CONGELADO no P1 anotado). O payload
 * da tarefa de gate = o `ToolContract` resolvido UMA vez + os `params` propostos
 * pelo agente + a CONSEQUÊNCIA DO PROCESSO. As duas primeiras dimensões vêm do
 * contrato; a terceira é derivada do BPMN a jusante (timer→prazo, userTask→"vai
 * para X") ou anotada pelo modelador — sem ela, o aprovador teria uma 2ª pergunta.
 *
 * Regra de honestidade (P1): NUNCA inferir consequência que possa estar errada —
 * sem regra estrutural nem anotação, degrada para `null` ("só as consequências da
 * tool"). Mostrar menos > prometer errado ao aprovador.
 */
export interface WorldDelta {
  tool: string; // ref id@version
  capability: string;
  effect: ToolEffect;
  authorization: ToolAuthorization;
  dataScope: string;
  evidenceRequired: string;
  /** params propostos pelo agente (validados por matchToolParams no deploy). */
  params: Record<string, unknown>;
  /** consequência do processo — `null` = degrade honesto (só a tool). */
  processConsequence: ProcessConsequence | null;
  /**
   * AG-3.1 (PII do world-delta): classificação HERDADA da variável `proposalVar`
   * de onde os `params` vieram (a mesma disciplina de `variables`). `sensitive` →
   * os params entram MASCARADOS no card do aprovador; revelar é ato auditado + RBAC.
   * Ausente/`none` = params sem PII sensível, saem em claro. NUNCA se expõe params
   * sensíveis em claro "para depois mascarar na tela" — o mascaramento é do dado.
   */
  paramsClassification?: DataClassification;
}

/**
 * VISÃO do world-delta para o aprovador (AG-3.1). Se `paramsClassification` é
 * `sensitive`, os VALORES dos params saem — só os NOMES dos campos + a contagem
 * ficam (formato não-sensível: "N campos", nunca o conteúdo). `paramsMasked` diz
 * à UI que há detalhe atrás da revelação auditada. As demais dimensões (tool,
 * effect, dataScope, consequência) não são PII e seguem em claro.
 */
export interface WorldDeltaView {
  delta: Omit<WorldDelta, 'params'> & { params: Record<string, unknown> };
  paramsMasked: boolean;
  /** nomes dos campos de params (seguros — estrutura, não conteúdo). */
  paramsFields: string[];
}

export function maskWorldDelta(wd: WorldDelta): WorldDeltaView {
  const fields = Object.keys(wd.params ?? {});
  const sensitive = wd.paramsClassification === 'sensitive';
  return {
    delta: { ...wd, params: sensitive ? {} : wd.params },
    paramsMasked: sensitive,
    paramsFields: fields,
  };
}

export interface ProcessConsequence {
  /** `annotated` = frase do modelador; `derived` = estrutural do BPMN. */
  source: 'annotated' | 'derived';
  kind: 'timer' | 'userTask' | 'endEvent' | 'annotation';
  /** frase humana para o aprovador. */
  description: string;
}

const TERMINAL = new Set(['timer', 'userTask', 'endEvent']);

/**
 * Deriva a consequência do processo a jusante do gate. Prioridade:
 *  1. anotação do modelador (`properties.consequenceNote`) — a frase humana;
 *  2. estrutural: o primeiro nó a jusante que seja `timer` (prazo), `userTask`
 *     (aguarda alguém) ou `endEvent` (encerra) — descrição sem inferência frouxa;
 *  3. `null` — degrade honesto.
 * BFS forward pelas sequence flows a partir do gate (mesmo grafo do core).
 */
export function deriveProcessConsequence(diagram: BpmnDiagram, gateNodeId: string): ProcessConsequence | null {
  const gate = diagram.nodes[gateNodeId];
  if (!gate) return null;
  const note = typeof gate.properties.consequenceNote === 'string' ? gate.properties.consequenceNote : undefined;
  if (note && note.trim().length > 0) {
    return { source: 'annotated', kind: 'annotation', description: note.trim() };
  }
  // BFS estrutural pelas arestas de sequência.
  const edges = Object.values(diagram.edges);
  const outgoing = (id: string): string[] =>
    edges.filter((e) => e.sourceId === id).map((e) => e.targetId);
  const seen = new Set<string>([gateNodeId]);
  let frontier = outgoing(gateNodeId);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = diagram.nodes[id];
      if (!node) continue;
      const timerish = node.type === 'intermediateCatchEvent' || node.type === 'boundaryEvent'
        ? 'timer'
        : TERMINAL.has(node.type)
          ? node.type
          : undefined;
      if (timerish === 'timer' && node.properties.timer) {
        return { source: 'derived', kind: 'timer', description: descTimer(node.properties.timer) };
      }
      if (node.type === 'userTask') {
        return { source: 'derived', kind: 'userTask', description: `o processo aguarda a tarefa "${node.label ?? node.id}"` };
      }
      if (node.type === 'endEvent') {
        return { source: 'derived', kind: 'endEvent', description: 'o processo encerra' };
      }
      next.push(...outgoing(id));
    }
    frontier = next;
  }
  return null;
}

function descTimer(timer: unknown): string {
  const expr = (timer as { expression?: string })?.expression;
  return expr ? `abre um prazo (${expr})` : 'abre um prazo';
}

/** Monta o world-delta a partir do contrato resolvido + params + consequência. */
export function buildWorldDelta(input: {
  toolRef: string;
  capability: string;
  effect: ToolEffect;
  authorization: ToolAuthorization;
  dataScope: string;
  evidenceRequired: string;
  params: Record<string, unknown>;
  processConsequence: ProcessConsequence | null;
  /** classificação herdada da variável `proposalVar` (AG-3.1). */
  paramsClassification?: DataClassification;
}): WorldDelta {
  return {
    tool: input.toolRef,
    capability: input.capability,
    effect: input.effect,
    authorization: input.authorization,
    dataScope: input.dataScope,
    evidenceRequired: input.evidenceRequired,
    params: input.params,
    processConsequence: input.processConsequence,
    ...(input.paramsClassification ? { paramsClassification: input.paramsClassification } : {}),
  };
}
