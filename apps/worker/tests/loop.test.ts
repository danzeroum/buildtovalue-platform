import { describe, expect, it } from 'vitest';
import { BUSY_DELAY_MS, createWaker, FALLBACK_MS, IDLE_BASE_MS, nextDelayMs } from '../src/loop.js';

describe('polling dinâmico (F2.2)', () => {
  it('com itens: 100ms; vazio: 1s dobrando até o fallback de 60s', () => {
    expect(nextDelayMs(IDLE_BASE_MS, true)).toBe(BUSY_DELAY_MS);
    expect(nextDelayMs(BUSY_DELAY_MS, false)).toBe(IDLE_BASE_MS);
    expect(nextDelayMs(IDLE_BASE_MS, false)).toBe(2_000);
    expect(nextDelayMs(40_000, false)).toBe(FALLBACK_MS);
    expect(nextDelayMs(FALLBACK_MS, false)).toBe(FALLBACK_MS);
    expect(nextDelayMs(FALLBACK_MS, true)).toBe(BUSY_DELAY_MS);
  });

  it('waker: o notify do LISTEN encurta o sono em curso', async () => {
    const waker = createWaker();
    const started = Date.now();
    const sleeping = waker.sleep(5_000);
    setTimeout(() => waker.wake(), 20);
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
