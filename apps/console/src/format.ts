/** Tempo relativo em pt-BR, curto (para metadados de lista — piso 11px). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.round((now - then) / 1000);
  if (secs < 45) return 'agora';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}min atrás`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h atrás`;
  const days = Math.round(hours / 24);
  return `${days}d atrás`;
}

/** Encurta um UUID para caber num chip mono (só apresentação). */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
