/**
 * Selo de procedência + primitivas de gate/autonomia (AG-3.0 · fundação).
 * A assinatura de governança (ADENDO-03) promovida a componente: **ator** (D33)
 * + **estado de evidência**. Regras vinculantes herdadas do parecer:
 *  - sinal NUNCA só por cor → sempre ícone (aria-hidden) + RÓTULO textual;
 *  - piso de 11px (`--ui-font-size-meta`) em metadado;
 *  - identificadores em `--ui-font-mono` (regra do mono);
 *  - **evidência nunca é conteúdo** e `evidência-verificada` só do runtime real
 *    (D30): o selo narra SÓ o que o runtime produz. Por isso NÃO há estado
 *    `negado` (E5 não construído) e o ancorado aparece como **`ancorável`**
 *    com a nota de `self-recorded` — nunca "verificado" (a garantia externa
 *    espera WAL imutável).
 *
 * Sem dependência de ecossistema: consome só os tokens (`selo.css`). O consumidor
 * injeta os dados reais (envelope de ator do export, assurance/anchorRef).
 */
import type { ReactNode } from 'react';

/** Ator nomeado (envelope D33). `null` = ato do motor, sem ator (honesto). */
export type ActorKind = 'user' | 'system' | 'agent';
export interface Actor {
  type: ActorKind;
  /** id do ator (renderizado em mono quando presente). */
  id?: string;
}

const ACTOR_LABEL: Record<ActorKind, string> = {
  user: 'Pessoa',
  system: 'Sistema',
  agent: 'Agente',
};
/** glyph decorativo (aria-hidden) — o RÓTULO é o sinal, não o ícone. */
const ACTOR_GLYPH: Record<ActorKind | 'motor', string> = {
  user: '●',
  system: '■',
  agent: '◆',
  motor: '▸',
};

/**
 * Selo de ATOR. `actor === null` → "Motor" (ato determinístico do engine, D6):
 * não se inventa `{system,engine}` — o motor é seu próprio caso, com voz factual
 * (nunca "desconhecido"). `agent` ganha o papel violeta; os demais, tinta neutra.
 */
export function ActorBadge({ actor }: { actor: Actor | null }) {
  const kind = actor?.type ?? 'motor';
  const label = actor ? ACTOR_LABEL[actor.type] : 'Motor';
  const tone = actor?.type === 'agent' ? 'agent' : 'neutral';
  return (
    <span className="ui-selo ui-selo-actor" data-tone={tone}>
      <span className="ui-selo-glyph" aria-hidden="true">
        {ACTOR_GLYPH[kind]}
      </span>
      <span className="ui-selo-label">{label}</span>
      {actor?.id && <span className="ui-selo-id">{actor.id}</span>}
    </span>
  );
}

/**
 * Estados de evidência que o runtime REALMENTE produz (só três):
 *  - `auditado`  — evento gravado na trilha (verde);
 *  - `mascarado` — conteúdo sensível ocultado na persistência (dourado + cadeado);
 *  - `ancoravel` — há `anchorRef`; a garantia é `self-recorded` (info) — a `note`
 *    carrega o `assuranceNote` real. NUNCA "verificado" (garantia externa = WAL imutável).
 */
export type EvidenceState = 'auditado' | 'mascarado' | 'ancoravel';

const EVIDENCE: Record<EvidenceState, { label: string; tone: string; glyph: string }> = {
  auditado: { label: 'auditado', tone: 'success', glyph: '✓' },
  mascarado: { label: 'mascarado', tone: 'gate', glyph: '🔒' },
  ancoravel: { label: 'ancorável', tone: 'info', glyph: '⚓' },
};

export function EvidenceSeal({ state, note }: { state: EvidenceState; note?: string }) {
  const e = EVIDENCE[state];
  return (
    <span className="ui-selo ui-selo-evidence" data-tone={e.tone}>
      <span className="ui-selo-glyph" aria-hidden="true">
        {e.glyph}
      </span>
      <span className="ui-selo-label">{e.label}</span>
      {note && <span className="ui-selo-note">{note}</span>}
    </span>
  );
}

/**
 * Selo de GATE humano. Estado sempre ÂMBAR (dourado `gate`) — parada honesta,
 * NUNCA vermelho (assinatura F-AG). `expirado` diz a saída honesta: aprovar
 * indisponível, reprovar segue.
 */
export type GateState = 'aguardando' | 'expirado';

export function GateSeal({ state }: { state: GateState }) {
  const label = state === 'aguardando' ? 'aguardando gate humano' : 'gate expirado — aprovar indisponível';
  return (
    <span className="ui-selo ui-selo-gate" data-tone="gate" data-state={state}>
      <span className="ui-selo-glyph" aria-hidden="true">
        ⚖
      </span>
      <span className="ui-selo-label">{label}</span>
    </span>
  );
}

/**
 * Dial de AUTONOMIA (apresentacional, 0–5). Nível é sempre lido em TEXTO
 * (`autonomia N/5`) — nunca só pela posição/preenchimento. `requiresGate` (a
 * regra autonomia→gate vive no consumidor, não aqui) pinta de dourado `gate`
 * (exige gate a jusante); senão, violeta `agent`. Nível alto não é alarme vermelho.
 */
export function AutonomyDial({
  level,
  requiresGate = false,
}: {
  level: number;
  requiresGate?: boolean;
}) {
  const clamped = Math.max(0, Math.min(5, Math.round(level)));
  const tone = requiresGate ? 'gate' : 'agent';
  return (
    <span className="ui-selo ui-selo-dial" data-tone={tone} role="img" aria-label={`autonomia ${clamped} de 5`}>
      <span className="ui-selo-pips" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className="ui-selo-pip" data-on={i < clamped || undefined} />
        ))}
      </span>
      <span className="ui-selo-label">autonomia {clamped}/5</span>
      {requiresGate && <span className="ui-selo-note">exige gate</span>}
    </span>
  );
}

/** Contêiner opcional que agrupa ator + evidência num selo único (procedência). */
export function ProcedenceSeal({ actor, children }: { actor: Actor | null; children?: ReactNode }) {
  return (
    <span className="ui-selo-group">
      <ActorBadge actor={actor} />
      {children}
    </span>
  );
}
