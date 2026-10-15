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
});
