/**
 * Polling dinâmico do dispatcher (F2.2, plano §F2 item 2): com itens 100ms;
 * vazio, backoff exponencial a partir de 1s até o FALLBACK de 60s — o
 * LISTEN em conexão dedicada acorda o loop na hora em que há trabalho, então
 * o polling é só rede de segurança (notify perdido, conexão caída).
 */
export const BUSY_DELAY_MS = 100;
export const IDLE_BASE_MS = 1_000;
export const FALLBACK_MS = 60_000;

/** Próximo atraso do loop — função PURA (testável). */
export function nextDelayMs(previousMs: number, hadWork: boolean): number {
  if (hadWork) return BUSY_DELAY_MS;
  if (previousMs < IDLE_BASE_MS) return IDLE_BASE_MS;
  return Math.min(previousMs * 2, FALLBACK_MS);
}

export interface Waker {
  /** Dorme até `ms` OU até wake() — o que vier primeiro. */
  sleep(ms: number): Promise<void>;
  /** Acorda o sleep em curso (chamado pelo LISTEN). */
  wake(): void;
}

export function createWaker(): Waker {
  let pending: (() => void) | null = null;
  return {
    sleep(ms) {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          pending = null;
          resolve();
        }, ms);
        pending = () => {
          clearTimeout(timer);
          pending = null;
          resolve();
        };
      });
    },
    wake() {
      pending?.();
    },
  };
}
