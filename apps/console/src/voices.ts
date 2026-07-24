/**
 * VOZES do agente no Operate (AG-2.2 etapa 5, marcação §1/§2 do designer). O
 * `kind` (contrato do dev) vira rótulo humano + família (âmbar = parada honesta/
 * espera; vermelho = incidente) + ícone. SINAL NUNCA SÓ POR COR: sempre
 * ícone + rótulo (o ícone é decorativo/aria-hidden; o rótulo carrega o sentido).
 */
export type VoiceFamily = 'amber' | 'red';
export interface Voice {
  label: string;
  family: VoiceFamily;
  /** ícone decorativo (aria-hidden) — reforça, nunca substitui o rótulo. */
  icon: string;
}

const VOICES: Record<string, Voice> = {
  // ÂMBAR — paradas honestas / esperas (retomáveis ou com saída; não são falha).
  budget: { label: 'Parada honesta — orçamento esgotado', family: 'amber', icon: '⏸' },
  'kill-switch': { label: 'Parada honesta — kill-switch', family: 'amber', icon: '⏸' },
  'aguardando-gate': { label: 'Aguardando gate humano', family: 'amber', icon: '⏳' },
  agentProposalExpired: { label: 'Proposta expirada — reavaliar', family: 'amber', icon: '↻' },
  // VERMELHO — incidentes (exigem intervenção).
  agentToolStale: { label: 'Efeito não executado — a tool mudou desde a aprovação', family: 'red', icon: '⚠' },
  'no-config': { label: 'Sem inteligência configurada', family: 'red', icon: '⚠' },
  'no-graph': { label: 'Agente não resolvido no registry', family: 'red', icon: '⚠' },
  'walk-error': { label: 'Erro na execução do agente', family: 'red', icon: '⚠' },
  agentPinMissing: { label: 'Pin de agente ausente no despacho', family: 'red', icon: '⚠' },
  agentUnpublished: { label: 'Agente não publicado no registry', family: 'red', icon: '⚠' },
};

/** Desconhecido → incidente vermelho mostrando o `kind` cru (nunca esconde). */
export function voiceOf(kind: string): Voice {
  return VOICES[kind] ?? { label: kind, family: 'red', icon: '•' };
}

/** Linhas de trilha do agente (`agent:*`) e decisões — rótulo humano legível.
 *  O `kind` cru segue sendo o dado auditado; isto é só a renderização. */
const HISTORY_LABELS: Record<string, string> = {
  'agent:pinResolved': 'pin resolvido',
  'agent:intencao': 'intenção declarada',
  'agent:acao': 'ação',
  'agent:io': 'I/O (mascarado)',
  'agent:decisao': 'decisão',
  'agent:evidencia': 'evidência',
  'agent:parada': 'parada honesta',
  'agent:retomado': 'retomado',
  'agent:reproposta': 'reproposta (novo orçamento)',
  taskDecision: 'decisão de tarefa (gate)',
};

export function historyLabel(kind: string): string {
  return HISTORY_LABELS[kind] ?? kind;
}
