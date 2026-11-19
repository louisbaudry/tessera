/**
 * The theme's text colours against the backgrounds they are drawn on (issue #193, the
 * accessibility audit, `planning/accessibility-audit.md` finding C1). The audit measured two
 * light-theme tokens below 4.5:1 in a real browser; this holds the tokens to that figure in
 * both themes, so a new shade is checked when it is chosen and not at the next audit.
 *
 * It reads the two token blocks of `styles.css` and nothing else: a colour written outside
 * them is not covered (the stylesheet's own rule is that no rule names a colour).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

/** The `--name: #rrggbb` pairs of one rule block. */
function tokensOf(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block in styles.css`);
  const block = css.slice(start, css.indexOf('}', start));
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})\b/g)) {
    tokens.set(match[1]!, match[2]!);
  }
  return tokens;
}

/** Relative luminance of `#rrggbb` (WCAG 2.x). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The WCAG contrast ratio of two colours. */
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Text tokens, each with the background tokens it is drawn on. */
const PAIRS: readonly (readonly [text: string, backgrounds: readonly string[]])[] = [
  ['--text', ['--bg', '--surface', '--row-alt']],
  ['--muted', ['--bg', '--surface', '--row-alt']],
  ['--accent', ['--bg', '--surface', '--row-alt']],
  ['--chip-text', ['--chip-bg']],
  // The status letters and marks in the gutter, on a plain and on a striped row.
  ['--status-draft', ['--surface', '--row-alt', '--bg']],
  ['--status-translated', ['--surface', '--row-alt', '--bg']],
  ['--status-confirmed', ['--surface', '--row-alt', '--bg']],
  ['--status-locked', ['--surface', '--row-alt', '--bg']],
  // Text on a filled control or badge.
  ['--on-accent', ['--accent', '--qa-error', '--qa-warning', '--qa-info']],
  // The QA colours as text (the panel's severity words).
  ['--qa-error', ['--surface', '--bg']],
  ['--qa-warning', ['--surface', '--bg']],
];

describe.each([
  ['light', ':root'],
  ['dark', ":root[data-theme='dark']"],
])('the %s theme', (_name, selector) => {
  const tokens = tokensOf(selector);
  const colour = (name: string): string => {
    const value = tokens.get(name);
    if (value === undefined) throw new Error(`${selector} defines no ${name}`);
    return value;
  };

  it.each(PAIRS.flatMap(([text, backgrounds]) => backgrounds.map((bg) => [text, bg])))(
    '%s on %s is at least 4.5:1',
    (text, bg) => {
      expect(ratio(colour(text!), colour(bg!))).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe('the contrast arithmetic', () => {
  it('gives the known ratios', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#ffffff', '#ffffff')).toBe(1);
    // The shade the audit found failing on a striped row, as the browser measured it.
    expect(ratio('#2f855a', '#f7f7f5')).toBeCloseTo(4.23, 2);
  });
});
