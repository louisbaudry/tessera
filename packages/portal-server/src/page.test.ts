import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_PORTAL_NAME, escapeHtml, renderPortalPage } from './page.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

describe('renderPortalPage', () => {
  it('fills every placeholder', () => {
    expect(
      renderPortalPage(
        '<title>{{portalName}}</title><h1>{{portalName}}</h1><meta content="{{portalCurrency}}">',
        { name: 'Acme', currency: 'EUR' },
      ),
    ).toBe('<title>Acme</title><h1>Acme</h1><meta content="EUR">');
  });

  it('escapes markup and keeps $ patterns literal', () => {
    expect(
      renderPortalPage('<h1>{{portalName}}</h1>', {
        name: `<b onload="x">&'$&`,
        currency: 'EUR',
      }),
    ).toBe('<h1>&lt;b onload=&quot;x&quot;&gt;&amp;&#39;$&amp;</h1>');
    expect(escapeHtml('plain')).toBe('plain');
  });
});

describe('the shipped pages', () => {
  it('name the portal and its currency by placeholder only', () => {
    for (const file of ['client.html', 'admin.html']) {
      const html = readFileSync(join(publicDir, file), 'utf8');
      expect(html, file).toContain('{{portalName}}');
      expect(html, file).toContain(
        '<meta name="portal-currency" content="{{portalCurrency}}" />',
      );
      expect(
        renderPortalPage(html, { name: DEFAULT_PORTAL_NAME, currency: 'USD' }),
        file,
      ).not.toContain('{{');
    }
  });
});
