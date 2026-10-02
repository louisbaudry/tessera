/**
 * Serving the built SPA (backlog #36): the container's one process holds
 * both the API and the bundle, and the bundle must not widen what a
 * request can reach.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';

let dir: string;
let app: FastifyInstance | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-web-'));
  mkdirSync(join(dir, 'web', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>Tessera</title>');
  writeFileSync(join(dir, 'web', 'assets', 'app.js'), 'console.log(1);');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function start(withWeb: boolean): Promise<FastifyInstance> {
  const config: ServerConfig = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
    ...(withWeb ? { webDir: join(dir, 'web') } : {}),
  };
  app = await buildApp({ config, logger: false });
  return app;
}

describe('the SPA bundle', () => {
  it('is served at / and under /assets/ with no session', async () => {
    const a = await start(true);
    const index = await a.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.body).toContain('Tessera');
    const asset = await a.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
  });

  it('answers an unknown path with a 404, never index.html', async () => {
    const a = await start(true);
    expect((await a.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
  });

  it('does not serve anything outside its root, however the path is spelt', async () => {
    const a = await start(true);
    for (const url of [
      '/../platform.sqlite',
      '/%2e%2e/platform.sqlite',
      '/..%2fplatform.sqlite',
    ]) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain('SQLite');
    }
  });

  it('leaves /api/ behind the gate', async () => {
    const a = await start(true);
    expect((await a.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
  });

  it('is absent when no web directory is configured', async () => {
    const a = await start(false);
    expect((await a.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });
});
