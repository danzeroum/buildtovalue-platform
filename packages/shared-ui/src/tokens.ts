/**
 * Tokens de design do Console (D25): a identidade da BIBLIOTECA formalizada
 * para a plataforma — IBM Plex Sans/Mono + Source Serif 4; paleta
 * creme/verde/dourado com VERMELHO ÚNICO para incidente/perigo.
 *
 * Os quatro requisitos do parecer (ADENDO-01 §1, vinculantes):
 *
 * 1. TOKENS POR PAPEL SEMÂNTICO — o código consome INTENÇÃO
 *    (`role.success`, `role.warning`, `role.danger`), nunca hex. Os valores
 *    derivam da paleta da biblioteca (`--bpmnr-*` de packages/react) para as
 *    duas superfícies falarem a mesma língua.
 * 2. REGRA DO MONO — IBM Plex Mono é EXCLUSIVA para identificadores, versões,
 *    telemetria e expressões (S-FEEL). Nunca decoração. `font.mono` só deve
 *    aparecer nesses contextos; revisão de PR de interface checa isso (G-UX-1).
 * 3. PISOS DE ACESSIBILIDADE — nenhum texto abaixo de `fontSize.meta` (11px);
 *    pares de contraste declarados aqui têm teste automático de razão AA
 *    (>= 4.5:1); status NUNCA é só cor: sempre cor + rótulo.
 * 4. DENSIDADE POR ESPAÇAMENTO, NÃO POR PALETA — superfícies do operador usam
 *    `space.dense.*`, superfícies de negócio usam `space.calm.*`; as CORES são
 *    as mesmas. Mudar densidade nunca muda paleta.
 */

export const font = {
  sans: "'IBM Plex Sans', system-ui, sans-serif",
  /** EXCLUSIVA para id/versão/telemetria/expressão (regra do mono, D25.2). */
  mono: "'IBM Plex Mono', ui-monospace, monospace",
  serif: "'Source Serif 4', Georgia, serif",
} as const;

/** Escala de tinta (ink) sobre superfícies creme — do texto pleno ao sutil. */
export const ink = {
  strong: '#262220',
  base: '#44403a',
  muted: '#6f675a',
  subtle: '#a49c8f',
} as const;

export const surface = {
  page: '#faf9f6',
  card: '#ffffff',
  raised: '#f8f7f4',
  sunken: '#f2f0ec',
  border: '#e2ddd3',
  hover: '#f2efe8',
} as const;

/** Papéis semânticos (D25.1) — bg/fg pareados; o teste valida contraste AA. */
export const role = {
  /** Sucesso / ativo / em execução (verde da biblioteca). */
  success: { bg: '#dff0e6', fg: '#175c49', solid: '#1a6a54' },
  /** Atenção / aviso / candidato (dourado). */
  warning: { bg: '#f6edd4', fg: '#6d5115', solid: '#8a6d1e' },
  /** Perigo / incidente — o VERMELHO ÚNICO da identidade. */
  danger: { bg: '#f7e6e0', fg: '#9c2f28', solid: '#b3372f' },
  /** Informação neutra (azul discreto dos selos de teste). */
  info: { bg: '#e3ecf7', fg: '#2d4c70', solid: '#33567e' },
} as const;

/** Pisos de acessibilidade (D25.3). */
export const fontSize = {
  /** PISO ABSOLUTO para metadado/tags — nada renderiza menor que isto. */
  meta: '0.6875rem', // 11px
  body: '0.9375rem',
  label: '0.8125rem',
  title: '1.25rem',
} as const;

/**
 * Densidade por ESPAÇAMENTO (D25.4): mesmos tokens de cor, ritmos diferentes.
 * `dense` = superfícies do operador (Operação); `calm` = negócio (Tarefas).
 */
export const space = {
  dense: { row: '0.375rem', block: '0.75rem', gutter: '1rem' },
  calm: { row: '0.75rem', block: '1.25rem', gutter: '1.5rem' },
} as const;

/** Pares (fg sobre bg) cuja razão de contraste o teste trava em >= AA 4.5:1. */
export const CONTRAST_PAIRS: ReadonlyArray<{ name: string; fg: string; bg: string }> = [
  { name: 'ink.strong/surface.page', fg: ink.strong, bg: surface.page },
  { name: 'ink.base/surface.card', fg: ink.base, bg: surface.card },
  { name: 'ink.muted/surface.card', fg: ink.muted, bg: surface.card },
  { name: 'success', fg: role.success.fg, bg: role.success.bg },
  { name: 'warning', fg: role.warning.fg, bg: role.warning.bg },
  { name: 'danger', fg: role.danger.fg, bg: role.danger.bg },
  { name: 'info', fg: role.info.fg, bg: role.info.bg },
];
