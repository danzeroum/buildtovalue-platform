/**
 * Serialização canônica compartilhada pelo export (AG-2.3) e pela ancoragem
 * (AG-2.4). Módulo próprio para evitar ciclo de import entre `export.ts` e
 * `anchor.ts`. Chaves ordenadas, compacta, determinística — a base de todo
 * digest (recibo do export e âncora de intervalo).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
