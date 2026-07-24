import { useEffect, useRef, useState } from 'react';
import { KillSwitchBanner, type KillSwitchActor } from '@platform/shared-ui';
import { api, problemMessage } from './api/client.js';
import { useResource } from './api/useResource.js';
import type { KillSwitchState } from './api/types.js';
import { can } from './capabilities.js';
import { whenVoice } from './format.js';
import { useSession } from './session.js';
import { Button, NonIdeal } from './ui/ui.js';

/**
 * AG-3.2 — banner de kill-switch na Operação inteira (marcação
 * `ag3-2-marcacao-banner-killswitch.md`). Vive no shell (montado ANTES do
 * header no DOM — G-UX-3 §6), não numa rota; por isso este arquivo fica na
 * raiz de `src/`, não em `routes/`.
 */

const POLL_MS = 20_000;

/**
 * Polling silencioso do FATO (nível 1, `ai:read-state` — todo papel). Falha de
 * leitura (rede/sessão) devolve `null` — a MESMA renderização de `active`:
 * nunca inventa emergência, nunca um "não verificado" ambiente que viraria
 * ruído a cada oscilação de rede (marcação §5).
 */
function useKillSwitchFact(pollMs: number = POLL_MS): KillSwitchState | null {
  const [state, setState] = useState<KillSwitchState | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      const { data, error } = await api.GET('/v1/ai/kill-switch', {});
      if (!alive) return;
      setState(!error && data ? data : null);
      timer = setTimeout(tick, pollMs);
    }
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs]);
  return state;
}

/** `active` (ou falha) → nada renderiza: ausência é o sinal (marcação §2). */
export function KillSwitchBannerContainer() {
  const fact = useKillSwitchFact();
  const [open, setOpen] = useState(false);
  if (!fact || fact.state !== 'paused' || !fact.since) return null;
  const w = whenVoice(fact.since);
  return (
    <>
      <KillSwitchBanner
        by={fact.by as KillSwitchActor | null}
        sinceIso={fact.since}
        whenRelative={w.relative}
        whenAbsoluteTitle={w.absolute}
        onOpenStatus={() => setOpen(true)}
      />
      {open && <AiStatusModal onClose={() => setOpen(false)} />}
    </>
  );
}

/** Destino do clique (marcação §4): TODOS veem o fato ampliado; a razão só
 *  para `ai:read-config`; "Reativar…" só para `ai:operate` — a ação SOME para
 *  quem não pode (mesmo padrão do reveal no P1), nunca um beco 403. */
function AiStatusModal({ onClose }: { onClose: () => void }) {
  const user = useSession()!;
  const canOperate = can(user.role, 'ai:operate');
  const canReadConfig = can(user.role, 'ai:read-config');
  const fact = useResource((signal) => api.GET('/v1/ai/kill-switch', { signal }), []);
  const [reason, setReason] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: 'danger'; text: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // razão (nível 2) é enriquecimento — se falhar, o fato acima já é o essencial.
  useEffect(() => {
    if (!canReadConfig) return;
    let alive = true;
    void api.GET('/v1/ai/config', {}).then(({ data }) => {
      if (alive && data) setReason(data.killSwitch.reason);
    });
    return () => {
      alive = false;
    };
  }, [canReadConfig]);

  async function reactivate() {
    setBanner(null);
    const motivo = window.prompt('Motivo para reativar os agentes (auditado):')?.trim();
    if (!motivo) return;
    const { data, error, response } = await api.POST('/v1/ai/kill-switch', {
      body: { paused: false, reason: motivo },
    });
    if (error || !data) {
      setBanner({ tone: 'danger', text: problemMessage(error, `Não foi possível reativar (HTTP ${response.status}).`) });
      return;
    }
    onClose(); // some sozinho; a próxima varredura do banner confirma o active.
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Estado dos agentes de IA">
      <div className="modal ai-status-modal" ref={dialogRef} tabIndex={-1}>
        <header>
          <h2>Estado dos agentes de IA</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>

        {fact.value.state === 'loading' && <NonIdeal kind="loading" title="Confirmando o estado dos agentes…" />}
        {fact.value.state === 'forbidden' && <NonIdeal kind="forbidden" title="Sem acesso" detail={fact.value.detail} />}
        {fact.value.state === 'error' && (
          // marcação §5: aqui o estado É O ASSUNTO — falha aparece, nunca silêncio.
          <NonIdeal
            kind="error"
            title="Não foi possível confirmar o estado dos agentes"
            detail={fact.value.message}
            action={<Button onClick={() => fact.reload()}>Tentar novamente</Button>}
          />
        )}
        {fact.value.state === 'ready' && fact.value.data.state === 'active' && (
          <p role="status">Os agentes não estão pausados.</p>
        )}
        {fact.value.state === 'ready' && fact.value.data.state === 'paused' && (
          <div className="ai-status-body">
            <p>
              Pausado{' '}
              {fact.value.data.by
                ? `por ${fact.value.data.by.displayName ?? fact.value.data.by.id}`
                : '(ator não registrado)'}
              {fact.value.data.since && `, ${whenVoice(fact.value.data.since).relative}`}.
            </p>
            {canReadConfig && reason && <p className="ai-status-reason">Motivo: {reason}</p>}
            {banner && (
              <p className="gate-banner tone-danger" role="alert">
                {banner.text}
              </p>
            )}
            {canOperate ? (
              <Button intent="primary" onClick={reactivate}>
                Reativar agentes…
              </Button>
            ) : (
              // marcação §4: nunca um beco 403 — o caminho humano, não o detalhe técnico.
              <p className="ai-status-nogo">Só um administrador pode reativar — fale com um administrador.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
