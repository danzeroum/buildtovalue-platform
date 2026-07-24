import { useState } from 'react';
import { ActorBadge, EvidenceSeal, GateSeal } from '@platform/shared-ui';
import { api, problemMessage } from '../api/client.js';
import { Button } from '../ui/ui.js';

/**
 * P1 — GATE de world-delta como MODO do detalhe da Tasklist (AG-3.1, marcação do
 * designer). Hierarquia do card: **consequência acima do contrato**. O `payload`
 * chega MASCARADO do servidor (params sensíveis fora); revelar é rota auditada +
 * RBAC (sem permissão → ESCALAR, não aprovar às cegas). Aprovar de efeito
 * irreversível carrega confirmação de peso. D28: a aprovação reenvia a revisão
 * que o card renderizou (proposta expira se a instância avançou).
 */

interface WorldDelta {
  tool?: string;
  capability?: string;
  effect?: string;
  authorization?: string;
  dataScope?: string;
  evidenceRequired?: string;
  params?: Record<string, unknown>;
  processConsequence?: { source: string; kind: string; description: string } | null;
}

export interface GateTask {
  id: string;
  instanceId: string;
  elementId: string;
  assignee: string | null;
  payload: Record<string, unknown>;
  paramsMasked: boolean;
  paramsFields: string[];
  decisionOptions: string[] | null;
  instanceRevision: number;
}

/** "Aposta alta" (irreversível/compromisso externo) → aprovar exige confirmação
 *  de peso. Fonte ÚNICA da classificação de efeito (lista e detalhe usam a mesma). */
export function isHeavyEffect(effect: string | undefined): boolean {
  return effect === 'write-irreversible' || effect === 'external-commitment';
}

/** Efeito → voz humana de reversibilidade + se é "aposta alta" (exige confirmação). */
function effectVoice(effect: string | undefined): { text: string; heavy: boolean } {
  switch (effect) {
    case 'write-irreversible':
    case 'external-commitment':
      return { text: 'não pode ser desfeito', heavy: true };
    case 'write-reversible':
      return { text: 'pode ser corrigido depois', heavy: false };
    case 'notify':
      return { text: 'notifica alguém', heavy: false };
    case 'propose':
      return { text: 'apenas propõe (sem efeito no mundo)', heavy: false };
    default:
      return { text: 'apenas lê', heavy: false };
  }
}

/** Efeito → chip curto para o ITEM da lista (peso visível ANTES de abrir). Cor da
 *  identidade: irreversível/externo = vermelho; reversível = dourado; resto = neutro. */
export function effectChip(effect: string | undefined | null): { label: string; tone: 'sensitive' | 'gold' | 'neutral' } {
  switch (effect) {
    case 'write-irreversible':
      return { label: 'irreversível', tone: 'sensitive' };
    case 'external-commitment':
      return { label: 'compromisso externo', tone: 'sensitive' };
    case 'write-reversible':
      return { label: 'reversível', tone: 'gold' };
    case 'notify':
      return { label: 'notifica', tone: 'neutral' };
    case 'propose':
      return { label: 'só propõe', tone: 'neutral' };
    default:
      return { label: 'leitura', tone: 'neutral' };
  }
}

const DECISION_LABEL: Record<string, string> = { aprovar: 'Aprovar', reprovar: 'Reprovar' };

