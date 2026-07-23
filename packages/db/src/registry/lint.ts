import {
  agentGateViolations,
  boundaryAttachedTo,
  parseTimerExpression,
  reachableGateFrom,
  timerPropertyOf,
  type BpmnDiagram,
  type BpmnNode,
} from '@buildtovalue/core';
import { requiresDownstreamGate, type AutonomyLevel } from '@buildtovalue/agentflow';
import { conditionEvaluator } from '../runtime/definitions.js';

/** Um nó é um GATE humano (btv:gate) quando declara `properties.btvGate === true`
 * — o marcador de domínio que o core (`reachableGateFrom`) consome por injeção. */
export function isBtvGate(node: BpmnNode): boolean {
  return node.properties.btvGate === true;
}

/**
 * Lint D19 (shape /v1 §2, severidades FIXADAS na pré-triagem de 22/07):
 * `error` bloqueia deploy; `warning` publica com aviso no Studio. O runtime
 * continua defensivo (RaiseIncident tipado) — este lint é a primeira linha.
 */
export interface LintIssue {
  code: LintCode;
  severity: 'error' | 'warning';
  message: string;
  elementId?: string;
  edgeId?: string;
}

export type LintCode =
  | 'EXEC_UNSUPPORTED_ELEMENT'
  | 'EXEC_BOUNDARY_HOST_NOT_WAITING'
  | 'EXEC_TIMER_EXPRESSION_INVALID'
  | 'EXEC_XOR_NO_DEFAULT'
  | 'EXEC_XOR_MULTIPLE_DEFAULTS'
  | 'EXEC_CONDITION_UNSUPPORTED'
  | 'EXEC_FORM_REF_MISSING'
  | 'EXEC_JOB_TYPE_MISSING'
  | 'EXEC_GRAPH_UNREACHABLE'
  | 'EXEC_DECISION_VAR_NO_GATEWAY'
  | 'EXEC_DECISION_VAR_FREE_TEXT'
  | 'EXEC_DECISION_VAR_RESERVED'
  | 'EXEC_DECISION_VAR_SENSITIVE'
  | 'EXEC_AGENT_GATE_MISSING'
  | 'EXEC_TOOL_EFFECT_UNGATED';

/** Subconjunto executável v1 (espelha o engine publicado — D19). */
const SUPPORTED_TYPES = new Set([
  'startEvent',
  'endEvent',
  'task',
  'userTask',
  'serviceTask',
  'agentTask',
  'exclusiveGateway',
  'parallelGateway',
  'intermediateCatchEvent',
  'boundaryEvent',
]);

/** Atividades que ESPERAM (janela real para um boundary disparar). O `agentTask`
 * é espera de job (o engine emite CreateJob(agent) e pausa — etapa 4). */
const WAITING_ACTIVITY_TYPES = new Set(['userTask', 'serviceTask', 'agentTask']);

