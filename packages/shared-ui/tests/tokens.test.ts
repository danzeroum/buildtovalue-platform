import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTRAST_PAIRS, fontSize, role, space } from '../src/tokens.js';

/** Razão de contraste WCAG 2.x entre duas cores hex. */
function contrastRatio(hexA: string, hexB: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, b] = channels.map((c) =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [l1, l2] = [luminance(hexA), luminance(hexB)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('tokens D25 — pisos de acessibilidade (requisito 3)', () => {
  for (const pair of CONTRAST_PAIRS) {
    it(`contraste AA (>=4.5:1) em ${pair.name}`, () => {
      expect(contrastRatio(pair.fg, pair.bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('piso de metadado é 11px (0.6875rem)', () => {
    expect(fontSize.meta).toBe('0.6875rem');
  });
});

describe('tokens D25 — invariantes estruturais', () => {
  it('vermelho é ÚNICO: danger é o único papel na família do vermelho', () => {
    const isReddish = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return r > g * 1.5 && r > b * 1.5;
    };
    expect(isReddish(role.danger.solid)).toBe(true);
    expect(isReddish(role.success.solid)).toBe(false);
    expect(isReddish(role.warning.solid)).toBe(false);
    expect(isReddish(role.info.solid)).toBe(false);
  });

  it('densidade muda espaçamento, nunca paleta (requisito 4)', () => {
    // As duas densidades expõem as MESMAS chaves; não existe cor por densidade.
    expect(Object.keys(space.dense)).toEqual(Object.keys(space.calm));
    expect(JSON.stringify(space)).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('tokens.css espelha os papéis semânticos do tokens.ts', async () => {
    const css = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tokens.css'),
      'utf8',
    );
    for (const [name, value] of Object.entries({
      '--ui-role-success-solid': role.success.solid,
      '--ui-role-warning-solid': role.warning.solid,
      '--ui-role-danger-solid': role.danger.solid,
      '--ui-role-info-solid': role.info.solid,
      '--ui-font-size-meta': fontSize.meta,
    })) {
      expect(css).toContain(`${name}: ${value}`);
    }
  });
});
