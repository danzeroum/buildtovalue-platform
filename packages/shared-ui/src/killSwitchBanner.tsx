/**
 * Banner de kill-switch (AG-3.2 · marcação `ag3-2-marcacao-banner-killswitch.md`).
 * Componente PRÓPRIO — não estende `GateSeal` (estado de UMA tarefa) nem
 * `EvidenceSeal` (evidência de um dado): o kill-switch é condição do TENANT
 * INTEIRO, montada no shell, verdadeira em toda rota. Escopo/tempo de
 * vida/colocação diferentes o bastante para não reaproveitar o vocabulário.
 *
 * Regras vinculantes desta marcação:
 *  - tom SEMPRE âmbar (`--ui-role-warning-*`), nunca vermelho — parada honesta,
 *    esperada e retomável, a mesma assinatura do resto do F-AG;
 *  - DUAS linhas SEMPRE juntas (o fato + o alívio "segue funcionando") — a
 *    segunda não é opcional: evita o susto de quem lê só "pausados" e presume
 *    que o sistema caiu;
 *  - `role="alert"` + `aria-live="assertive"` (nunca `status`/`polite` — a
 *    emergência precisa furar a fila de leitura do leitor de tela);
 *  - texto quebra, nunca trunca (ator e hora não podem sumir por corte);
 *  - alvo de clique ≥44px (o banner INTEIRO é o alvo, não um link no fim).
 *
 * Puramente apresentacional (como `selo.tsx`): quem formata data/hora e decide
 * o destino do clique é o consumidor (o console já tem `relativeTime`/
 * `whenVoice` próprios; nenhuma lógica de data mora aqui).
 */
export type KillSwitchActorKind = 'user' | 'system' | 'agent';

export interface KillSwitchActor {
  type: KillSwitchActorKind;
  id: string;
  /** resolvido no servidor (nunca o id cru "admin" — mesmo defeito do rótulo
   *  cru apontado na varredura). `null` = não resolvido (degrade honesto). */
  displayName: string | null;
}

export interface KillSwitchBannerProps {
  /** `null` só é esperado em estado inconsistente (paused sem ator gravado) —
   *  degrade honesto, nunca "desconhecido". */
  by: KillSwitchActor | null;
  /** ISO — vai para o `dateTime` (machine-readable) do `<time>`. */
  sinceIso: string;
  /** voz humana pré-formatada pelo consumidor, ex. "hoje às 21:43". */
  whenRelative: string;
  /** absoluto pré-formatado, vai para o `title` (hover/foco). */
  whenAbsoluteTitle: string;
  /** clique no banner INTEIRO → tela de estado ampliada. */
  onOpenStatus: () => void;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** Voz do ator — glyph + texto para "Agentes de IA pausados — {texto}". Nunca
 *  "desconhecido": tipo conhecido sempre tem voz própria; só a AUSÊNCIA total
 *  do ator (inconsistência de dados) degrada para uma frase honesta. */
function actorVoice(by: KillSwitchActor | null): { initials: string | null; glyph: string | null; text: string } {
  if (!by) return { initials: null, glyph: null, text: 'ator não registrado' };
  if (by.type === 'system') return { initials: null, glyph: '⚙', text: 'pelo sistema' };
  if (by.type === 'agent') return { initials: null, glyph: '◆', text: `pelo agente ${by.displayName ?? by.id}` };
  // user: nome de exibição é a voz preferida; o id cru é o ÚLTIMO recurso
  // honesto (nunca "desconhecido") quando o servidor não resolveu o nome.
  const name = by.displayName ?? by.id;
  return { initials: initialsOf(by.displayName ?? ''), glyph: null, text: `por ${name}` };
}

export function KillSwitchBanner({ by, sinceIso, whenRelative, whenAbsoluteTitle, onOpenStatus }: KillSwitchBannerProps) {
  const voice = actorVoice(by);
  return (
    <div className="ui-killswitch-banner" role="alert" aria-live="assertive">
      <button type="button" className="ui-killswitch-trigger" onClick={onOpenStatus}>
        <span className="ui-killswitch-glyph" aria-hidden="true">
          ⏸
        </span>
        <span className="ui-killswitch-lines">
          <span className="ui-killswitch-line1">
            {voice.initials && (
              <span className="ui-killswitch-initials" aria-hidden="true">
                {voice.initials}
              </span>
            )}
            {voice.glyph && (
              <span className="ui-killswitch-actor-glyph" aria-hidden="true">
                {voice.glyph}
              </span>
            )}
            <strong>Agentes de IA pausados</strong> — {voice.text},{' '}
            <time dateTime={sinceIso} title={whenAbsoluteTitle}>
              {whenRelative}
            </time>
            .
          </span>
          <span className="ui-killswitch-line2">Tarefas e aprovações seguem normalmente.</span>
        </span>
      </button>
    </div>
  );
}