export function lintDiagram(diagram: BpmnDiagram): LintIssue[] {
  const issues: LintIssue[] = [];
  const nodes = Object.values(diagram.nodes) as BpmnNode[];
  const edges = Object.values(diagram.edges);

  for (const node of nodes) {
    if (!SUPPORTED_TYPES.has(node.type)) {
      issues.push({
        code: 'EXEC_UNSUPPORTED_ELEMENT',
        severity: 'error',
        elementId: node.id,
        message: `elemento '${node.type}' fora do subconjunto executável v1 (D19)`,
      });
      continue;
    }

    const isTimerEvent = node.type === 'intermediateCatchEvent' || node.type === 'boundaryEvent';
    if (isTimerEvent) {
      if (node.properties.eventDefinition !== 'timer') {
        issues.push({
          code: 'EXEC_UNSUPPORTED_ELEMENT',
          severity: 'error',
          elementId: node.id,
          message: `${node.type} '${node.id}' sem eventDefinition=timer — só timer no subset v1 (message/signal ficam fora)`,
        });
      } else {
        const timer = timerPropertyOf(node);
        if (!timer) {
          issues.push({
            code: 'EXEC_TIMER_EXPRESSION_INVALID',
            severity: 'error',
            elementId: node.id,
            message: `timer de '${node.id}' ausente ou mal-formado`,
          });
        } else {
          const parsed = parseTimerExpression(timer.kind, timer.expression);
          if (!parsed.valid) {
            issues.push({
              code: 'EXEC_TIMER_EXPRESSION_INVALID',
              severity: 'error',
              elementId: node.id,
              message: `expressão de timer inválida em '${node.id}': ${parsed.error}`,
            });
          } else if (parsed.kind === 'cycle') {
            issues.push({
              code: 'EXEC_TIMER_EXPRESSION_INVALID',
              severity: 'error',
              elementId: node.id,
              message: `timer cíclico em '${node.id}' fora da v1 (D19)`,
            });
          } else if (parsed.kind === 'duration' && (parsed.parts.years || parsed.parts.months)) {
            issues.push({
              code: 'EXEC_TIMER_EXPRESSION_INVALID',
              severity: 'error',
              elementId: node.id,
              message: `duração com anos/meses em '${node.id}' é calendário-dependente — fora da v1`,
            });
          }
        }
      }
    }

    if (node.type === 'boundaryEvent') {
      const hostId = boundaryAttachedTo(node);
      const host = hostId ? diagram.nodes[hostId] : undefined;
      if (!host) {
        issues.push({
          code: 'EXEC_BOUNDARY_HOST_NOT_WAITING',
          severity: 'error',
          elementId: node.id,
          message: `boundary '${node.id}' sem atividade hospedeira (attachedToRef inválido)`,
        });
      } else if (!WAITING_ACTIVITY_TYPES.has(host.type)) {
        // issue #2: boundary só sobre atividade DE ESPERA — em atividade
        // instantânea (task/gateway/evento) o timer jamais teria janela.
        issues.push({
          code: 'EXEC_BOUNDARY_HOST_NOT_WAITING',
          severity: 'error',
          elementId: node.id,
          message: `boundary '${node.id}' sobre '${host.type}' (${host.id}) — hospedeiro precisa ser atividade de espera (userTask/serviceTask)`,
        });
      }
    }

    // Gate D31 (etapa 5): um btv:gate é user task de DECISÃO (world-delta), não
    // tarefa de formulário — não exige formRef pinado. As demais userTasks sim.
    if (node.type === 'userTask' && !node.properties.formRef && !isBtvGate(node)) {
      issues.push({
        code: 'EXEC_FORM_REF_MISSING',
        severity: 'error',
        elementId: node.id,
        message: `userTask '${node.id}' sem formRef — a Tasklist não teria formulário pinado`,
      });
    }
    if (node.type === 'serviceTask' && !node.properties.jobType) {
      issues.push({
        code: 'EXEC_JOB_TYPE_MISSING',
        severity: 'error',
        elementId: node.id,
        message: `serviceTask '${node.id}' sem properties.jobType`,
      });
    }

    if (node.type === 'exclusiveGateway') {
      const outgoing = edges.filter((e) => e.sourceId === node.id);
      if (outgoing.length > 1) {
        const conditionless = outgoing.filter(
          (e) => !(e.properties.conditionExpression ?? e.properties.condition),
        );
        if (conditionless.length === 0) {
          // adendo do arquiteto (22/07): XOR todo-condicional é VÁLIDO; rota
          // morta em execução é incidente de RUNTIME, não veto de deploy.
          issues.push({
            code: 'EXEC_XOR_NO_DEFAULT',
            severity: 'warning',
            elementId: node.id,
            message: `XOR '${node.id}' sem saída default — se nenhuma condição valer, a instância vira incidente em runtime`,
          });
        } else if (conditionless.length > 1) {
          issues.push({
            code: 'EXEC_XOR_MULTIPLE_DEFAULTS',
            severity: 'error',
            elementId: node.id,
            message: `XOR '${node.id}' com ${conditionless.length} saídas sem condição — default ambíguo (roteamento não-determinístico)`,
          });
        }
        for (const edge of outgoing) {
          const expression = (edge.properties.conditionExpression ?? edge.properties.condition) as
            | string
            | undefined;
          if (expression) {
            const result = conditionEvaluator.evaluate(expression, {});
            if ('error' in result) {
              issues.push({
                code: 'EXEC_CONDITION_UNSUPPORTED',
                severity: 'error',
                edgeId: edge.id,
                message: `condição de '${edge.id}' fora do suportado: ${result.error}`,
              });
            }
          }
        }
      }
    }
  }

  issues.push(...reachability(diagram));
  issues.push(...decisionVarGatewayWarnings(diagram));
  issues.push(...lintAgentGates(diagram));
  return issues;
}

