import {
  boundaryAttachedTo,
  parseTimerExpression,
  timerPropertyOf,
  type BpmnDiagram,
  type BpmnNode,
} from '@buildtovalue/core';
import { conditionEvaluator } from '../runtime/definitions.js';

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
  | 'EXEC_DECISION_VAR_RESERVED'
  | 'EXEC_DECISION_VAR_SENSITIVE';

/** Subconjunto executável v1 (espelha o engine publicado — D19). */
const SUPPORTED_TYPES = new Set([
  'startEvent',
  'endEvent',
  'task',
  'userTask',
  'serviceTask',
  'exclusiveGateway',
  'parallelGateway',
  'intermediateCatchEvent',
  'boundaryEvent',
]);

/** Atividades que ESPERAM (janela real para um boundary disparar). */
const WAITING_ACTIVITY_TYPES = new Set(['userTask', 'serviceTask']);

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

    if (node.type === 'userTask' && !node.properties.formRef) {
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
  return issues;
}

/**
 * D19 novo (etapa 6, opção B): userTask declara `decisionVar` mas NENHUM
 * exclusiveGateway A JUSANTE lê essa variável — a decisão coletada não roteia
 * nada (warning: publica, mas o Studio avisa). "A jusante" = alcançável por
 * arestas de saída; a variável de um gateway é o lado esquerdo da condição de
 * igualdade de suas saídas (a semântica real do avaliador — igualdade §2.6).
 */
function decisionVarGatewayWarnings(diagram: BpmnDiagram): LintIssue[] {
  const issues: LintIssue[] = [];
  const nodes = Object.values(diagram.nodes) as BpmnNode[];
  const edges = Object.values(diagram.edges);
  const declaring = nodes.filter(
    (n) =>
      n.type === 'userTask' &&
      typeof n.properties.decisionVar === 'string' &&
      (n.properties.decisionVar as string).length > 0,
  );
  if (declaring.length === 0) return issues;

  const forward = new Map<string, string[]>();
  for (const edge of edges) {
    forward.set(edge.sourceId, [...(forward.get(edge.sourceId) ?? []), edge.targetId]);
  }
  // variáveis lidas por cada exclusiveGateway (LHS da condição de igualdade)
  const gatewayVars = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (node.type !== 'exclusiveGateway') continue;
    const vars = new Set<string>();
    for (const edge of edges.filter((e) => e.sourceId === node.id)) {
      const expr = (edge.properties.conditionExpression ?? edge.properties.condition) as
        | string
        | undefined;
      const lhs = expr ? /^\s*([A-Za-z_]\w*)\s*=/.exec(expr)?.[1] : undefined;
      if (lhs) vars.add(lhs);
    }
    gatewayVars.set(node.id, vars);
  }

  for (const task of declaring) {
    const decisionVar = task.properties.decisionVar as string;
    const reached = new Set<string>();
    const queue = [...(forward.get(task.id) ?? [])];
    let read = false;
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reached.has(id)) continue;
      reached.add(id);
      if (gatewayVars.get(id)?.has(decisionVar)) {
        read = true;
        break;
      }
      queue.push(...(forward.get(id) ?? []));
    }
    if (!read) {
      issues.push({
        code: 'EXEC_DECISION_VAR_NO_GATEWAY',
        severity: 'warning',
        elementId: task.id,
        message: `userTask '${task.id}' declara decisionVar '${decisionVar}' mas nenhum gateway a jusante lê essa variável — a decisão não roteia nada`,
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
