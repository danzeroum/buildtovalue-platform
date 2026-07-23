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
 * Persiste a trilha MASCARADA na coluna `agent_io` de `history_events`. Cada fato
 * vira uma linha `agentIo`: `payload` carrega SÓ metadados não-pessoais (kind,
 * source, message, nodeId), e o I/O — mascarado pela política conservadora — vai
 * na coluna `agent_io`. Nada em claro em nenhuma das colunas. Append-only (D32):
 * a coluna é escrita só no INSERT; effect_key determinístico por (instância,
 * elemento, step) → idempotente.
 */
export async function persistAgentTrail(
  tx: TransactionSql,
  args: {
    tenantId: string;
    instanceId: string;
    elementId: string;
    agentRef: string;
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
      kind: fact.kind,
      source: fact.source,
      message: fact.message,
      ...(fact.nodeId ? { nodeId: fact.nodeId } : {}),
      ...(fact.error ? { error: true } : {}),
    };
    await tx`INSERT INTO history_events
        (tenant_id, instance_id, seq, kind, payload, agent_io, engine_version, effect_key)
      VALUES (${args.tenantId}, ${args.instanceId},
              ${historySeq(args.revision, 50_000 + fact.step)}, 'agentIo',
              ${tx.json(payload as never)},
              ${maskedIo ? tx.json(maskedIo as never) : null},
              ${args.engineVersion},
              ${`host:agent-io:${args.instanceId}:${args.elementId}:${fact.step}`})
      ON CONFLICT (effect_key) DO NOTHING`;
  }
}

/**
 * Constrói a trilha de fatos a partir do resultado do walk do AgentRunner. Um
 * fato `io` com o I/O da corrida (mascarado na persistência) + um `parada` quando
 * o walk não completou (kill-switch/budget/erro) — a trilha PARCIAL vira fato,
 * nunca conclusão silenciosa.
 */
export function buildAgentFacts(input: {
  io: AgentIo;
  visitedNodes: string[];
  complete: boolean;
  stopReason?: string;
}): AgentFact[] {
  const facts: AgentFact[] = [
    {
      step: 0,
      kind: 'io',
      source: 'fixture',
      message: `agente caminhou ${input.visitedNodes.length} nó(s): ${input.visitedNodes.join(' → ') || '—'}`,
      io: input.io,
    },
  ];
  if (!input.complete) {
    facts.push({
      step: 1,
      kind: 'parada',
      source: 'fixture',
      message: input.stopReason ?? 'parada honesta',
      error: true,
    });
  }
  return facts;
}
