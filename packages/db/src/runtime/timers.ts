import type { Sql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { advanceInstance } from './advance.js';

export interface TimerSweepResult {
  due: number;
  fired: number;
}

/**
 * Varredura de timers (F2.4, plano §F2 item 4): `fire_at <= agora` pelo
 * índice timers_due_idx → `TimerFired{waitKey}` → avanço. O "agora" é o
 * relógio INJETADO do host (D2): o mesmo instante decide o vencimento e
 * carimba o evento — testes determinísticos, produção usa o relógio real. A marcação
 * 'fired' acontece NA MESMA transação do avanço (hook onApplied) — crash
 * entre avanço e marcação é impossível, então timer 'armed' com wait
 * inexistente só ocorre com um CancelTimer ainda pendente na outbox, e a
 * rejeição staleWait aqui é deixada em paz até o efeito chegar (converge).
 * Corrida entre dois sweepers: o avanço é serializado por FOR UPDATE na
 * instância; o segundo recebe staleWait e não marca nada.
 */
export async function sweepDueTimersOnce(
  sql: Sql,
  tenantId: string,
  options: { now?: () => string; limit?: number } = {},
): Promise<TimerSweepResult> {
  const clock = options.now ?? (() => new Date().toISOString());
  const sweepNow = clock();
  const due = await withTenant(
    sql,
    tenantId,
    (tx) => tx`
      SELECT id, instance_id, wait_key FROM timers
      WHERE status = 'armed' AND fire_at <= ${sweepNow}
      ORDER BY fire_at, id
      LIMIT ${options.limit ?? 50}`,
  );
  let fired = 0;
  for (const timer of due) {
    const outcome = await advanceInstance(
      sql,
      tenantId,
      timer.instance_id as string,
      { type: 'TimerFired', now: sweepNow, waitKey: timer.wait_key as string, variables: {} },
      {
        onApplied: async (tx) => {
          await tx`UPDATE timers SET status = 'fired'
            WHERE id = ${timer.id as string} AND status = 'armed'`;
        },
      },
    );
    if (outcome.ok) fired += 1;
  }
  return { due: due.length, fired };
}
