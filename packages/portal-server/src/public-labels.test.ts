/**
 * The portal pages' form labels and row controls (issue #392, the accessibility audit,
 * `planning/accessibility-audit.md` §7). The audit found the client's order form with five
 * labels tied to no field, so a screen reader announced unnamed controls, and the admin's
 * order lists with rows that opened on a click alone. The pages are plain scripts with their
 * markup in template strings, so this reads the scripts' text: it holds the shape, and a real
 * browser showed the result once.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./public/${name}`, import.meta.url)), 'utf8');

/** Every `<label ...>...</label>` in a script, with its opening tag and its content. */
function labelsOf(source: string): { open: string; body: string }[] {
  return [...source.matchAll(/<label([^>]*)>([\s\S]*?)<\/label>/g)].map((m) => ({
    open: m[1]!,
    body: m[2]!,
  }));
}

describe.each(['client.js', 'admin.js'])('%s', (name) => {
  const source = script(name);

  it('ties every label to a field: it wraps one, or names one that exists', () => {
    const labels = labelsOf(source);
    expect(labels.length).toBeGreaterThan(0);
    for (const { open, body } of labels) {
      if (/<(input|select|textarea)\b/.test(body)) continue;
      // The one conditional `for`: the single word-count field, absent when the count is per file.
      const target = /for="([^"]+)"/.exec(open)?.[1];
      // A caption over a group of buttons is named on the group instead.
      if (target === undefined && body.trim() === 'Status') {
        expect(source).toContain('role="group" aria-label="Status"');
        continue;
      }
      expect(target, `label "${body.trim()}" names no field`).toBeDefined();
      expect(source, `no field has id="${target}"`).toContain(`id="${target}"`);
    }
  });

  it('announces every error message', () => {
    const errors = [...source.matchAll(/<p class="error"[^>]*>/g)].map((m) => m[0]);
    expect(errors.length).toBeGreaterThan(0);
    for (const tag of errors) expect(tag).toContain('role="alert"');
  });
});

describe('admin.js', () => {
  it('opens an order from a real control in every list of orders', () => {
    const source = script('admin.js');
    const rows = source.split('<tr data-open=').slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.slice(0, row.indexOf('</tr>'))).toContain('openOrderButton(o.id)');
    }
    expect(source).toMatch(/function openOrderButton[\s\S]*?<button type="button"/);
  });
});
