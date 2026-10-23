import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_PORTAL_NAME, escapeHtml, renderPortalPage } from './page.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

describe('renderPortalPage', () => {
  it('fills every placeholder', () => {
    expect(
      renderPortalPage('<title>{{portalName}}</title><h1>{{portalName}}</h1>', 'Acme'),
    ).toBe('<title>Acme</title><h1>Acme</h1>');
  });

  it('escapes markup and keeps $ patterns literal', () => {
    expect(renderPortalPage('<h1>{{portalName}}</h1>', `<b onload="x">&'$&`)).toBe(
      '<h1>&lt;b onload=&quot;x&quot;&gt;&amp;&#39;$&amp;</h1>',
    );
    expect(escapeHtml('plain')).toBe('plain');
  });
});

describe('the shipped pages', () => {
  it('name the portal by placeholder only', () => {
    for (const file of ['client.html', 'admin.html']) {
      const html = readFileSync(join(publicDir, file), 'utf8');
      expect(html, file).toContain('{{portalName}}');
      expect(renderPortalPage(html, DEFAULT_PORTAL_NAME), file).not.toContain('{{');
    }
  });
});
