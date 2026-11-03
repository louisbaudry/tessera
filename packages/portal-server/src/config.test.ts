import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('omits smtp config when PORTAL_SMTP_HOST is unset — falls back to console notifications', () => {
    const config = loadConfig({});
    expect(config.smtp).toBeUndefined();
  });

  it('builds smtp config from env when PORTAL_SMTP_HOST is set', () => {
    const config = loadConfig({
      PORTAL_SMTP_HOST: 'smtp.example.com',
      PORTAL_SMTP_PORT: '2525',
      PORTAL_SMTP_SECURE: 'true',
      PORTAL_SMTP_USER: 'user',
      PORTAL_SMTP_PASS: 'pass',
      PORTAL_SMTP_FROM: 'Portal <portal@example.com>',
      PORTAL_ADMIN_EMAIL: 'admin@example.com',
    });
    expect(config.smtp).toEqual({
      host: 'smtp.example.com',
      port: 2525,
      secure: true,
      user: 'user',
      pass: 'pass',
      from: 'Portal <portal@example.com>',
      adminEmail: 'admin@example.com',
    });
  });

  it('has no default sender: an unset or blank PORTAL_SMTP_FROM leaves it absent (issue #306)', () => {
    const env = {
      PORTAL_SMTP_HOST: 'smtp.example.com',
      PORTAL_ADMIN_EMAIL: 'a@example.com',
    };
    for (const from of [undefined, '', '   ']) {
      const smtp = loadConfig({ ...env, PORTAL_SMTP_FROM: from }).smtp;
      expect(smtp).toBeDefined();
      expect(smtp).not.toHaveProperty('from');
    }
  });

  it('rejects PORTAL_SMTP_HOST without PORTAL_ADMIN_EMAIL', () => {
    expect(() => loadConfig({ PORTAL_SMTP_HOST: 'smtp.example.com' })).toThrow(
      /PORTAL_ADMIN_EMAIL/,
    );
  });

  it('reads the currency from PORTAL_CURRENCY, USD when unset, and refuses a code ISO does not list (issue #327)', () => {
    expect(loadConfig({}).currency).toBe('USD');
    expect(loadConfig({ PORTAL_CURRENCY: '  ' }).currency).toBe('USD');
    expect(loadConfig({ PORTAL_CURRENCY: ' EUR ' }).currency).toBe('EUR');
    for (const bad of ['eur', 'XYZ', '€']) {
      expect(() => loadConfig({ PORTAL_CURRENCY: bad }), bad).toThrow(/ISO 4217/);
    }
  });

  it('turns contact sign-in on only with a callback origin and a provider pair (issue #342)', () => {
    const pair = { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' };
    expect(loadConfig(pair).sso).toBeUndefined();
    expect(
      loadConfig({ PORTAL_SSO_CALLBACK_ORIGIN: 'https://portal-auth.example.org' }).sso,
    ).toBeUndefined();
    expect(
      loadConfig({
        ...pair,
        PORTAL_SSO_CALLBACK_ORIGIN: 'https://portal-auth.example.org',
      }).sso,
    ).toEqual({
      callbackOrigin: 'https://portal-auth.example.org',
      providers: { google: { clientId: 'id', clientSecret: 'secret' } },
    });
    for (const bad of [
      'http://portal-auth.example.org',
      'https://x.example.org/path',
      'nope',
    ]) {
      expect(() => loadConfig({ PORTAL_SSO_CALLBACK_ORIGIN: bad }), bad).toThrow(
        /PORTAL_SSO_CALLBACK_ORIGIN/,
      );
    }
  });

  it('reads the portal name from PORTAL_DISPLAY_NAME, trimmed, a blank one meaning none (issue #310)', () => {
    expect(loadConfig({}).displayName).toBeUndefined();
    expect(loadConfig({ PORTAL_DISPLAY_NAME: '   ' }).displayName).toBeUndefined();
    expect(loadConfig({ PORTAL_DISPLAY_NAME: ' Example Portal ' }).displayName).toBe(
      'Example Portal',
    );
  });
});
