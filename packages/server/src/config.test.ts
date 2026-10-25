import { isAbsolute, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_DRAFT_MODEL, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('has local defaults and resolves every path', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3400);
    expect(isAbsolute(config.dbPath)).toBe(true);
    expect(config.dbPath.endsWith('platform.sqlite')).toBe(true);
    expect(isAbsolute(config.storageRoot)).toBe(true);
    expect(config.webDir).toBeUndefined();
  });

  it('serves the SPA only when CAT_WEB_DIR is set and non-empty', () => {
    expect(loadConfig({ CAT_WEB_DIR: '' }).webDir).toBeUndefined();
    expect(loadConfig({ CAT_WEB_DIR: '/srv/web' }).webDir).toBe(resolve('/srv/web'));
  });

  it('reads every value from the environment', () => {
    const config = loadConfig({
      CAT_PORT: '8080',
      CAT_DB_PATH: '/srv/cat/platform.sqlite',
      CAT_STORAGE_ROOT: '/srv/cat/storage',
    });
    // `resolve` on both sides: on Windows `/srv/cat` becomes `D:\\srv\\cat`,
    // which is the right answer there and not a string to hard-code.
    expect(config).toEqual({
      port: 8080,
      dbPath: resolve('/srv/cat/platform.sqlite'),
      storageRoot: resolve('/srv/cat/storage'),
      draftModel: DEFAULT_DRAFT_MODEL,
    });
  });

  it('reads the engine key and model from the environment, an empty key meaning none', () => {
    expect(loadConfig({}).anthropicApiKey).toBeUndefined();
    expect(loadConfig({ ANTHROPIC_API_KEY: '' }).anthropicApiKey).toBeUndefined();
    const config = loadConfig({ ANTHROPIC_API_KEY: 'k', CAT_DRAFT_MODEL: 'm-9' });
    expect(config.anthropicApiKey).toBe('k');
    expect(config.draftModel).toBe('m-9');
    expect(loadConfig({ CAT_DRAFT_MODEL: '' }).draftModel).toBe(DEFAULT_DRAFT_MODEL);
  });

  it('reads the DeepL key from the environment only, an empty key meaning none', () => {
    expect(loadConfig({}).deeplApiKey).toBeUndefined();
    expect(loadConfig({ DEEPL_API_KEY: '' }).deeplApiKey).toBeUndefined();
    expect(loadConfig({ DEEPL_API_KEY: 'd:fx' }).deeplApiKey).toBe('d:fx');
  });

  it('reads the base domain, normalised, and refuses one that is not a bare host name', () => {
    expect(loadConfig({}).baseDomain).toBeUndefined();
    expect(loadConfig({ CAT_BASE_DOMAIN: '' }).baseDomain).toBeUndefined();
    expect(loadConfig({ CAT_BASE_DOMAIN: 'Example.COM.' }).baseDomain).toBe(
      'example.com',
    );
    for (const bad of ['example.com:8080', 'a b', 'https://example.com', '[::1]']) {
      expect(() => loadConfig({ CAT_BASE_DOMAIN: bad }), bad).toThrow(/CAT_BASE_DOMAIN/);
    }
  });

  describe('single sign-on', () => {
    const google = {
      GOOGLE_OAUTH_CLIENT_ID: 'gid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
    };
    const microsoft = {
      MICROSOFT_OAUTH_CLIENT_ID: 'mid',
      MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret',
    };

    it('is off with no provider, and a provider with half a pair is off', () => {
      expect(loadConfig({ CAT_BASE_DOMAIN: 'example.com' }).sso).toBeUndefined();
      expect(
        loadConfig({
          CAT_BASE_DOMAIN: 'example.com',
          GOOGLE_OAUTH_CLIENT_ID: 'gid',
          MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret',
        }).sso,
      ).toBeUndefined();
      expect(
        loadConfig({
          CAT_BASE_DOMAIN: 'example.com',
          GOOGLE_OAUTH_CLIENT_ID: '',
          GOOGLE_OAUTH_CLIENT_SECRET: '',
        }).sso,
      ).toBeUndefined();
    });

    it('calls back on auth.<base domain> by default, with each provider that has a pair', () => {
      expect(loadConfig({ CAT_BASE_DOMAIN: 'Example.com', ...google }).sso).toEqual({
        callbackOrigin: 'https://auth.example.com',
        providers: { google: { clientId: 'gid', clientSecret: 'gsecret' } },
      });
      expect(
        Object.keys(
          loadConfig({ CAT_BASE_DOMAIN: 'example.com', ...google, ...microsoft }).sso!
            .providers,
        ),
      ).toEqual(['google', 'microsoft']);
    });

    it('is off with no base domain and no callback origin: there is nowhere to call back', () => {
      expect(loadConfig({ ...google }).sso).toBeUndefined();
    });

    it('takes a callback origin when there is no base domain, https or the local machine', () => {
      expect(
        loadConfig({ ...google, SSO_CALLBACK_ORIGIN: 'https://login.example.org' }).sso
          ?.callbackOrigin,
      ).toBe('https://login.example.org');
      expect(
        loadConfig({ ...google, SSO_CALLBACK_ORIGIN: 'http://localhost:3400' }).sso
          ?.callbackOrigin,
      ).toBe('http://localhost:3400');
    });

    it('refuses an origin that is not bare, or plain http off the local machine', () => {
      for (const bad of [
        'http://login.example.org',
        'https://login.example.org/cb',
        'https://login.example.org/?x=1',
        'https://user:pw@login.example.org',
        'not a url',
      ]) {
        expect(() => loadConfig({ ...google, SSO_CALLBACK_ORIGIN: bad }), bad).toThrow(
          /SSO_CALLBACK_ORIGIN/,
        );
      }
    });

    it('refuses any callback host but auth.<base domain> when there is a base domain', () => {
      expect(() =>
        loadConfig({
          CAT_BASE_DOMAIN: 'example.com',
          ...google,
          SSO_CALLBACK_ORIGIN: 'https://login.example.com',
        }),
      ).toThrow(/auth\.example\.com/);
      expect(
        loadConfig({
          CAT_BASE_DOMAIN: 'example.com',
          ...google,
          SSO_CALLBACK_ORIGIN: 'https://auth.example.com',
        }).sso?.callbackOrigin,
      ).toBe('https://auth.example.com');
    });
  });
});
