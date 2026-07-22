/**
 * Export XES 2.0 (IEEE 1849-2016) da HISTÓRIA de uma instância (shape §3,
 * Operate F3.5): um trace por instância, um event por history_event. O
 * `toXES` da biblioteca (@buildtovalue/audit) serve o ledger de GOVERNANÇA
 * (traces por versão de design); a história de runtime é do host — mesmo
 * formato, gerador próprio, mineração nas mesmas ferramentas (ProM/Disco).
 */
export interface XesHistoryEvent {
  seq: number;
  kind: string;
  payload: unknown;
  occurred_at: string;
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function instanceHistoryToXES(
  instance: { id: string; businessKey: string | null; definitionRef: string },
  events: XesHistoryEvent[],
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<log xes.version="2.0" xes.features="nested-attributes">',
    '  <extension name="Concept" prefix="concept" uri="http://www.xes-standard.org/concept.xesext"/>',
    '  <extension name="Time" prefix="time" uri="http://www.xes-standard.org/time.xesext"/>',
    '  <extension name="Lifecycle" prefix="lifecycle" uri="http://www.xes-standard.org/lifecycle.xesext"/>',
    `  <string key="concept:name" value="${esc(`buildtovalue ${instance.definitionRef}`)}"/>`,
    '  <trace>',
    `    <string key="concept:name" value="${esc(instance.businessKey ?? instance.id)}"/>`,
  ];
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const elementId = typeof payload.elementId === 'string' ? payload.elementId : undefined;
    const edgeId = typeof payload.edgeId === 'string' ? payload.edgeId : undefined;
    lines.push('    <event>');
    lines.push(`      <string key="concept:name" value="${esc(event.kind)}"/>`);
    lines.push(`      <date key="time:timestamp" value="${esc(new Date(event.occurred_at).toISOString())}"/>`);
    lines.push('      <string key="lifecycle:transition" value="complete"/>');
    lines.push(`      <int key="btv:seq" value="${event.seq}"/>`);
    if (elementId) lines.push(`      <string key="btv:elementId" value="${esc(elementId)}"/>`);
    if (edgeId) lines.push(`      <string key="btv:edgeId" value="${esc(edgeId)}"/>`);
    lines.push('    </event>');
  }
  lines.push('  </trace>', '</log>', '');
  return lines.join('\n');
}
