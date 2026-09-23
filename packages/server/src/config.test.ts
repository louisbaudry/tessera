import { isAbsolute, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('has local defaults and resolves every path', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3400);
    expect(isAbsolute(config.dbPath)).toBe(true);
    expect(config.dbPath.endsWith('platform.sqlite')).toBe(true);
    expect(isAbsolute(config.storageRoot)).toBe(true);
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
    });
  });
});