export function GateDetail({
  task,
  me,
  canWork,
  canReveal,
  onChanged,
}: {
  task: GateTask;
  me: string;
  canWork: boolean;
  /** RBAC `variables:reveal-sensitive` (espelho de UX). SEM ela, a ação de revelar
   *  NEM APARECE — o aprovador vê o motivo e ESCALA, nunca aprova às cegas (§5 da
   *  marcação: é aceite, não extra). O servidor continua sendo o guarda real (403). */
  canReveal: boolean;
  onChanged: () => void;
}) {
  const wd = task.payload as WorldDelta;
  const effect = effectVoice(wd.effect);
  const [claimToken, setClaimToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, unknown> | null>(null);
  const [revealState, setRevealState] = useState<'idle' | 'forbidden'>('idle');
  const [banner, setBanner] = useState<{ tone: 'danger' | 'success' | 'warn'; text: string } | null>(null);
  const [confirmHeavy, setConfirmHeavy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const options = task.decisionOptions ?? ['aprovar', 'reprovar'];

  async function claim() {
    setBanner(null);
    const { data, error, response } = await api.POST('/v1/user-tasks/{id}/claim', { params: { path: { id: task.id } } });
    if (error || !data) {
      setBanner({ tone: 'danger', text: problemMessage(error, `Não foi possível assumir (HTTP ${response.status}).`) });
      return;
    }
    setClaimToken(data.claimToken);
    onChanged();
  }

  async function reveal() {
    setBanner(null);
    const reason = window.prompt('Motivo para revelar os dados sensíveis (auditado):')?.trim();
    if (!reason) return;
    const { data, error, response } = await api.POST('/v1/user-tasks/{id}/gate/reveal', {
      params: { path: { id: task.id } },
      body: { reason },
    });
    if (error || !data) {
      if (response.status === 403) {
        // aprovador SEM permissão de revelar → NÃO aprova às cegas: escala.
        setRevealState('forbidden');
        return;
      }
      setBanner({ tone: 'danger', text: problemMessage(error, 'Não foi possível revelar.') });
      return;
    }
    setRevealed(data.params as Record<string, unknown>);
  }

  async function decide(decision: string) {
    setBanner(null);
    if (!claimToken) {
      setBanner({ tone: 'danger', text: 'Assuma o gate antes de decidir (o claim gera o token exigido).' });
      return;
    }
    // aprovar de efeito irreversível: confirmação de PESO que nomeia o irreversível.
    if (decision === 'aprovar' && effect.heavy && !confirmHeavy) {
      setConfirmHeavy(true);
      return;
    }
    const { data, error, response } = await api.POST('/v1/user-tasks/{id}/completion', {
      params: { path: { id: task.id } },
      body: {
        claimToken,
        submission: {},
        decision,
        // D28: a revisão que ESTE card renderizou — expira se a instância avançou.
        expectedInstanceRevision: task.instanceRevision,
      },
    });
    setConfirmHeavy(false);
    if (error || !data) {
      if (response.status === 409) {
        // proposta expirada (D28) OU claim inválido — voz âmbar, reavaliar.
        setBanner({ tone: 'warn', text: problemMessage(error, 'A proposta expirou enquanto você decidia — reavaliar.') });
        setClaimToken(null);
        return;
      }
      setBanner({ tone: 'danger', text: problemMessage(error, `Decisão recusada (HTTP ${response.status}).`) });
      return;
    }
    setDone(decision);
    onChanged();
  }

  if (done) {
    return (
      <div className="gate-done" role="status" aria-live="polite">
        <h1>Gate {done === 'aprovar' ? 'aprovado' : 'reprovado'}</h1>
        <p className="gate-selo-line">
          <ActorBadge actor={{ type: 'user', id: me }} />
          <EvidenceSeal state="auditado" />
          {done === 'reprovar'
            ? ' — o efeito NÃO executa; a instância seguiu pela rota de reprovação.'
            : ' — o efeito roda sob selo (procedência: quem aprovou + quando).'}
        </p>
      </div>
    );
  }

  return (
    <div className="gate-card" aria-label="Decisão de agente (gate)">
      <div className="doc-bar">
        <div>
          <h1>{wd.capability ?? task.elementId}</h1>
          <div className="gate-proponent">
            <ActorBadge actor={{ type: 'agent', id: wd.tool ?? 'agente' }} />
            <GateSeal state="aguardando" />
          </div>
        </div>
      </div>

      {/* 1) CONSEQUÊNCIA primeiro: "se você aprovar, isto acontece no mundo" */}
      <section className="gate-delta" aria-label="O que acontece se aprovar">
        <h2>Se você aprovar, isto acontece:</h2>
        <ul>
          <li>
            <strong>A quem/o que toca:</strong> {wd.dataScope ?? '—'}
            {task.paramsMasked && (
              <span className="gate-masked">
                {' '}· <EvidenceSeal state="mascarado" /> {task.paramsFields.length} campo(s) sensível(is)
              </span>
            )}
          </li>
          <li>
            <strong>Reversibilidade:</strong>{' '}
            <span data-heavy={effect.heavy || undefined} className="gate-effect">
              {effect.text}
            </span>
          </li>
          {wd.processConsequence ? (
            <li>
              <strong>No processo:</strong> {wd.processConsequence.description}{' '}
              <span className="gate-origin mono">
                ({wd.processConsequence.source === 'annotated' ? 'anotado' : 'derivado do processo'})
              </span>
            </li>
          ) : (
            // degrade honesto: sem 3ª linha — legenda calma, nunca "desconhecido".
            <li className="gate-only-tool">só as consequências desta ação</li>
          )}
        </ul>
      </section>

      {/* PII: revelar (auditado) ou ESCALAR se sem permissão. §5: quando o aprovador
          NÃO pode revelar (RBAC), a ação nem aparece — motivo à vista + Escalar. O
          403 do servidor cai no MESMO estado (defesa em profundidade). */}
      {task.paramsMasked && (
        <section className="gate-pii" aria-label="Dados sensíveis">
          {revealed ? (
            <pre className="gate-revealed mono">{JSON.stringify(revealed, null, 2)}</pre>
          ) : !canReveal || revealState === 'forbidden' ? (
            <p className="gate-escalate" role="status">
              Você não tem permissão para revelar estes dados — <strong>não aprove às cegas</strong>. Use{' '}
              <strong>Escalar</strong> para quem pode ver.
            </p>
          ) : (
            <Button intent="neutral" onClick={reveal}>
              Revelar dados sensíveis (auditado)…
            </Button>
          )}
        </section>
      )}

      {/* 3) contrato — secundário, mono, abaixo da consequência */}
      <section className="gate-contract mono" aria-label="Contrato da ferramenta">
        <span className="pin-ref">{wd.tool}</span> · {wd.effect} · autorização {wd.authorization} · evidência{' '}
        {wd.evidenceRequired}
      </section>

      {banner && (
        <p className={`gate-banner tone-${banner.tone}`} role={banner.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
          {banner.text}
        </p>
      )}

      {/* Ações — peso por efeito. Claim explícito (nunca auto-assumido, D21). */}
      <div className="gate-actions">
        {!claimToken ? (
          <Button intent="primary" onClick={claim} disabled={!canWork}>
            Assumir este gate
          </Button>
        ) : (
          <>
            {options.includes('reprovar') && (
              <Button intent="danger" onClick={() => decide('reprovar')}>
                {DECISION_LABEL.reprovar}
              </Button>
            )}
            {options.includes('aprovar') && !confirmHeavy && (
              <Button intent="primary" onClick={() => decide('aprovar')}>
                {DECISION_LABEL.aprovar}
              </Button>
            )}
            {confirmHeavy && (
              <span className="gate-heavy-confirm" role="alertdialog" aria-label="Confirmar ação irreversível">
                <strong>Isto {effect.text} e roda agora.</strong>
                <Button intent="danger" onClick={() => decide('aprovar')}>
                  Confirmar e aprovar
                </Button>
                <Button intent="neutral" onClick={() => setConfirmHeavy(false)}>
                  Cancelar
                </Button>
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
