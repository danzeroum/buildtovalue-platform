import { MASKED_VALUE, type FactKind, type FactSource, type MaskingPolicy } from '@buildtovalue/agentflow';
import type { TransactionSql } from '../client.js';
import { historySeq } from './../runtime/outbox.js';

/**
 * Trilha de fatos do agente single-agent (AG-2.2 etapa 3 §2), MASCARADA antes de
 * qualquer persistência. O I/O do agente vai para a coluna `history_events.agent_io`
 * (0006) — NUNCA para `payload`, NUNCA em claro. A política é CONSERVADORA por
 * padrão: só passa o campo EXPLICITAMENTE classificado `none`; personal, sensitive
 * ou DESCONHECIDO viram máscara (`MASKED_VALUE`). O host nunca vaza o que não
 * declarou como não-pessoal — a mesma acidez do teste de "ledger sem conteúdo
 * pessoal" da F2, agora sobre a superfície de agente.
 */
export type Classification = 'none' | 'personal' | 'sensitive';
export type Classifications = Record<string, Classification>;

/**
 * Política CONSERVADORA (D30/D20): `mask` devolve o valor SÓ quando o campo é
 * declarado `none`; qualquer outra classificação — inclusive a AUSÊNCIA de
 * classificação — redige. É o default seguro: um campo que o host não classificou
 * é tratado como potencialmente pessoal, jamais vazado.
 */
export function conservativeMaskingPolicy(classifications: Classifications): MaskingPolicy {
  return {
    mask(fieldName, value) {
      return classifications[fieldName] === 'none' ? value : MASKED_VALUE;
    },
  };
}

/** Mascara cada campo de topo de um registro (input/output do agente). */
function maskRecord(rec: Record<string, unknown>, policy: MaskingPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) out[key] = policy.mask(key, value);
  return out;
}

