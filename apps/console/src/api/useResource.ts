import { useCallback, useEffect, useState } from 'react';
import { problemMessage } from './client.js';

/**
 * Estado carregável que mapeia 1:1 a matriz de não-ideais do parecer (3.1):
 * `loading` (skeleton, aria-busy) · `forbidden` (403 do RBAC, voz própria) ·
 * `error` (recuperável, com «tentar de novo») · `ready`. O vazio é decisão de
 * cada tela (depende do que «zero itens» significa ali), então fica de fora.
 */
export type Loadable<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T }
  | { state: 'forbidden'; detail: string }
  | { state: 'error'; message: string; status: number };

export interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Roda `fetcher` na montagem e quando `deps` mudam; expõe `reload()` para o
 * botão de recuperação. 403 vira `forbidden` (nunca «erro»); aborta a
 * requisição em voo ao desmontar/retrocarregar (sem set-state fantasma).
 */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<FetchResult<T>>,
  deps: readonly unknown[],
): { value: Loadable<T>; reload: () => void } {
  const [value, setValue] = useState<Loadable<T>>({ state: 'loading' });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setValue({ state: 'loading' });
    void (async () => {
      try {
        const { data, error, response } = await fetcher(ctrl.signal);
        if (!alive) return;
        if (error || data === undefined) {
          if (response.status === 403) {
            setValue({ state: 'forbidden', detail: problemMessage(error, 'Você não tem permissão para ver isto.') });
          } else {
            setValue({
              state: 'error',
              message: problemMessage(error, `Não foi possível carregar (HTTP ${response.status}).`),
              status: response.status,
            });
          }
          return;
        }
        setValue({ state: 'ready', data });
      } catch (e) {
        if (!alive || ctrl.signal.aborted) return;
        setValue({ state: 'error', message: e instanceof Error ? e.message : 'Falha de rede.', status: 0 });
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [...deps, nonce]);

  return { value, reload };
}