/**
 * Gate D31 — regra de autonomia→gate (pura). Todo `agentTask` cujo `autonomyLevel`
 * EXIGE gate (`requiresDownstreamGate`, ≤3) precisa de um `btv:gate` ALCANÇÁVEL a
 * jusante. Delega ao `agentGateViolations` do core (SL-12) com o predicado de
 * domínio `isBtvGate`. Erro de deploy: efeito de agente sem cobertura de gate.
 */
export function lintAgentGates(diagram: BpmnDiagram): LintIssue[] {
  const violations = agentGateViolations(diagram, {
    // `agentAutonomyLevelOf` devolve `number`; `requiresDownstreamGate` tipa
    // `AutonomyLevel` (0–5) — o cast é seguro (a lib trata fora de faixa como não-gate).
    requiresGate: (level: number) => requiresDownstreamGate(level as AutonomyLevel),
    isGate: isBtvGate,
    locale: 'pt',
  });
  return violations.map((v) => ({
    code: 'EXEC_AGENT_GATE_MISSING' as const,
    severity: 'error' as const,
    elementId: v.nodeId,
    message: `agentTask '${v.nodeId}' (autonomia ${v.autonomyLevel}) exige um btv:gate a jusante — ${v.remediation}`,
  }));
}

/**
 * Gate D31 — efeito de tool sem cobertura. Recebe os elementos cujo `toolRef`
 * resolveu (no deploy, contra `tool_definitions`) para um efeito que EXIGE gate,
 * e exige um `btv:gate` alcançável a jusante de cada um. A resolução do efeito é
 * do deploy (tx-scoped); esta função é a parte PURA (alcançabilidade no grafo).
 */
export function toolEffectGateViolations(diagram: BpmnDiagram, gatedElementIds: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const elementId of gatedElementIds) {
    if (!reachableGateFrom(diagram, elementId, isBtvGate)) {
      issues.push({
        code: 'EXEC_TOOL_EFFECT_UNGATED',
        severity: 'error',
        elementId,
        message: `'${elementId}' usa uma tool com efeito irreversível/external — exige um btv:gate a jusante (D31)`,
      });
    }
  }
  return issues;
}

const DECISION_EQ_LHS = /^\s*([A-Za-z_]\w*)\s*=/;
const DECISION_EQ_STRING = /^\s*([A-Za-z_]\w*)\s*=\s*"([^"]*)"\s*$/;

export interface DecisionRouting {
  /** decisionVar declarada no elemento (null = não declara). */
  decisionVar: string | null;
  /** algum exclusiveGateway a jusante compara a decisionVar. */
  readByGateway: boolean;
  /**
   * Valores EXATOS que roteiam (RHS das igualdades `decisionVar = "literal"`
   * dos gateways a jusante), ordenados/dedup. `null` = não derivável (nenhum
   * literal string enumerável) → cai para texto livre (com aviso no lint).
   */
  options: string[] | null;
}

/**
 * Deriva o roteamento da decisão de um userTask (etapa 6, adição): o MESMO
 * caminhamento a jusante do lint extrai, além de "algum gateway lê a var", os
 * VALORES comparados por igualdade — as opções exatas. É a fonte única de
 * `decisionOptions` (detalhe da task, escolha do console, e a recusa 422 de
 * valor fora da lista). Gateway é só-igualdade por D19, então o RHS string é o
 * conjunto de rotas possíveis; valor fora dele NUNCA casaria (aprovação inócua).
 */