export interface AgentIo {
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

/** Mascara o I/O (input+output) de um fato do agente. */
export function maskIo(io: AgentIo, policy: MaskingPolicy): AgentIo {
  return {
    ...(io.input ? { input: maskRecord(io.input, policy) } : {}),
    ...(io.output ? { output: maskRecord(io.output, policy) } : {}),
  };
}

/**
 * Um fato da trilha single-agent. Espelha o `SquadFact` da lib (mesmos `kind`/
 * `source`) mas para UMA corrida. `source` só é `evidencia-verificada` do `run`
 * real (D30) — o `simulate` do CI é sempre `fixture`.
 */
export interface AgentFact {
  step: number;
  kind: FactKind;
  source: FactSource;
  message: string;
  nodeId?: string;
  io?: AgentIo;
  error?: boolean;
}

/**
 * Envelope de ator (D33), campo de 1ª classe do fato de agente — GRAVADO DESDE JÁ
 * (a trilha é append-only; sem ele, a P2/P7 da AG-3 exigiria migração retroativa
 * de trilha imutável, impossível). `type` = quem agiu (o agente na corrida; o
 * `system` na resolução do pin); `id` = ref/identidade; `requestId` = correlação
 * da corrida. Consultável por `payload->'actor'->>'type'` (jsonb, sem coluna nova).
 */
export interface AgentActor {
  type: 'agent' | 'user' | 'system';
  id: string;
  requestId?: string;
}

/** Prefixo estável das linhas da trilha de agente na history_events: um SELECT
 * `kind LIKE 'agent:%'` traz a timeline unificada (pin + cadeia de fatos) sem
 * caminhar o payload. Cada fato é UMA linha com seu `kind` próprio. */
export const AGENT_HISTORY_PREFIX = 'agent:';

/**
 * Persiste a trilha MASCARADA na coluna `agent_io` de `history_events`. Cada fato
 * vira UMA linha cujo `kind` = `agent:<intencao|acao|io|decisao|evidencia|parada>`
 * (um fato por linha, filtrável por kind sem abrir o payload). O `payload` carrega
 * SÓ metadados não-pessoais + o **envelope de ator {type,id,requestId}**; o I/O —
 * mascarado pela política conservadora — vai na coluna `agent_io`. Nada em claro em
 * nenhuma das colunas. Append-only (D32): effect_key determinístico por (instância,
 * elemento, step) → idempotente.
 */
export async function persistAgentTrail(
  tx: TransactionSql,
  args: {
    tenantId: string;
    instanceId: string;
    elementId: string;
    agentRef: string;
    /** envelope de ator dos fatos (D33) — o agente que corre esta trilha. */
    actor: AgentActor;
    facts: AgentFact[];
    classifications: Classifications;
    engineVersion: string;
    /** base de `seq` (revisão da instância na conclusão do job). */
    revision: number;
  },
): Promise<void> {
  const policy = conservativeMaskingPolicy(args.classifications);
  for (const fact of args.facts) {
    const maskedIo = fact.io ? maskIo(fact.io, policy) : null;
    const payload = {
      elementId: args.elementId,
      agentRef: args.agentRef,
      actor: args.actor,
      kind: fact.kind,
      source: fact.source,
      message: fact.message,
      ...(fact.nodeId ? { nodeId: fact.nodeId } : {}),
      ...(fact.error ? { error: true } : {}),
    };
    await tx`INSERT INTO history_events
        (tenant_id, instance_id, seq, kind, payload, agent_io, engine_version, effect_key)
      VALUES (${args.tenantId}, ${args.instanceId},
              ${historySeq(args.revision, 50_000 + fact.step)},
              ${AGENT_HISTORY_PREFIX + fact.kind},
              ${tx.json(payload as never)},
              ${maskedIo ? tx.json(maskedIo as never) : null},
              ${args.engineVersion},
              ${`host:agent-io:${args.instanceId}:${args.elementId}:${fact.step}`})
      ON CONFLICT (effect_key) DO NOTHING`;
  }
}

/**
 * Constrói a CADEIA de fatos (D1) a partir do walk do AgentRunner, um fato por
 * elo — `intenção → ação(por nó) → I/O → evidência` (+ `parada` honesta quando o
 * walk não completa). `decisao` entra quando o walker surfaçar o nó de decisão
 * (hoje o `simulate` do CI não expõe o tipo do nó; a coluna já suporta o kind).
 * Cada elo vira UMA linha na persistência — granularidade de fato por linha.
 */
export function buildAgentFacts(input: {
  io: AgentIo;
  visitedNodes: string[];
  complete: boolean;
  stopReason?: string;
  /** nós de decisão que dispararam (do walk) — elo `decisao` da cadeia D1. */
  decisions?: string[];
}): AgentFact[] {
  const facts: AgentFact[] = [];
  let step = 0;
  // intenção: o agente foi invocado (o "ask" — input, sem output ainda).
  facts.push({
    step: step++,
    kind: 'intencao',
    source: 'fixture',
    message: 'agente invocado',
    ...(input.io.input ? { io: { input: input.io.input } } : {}),
  });
  // ação: um fato por nó caminhado (a trilha do que rodou, na ordem).
  for (const nodeId of input.visitedNodes) {
    facts.push({ step: step++, kind: 'acao', source: 'fixture', message: `executou nó '${nodeId}'`, nodeId });
  }
  // I/O da corrida (input+output, mascarados na persistência).
  facts.push({ step: step++, kind: 'io', source: 'fixture', message: 'I/O da corrida', io: input.io });
  // decisão: um fato por nó de decisão que roteou (fecha a cadeia D1 intenção→
  // ação→io→DECISÃO→evidência). Derivado do trail — o valor roteado fica na
  // variável de decisão (D13), a trilha registra QUE decidiu, não o dado.
  for (const nodeId of input.decisions ?? []) {
    facts.push({ step: step++, kind: 'decisao', source: 'fixture', message: `decisão em '${nodeId}'`, nodeId });
  }
  // evidência: o resultado como evidência (só do output; nunca conteúdo pessoal).
  if (input.complete && input.io.output) {
    facts.push({
      step: step++,
      kind: 'evidencia',
      source: 'fixture',
      message: 'resultado do agente',
      io: { output: input.io.output },
    });
  }
  if (!input.complete) {
    facts.push({
      step: step++,
      kind: 'parada',
      source: 'fixture',
      message: input.stopReason ?? 'parada honesta',
      error: true,
    });
  }
  return facts;
}
