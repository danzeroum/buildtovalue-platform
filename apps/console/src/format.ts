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

/**
 * Voz de data/hora do banner de kill-switch (AG-3.2 marcação §2): "hoje às
 * HH:MM" / "ontem às HH:MM" / data completa — sempre no fuso do NAVEGADOR
 * (Intl usa o fuso local; a preferência explícita de fuso é A5, ainda não
 * construída — este é o melhor default disponível até lá). `absolute` vai
 * para o `title` (hover/foco); nunca some por corte.
 */
export function whenVoice(iso: string, now: number = Date.now()): { relative: string; absolute: string } {
  const then = new Date(iso);
  const time = then.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const nowDate = new Date(now);
  const yesterday = new Date(nowDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const relative =
    then.toDateString() === nowDate.toDateString()
      ? `hoje às ${time}`
      : then.toDateString() === yesterday.toDateString()
        ? `ontem às ${time}`
        : `em ${then.toLocaleDateString('pt-BR')} às ${time}`;
  const absolute = then.toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
  return { relative, absolute };
}