export function deriveDecisionRouting(diagram: BpmnDiagram, elementId: string): DecisionRouting {
  const node = diagram.nodes[elementId] as BpmnNode | undefined;
  const dv = node?.properties.decisionVar;
  const decisionVar = typeof dv === 'string' && dv.length > 0 ? dv : null;
  if (!decisionVar) return { decisionVar: null, readByGateway: false, options: null };

  const edges = Object.values(diagram.edges);
  const forward = new Map<string, string[]>();
  for (const edge of edges) {
    forward.set(edge.sourceId, [...(forward.get(edge.sourceId) ?? []), edge.targetId]);
  }
  const reached = new Set<string>();
  const queue = [...(forward.get(elementId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push(...(forward.get(id) ?? []));
  }

  let readByGateway = false;
  const options = new Set<string>();
  for (const id of reached) {
    const gw = diagram.nodes[id] as BpmnNode | undefined;
    if (gw?.type !== 'exclusiveGateway') continue;
    for (const edge of edges.filter((e) => e.sourceId === id)) {
      const expr = (edge.properties.conditionExpression ?? edge.properties.condition) as
        | string
        | undefined;
      if (!expr || DECISION_EQ_LHS.exec(expr)?.[1] !== decisionVar) continue;
      readByGateway = true;
      const lit = DECISION_EQ_STRING.exec(expr)?.[2];
      if (lit !== undefined) options.add(lit);
    }
  }
  return {
    decisionVar,
    readByGateway,
    options: readByGateway && options.size > 0 ? [...options].sort() : null,
  };
}

/**
 * D19 (etapa 6): userTask com `decisionVar` — warning se nenhum gateway a
 * jusante a lê (decisão não roteia nada), OU se lê mas os valores não são
 * enumeráveis (degrada para texto livre; nunca falha fechado num caso legítimo).
 */
function decisionVarGatewayWarnings(diagram: BpmnDiagram): LintIssue[] {
  const issues: LintIssue[] = [];
  const declaring = (Object.values(diagram.nodes) as BpmnNode[]).filter(
    (n) =>
      n.type === 'userTask' &&
      typeof n.properties.decisionVar === 'string' &&
      (n.properties.decisionVar as string).length > 0,
  );
  for (const task of declaring) {
    const routing = deriveDecisionRouting(diagram, task.id);
    if (!routing.readByGateway) {
      issues.push({
        code: 'EXEC_DECISION_VAR_NO_GATEWAY',
        severity: 'warning',
        elementId: task.id,
        message: `userTask '${task.id}' declara decisionVar '${routing.decisionVar}' mas nenhum gateway a jusante lê essa variável — a decisão não roteia nada`,
      });
    } else if (routing.options === null) {
      issues.push({
        code: 'EXEC_DECISION_VAR_FREE_TEXT',
        severity: 'warning',
        elementId: task.id,
        message: `userTask '${task.id}': o gateway a jusante lê '${routing.decisionVar}' mas sem valores string enumeráveis — a decisão cai para TEXTO LIVRE (o console não oferece escolha exata)`,
      });
    }
  }
  return issues;
}

/** Alcançabilidade (warning, adendo 22/07): rascunho é publicável com aviso. */
function reachability(diagram: BpmnDiagram): LintIssue[] {
  const issues: LintIssue[] = [];
  const nodes = Object.values(diagram.nodes) as BpmnNode[];
  const edges = Object.values(diagram.edges);
  const starts = nodes.filter((n) => n.type === 'startEvent').map((n) => n.id);
  const forward = new Map<string, string[]>();
  for (const edge of edges) {
    forward.set(edge.sourceId, [...(forward.get(edge.sourceId) ?? []), edge.targetId]);
  }
  // boundaries são alcançados pelo hospedeiro
  for (const node of nodes) {
    if (node.type === 'boundaryEvent') {
      const host = boundaryAttachedTo(node);
      if (host) forward.set(host, [...(forward.get(host) ?? []), node.id]);
    }
  }
  const reached = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push(...(forward.get(id) ?? []));
  }
  for (const node of nodes) {
    if (!reached.has(node.id)) {
      issues.push({
        code: 'EXEC_GRAPH_UNREACHABLE',
        severity: 'warning',
        elementId: node.id,
        message: `'${node.id}' inalcançável a partir de um startEvent`,
      });
    }
  }
  return issues;
}

/** Só erros bloqueiam o deploy (shape §2). */
export function lintBlocks(issues: LintIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}
