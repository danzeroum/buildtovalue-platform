import { createHash } from 'node:crypto';

/**
 * effect_key determinística do HOST (D11):
 * hash(instance_id, revision, effect_index, effect_type). Base do
 * exatamente-uma-vez lógico — a UNIQUE da outbox deduplica reexecuções.
 */
export function effectKey(
  instanceId: string,
  revision: number,
  effectIndex: number,
  effectType: string,
): string {
  return createHash('sha256')
    .update(`${instanceId}|${revision}|${effectIndex}|${effectType}`)
    .digest('hex');
}
