/**
 * The chat connector's first slice through Fastify's `inject` and, for the protocol itself,
 * through the official MCP client over a real socket (backlog #378,
 * `planning/chat-connector-spec.md` §5 S1a). What it holds:
 *
 * - a connector token opens the MCP endpoint and nothing else, and a session opens everything
 *   else and not the endpoint;
 * - a vendor gets no token; a revoked token, and one whose person left the tenant, open nothing;
 * - the tools answer for the token's own tenant only, and return no file name and no QA message.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  createAccount,
  getTenantForAccount,
  listSegments,
  openPlatformDb,
  openProjectDb,
  removeTenantStaff,
  setTenantSlug,
  type Account,
} from '@cat-tool/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { MCP_PATH, MCP_PROTOCOL_VERSION } from './connector.js';
import { projectPath } from './storage.js';
import { tenantOf } from './tenant.fixture.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/docx/form-minimal.docx',
);
const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
/** A file name that stands for a client's: no tool may return it. */
const FILE_NAME = 'acme-confidential-contract.docx';

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account;
let pat: Account;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-connector-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  const platform = openPlatformDb(config.dbPath);
  const make = (name: string, extra: Record<string, unknown> = {}) =>
    createAccount(platform, {
      email: `${name}@example.com`,
      passwordHash: hashPassword(`${name}-pw`),
      actor: SETUP,
      ...extra,
    });
  // A vendor first, so no tenant's id equals its founder's account id.
  make('vera', { role: 'vendor' });
  alice = make('alice');
  make('carol');
  pat = make('pat', {
    joinTenant: {
      tenantId: getTenantForAccount(platform, alice.id)!.tenant.id,
      role: 'pm',
    },
  });
  platform.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const as = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(name: string, on: FastifyInstance = app): Promise<string> {
  const res = await on.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: `${name}@example.com`, password: `${name}-pw` },
  });
  return (res.json() as { token: string }).token;
}

/** A connector token for `name`, made through the route, with the response. */
async function connect(name: string, label: unknown = 'My assistant') {
  const session = await login(name);
  const res = await app.inject({
    method: 'POST',
    url: '/api/connector-tokens',
    headers: as(session),
    payload: { label },
  });
  const body = res.json() as { token?: string; connection?: { id: number } };
  return { session, res, token: body.token ?? '', id: body.connection?.id ?? 0 };
}

/** A project of `name`'s tenant with the fixture uploaded under `FILE_NAME`. */
async function project(name: string, slug: string): Promise<void> {
  const session = await login(name);
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(session),
    payload: { name: slug, srcLang: 'en', tgtLang: 'es' },
  });
  expect(made.statusCode, made.body).toBe(201);
  const form = new FormData();
  form.append('file', new Blob([readFileSync(FIXTURE)]), FILE_NAME);
  const up = await app.inject({
    method: 'POST',
    url: `/api/projects/${slug}/files`,
    headers: as(session),
    payload: form,
  });
  expect(up.statusCode, up.body).toBe(201);
}

let nextId = 1;
/** One JSON-RPC request to the endpoint. */
function rpc(
  token: string | null,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: MCP_PATH,
    headers: { ...(token === null ? {} : as(token)), ...headers },
    payload: { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) },
  });
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}
async function call(token: string, name: string, args?: unknown): Promise<ToolResult> {
  const res = await rpc(token, 'tools/call', {
    name,
    ...(args ? { arguments: args } : {}),
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { result: ToolResult }).result;
}

describe('connector tokens', () => {
  it('shows the token once, lists it without the token, and revokes it', async () => {
    const { session, res, token, id } = await connect('alice', '  Desk  ');
    expect(res.statusCode, res.body).toBe(201);
    expect(token).toMatch(/^[\w-]{32,}$/);
    expect((res.json() as { connection: { label: string } }).connection.label).toBe(
      'Desk',
    );

    const list = await app.inject({
      method: 'GET',
      url: '/api/connector-tokens',
      headers: as(session),
    });
    expect(list.body).not.toContain(token);
    expect(
      (list.json() as { connections: Array<{ id: number }> }).connections.map(
        (c) => c.id,
      ),
    ).toEqual([id]);

    expect((await rpc(token, 'ping')).statusCode).toBe(200);
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/connector-tokens/${id}`,
      headers: as(session),
    });
    expect(gone.statusCode).toBe(200);
    expect((await rpc(token, 'ping')).statusCode).toBe(401);
  });

  it('refuses a vendor, who belongs to no organisation, and shows them an empty list', async () => {
    const { session, res } = await connect('vera');
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('token');
    const list = await app.inject({
      method: 'GET',
      url: '/api/connector-tokens',
      headers: as(session),
    });
    expect(list.json()).toEqual({ connections: [] });
  });

  it.each([[''], ['x'.repeat(81)], [7], [null]])(
    'refuses the label %j with a 400',
    async (label) => {
      const { res } = await connect('alice', label);
      expect(res.statusCode).toBe(400);
    },
  );

  it('answers a colleague’s token and a missing one with the same 404', async () => {
    const mine = await connect('alice');
    const theirs = await login('pat');
    const revoke = (id: string) =>
      app.inject({
        method: 'DELETE',
        url: `/api/connector-tokens/${id}`,
        headers: as(theirs),
      });
    const actual = await revoke(String(mine.id));
    const missing = await revoke('987654');
    expect([actual.statusCode, actual.body]).toEqual([missing.statusCode, missing.body]);
    expect(actual.statusCode).toBe(404);
    expect((await revoke('not-a-number')).statusCode).toBe(404);
    // And it changed nothing: Alice's token still works.
    expect((await rpc(mine.token, 'ping')).statusCode).toBe(200);
  });

  it('opens nothing once its person has left the organisation', async () => {
    const { token } = await connect('pat');
    expect((await rpc(token, 'ping')).statusCode).toBe(200);
    const platform = openPlatformDb(config.dbPath);
    removeTenantStaff(platform, {
      tenantId: tenantOf(config, alice).id,
      accountId: pat.id,
      actor: SETUP,
    });
    platform.close();
    expect((await rpc(token, 'ping')).statusCode).toBe(401);
  });
});

describe('two credentials, and each opens one thing', () => {
  it('refuses a session at the connector’s endpoint', async () => {
    const session = await login('alice');
    expect((await rpc(session, 'ping')).statusCode).toBe(401);
    expect((await rpc(null, 'ping')).statusCode).toBe(401);
    expect((await rpc('not-a-token', 'ping')).statusCode).toBe(401);
  });

  it('refuses a connector token on every other route', async () => {
    const { token } = await connect('alice');
    for (const [method, url] of [
      ['GET', '/api/me'],
      ['GET', '/api/projects'],
      ['GET', '/api/connector-tokens'],
      ['POST', '/api/connector-tokens'],
      ['POST', '/api/projects'],
      ['POST', '/api/logout'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: as(token),
        payload: { label: 'x', name: 'p', srcLang: 'en', tgtLang: 'es' },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('refuses a token on another organisation’s address', async () => {
    const platform = openPlatformDb(config.dbPath);
    const carol = (
      platform
        .prepare("SELECT id FROM account WHERE email = 'carol@example.com'")
        .get() as {
        id: number;
      }
    ).id;
    setTenantSlug(platform, {
      tenantId: tenantOf(config, alice).id,
      slug: 'alpha',
      actor: SETUP,
    });
    setTenantSlug(platform, {
      tenantId: getTenantForAccount(platform, carol)!.tenant.id,
      slug: 'beta',
      actor: SETUP,
    });
    platform.close();
    const { token } = await connect('alice');
    const hosted = await buildApp({
      config: { ...config, baseDomain: 'cat.example' },
      logger: false,
    });
    try {
      const ping = (host: string) =>
        hosted.inject({
          method: 'POST',
          url: MCP_PATH,
          headers: { ...as(token), host },
          payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
        });
      expect((await ping('alpha.cat.example')).statusCode).toBe(200);
      expect((await ping('beta.cat.example')).statusCode).toBe(401);
    } finally {
      await hosted.close();
    }
  });
});

describe('the protocol', () => {
  it('initialises, lists three read-only tools and answers a ping', async () => {
    const { token } = await connect('alice');
    const init = await rpc(token, 'initialize', {
      protocolVersion: '2099-01-01',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const result = (
      init.json() as {
        result: {
          protocolVersion: string;
          capabilities: unknown;
          serverInfo: { name: string };
        };
      }
    ).result;
    // A version it does not speak is answered with the one it does.
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo.name).toBe('tessera');

    const tools = (
      (await rpc(token, 'tools/list')).json() as {
        result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> };
      }
    ).result.tools;
    expect(tools.map((t) => t.name)).toEqual([
      'list_projects',
      'get_project_progress',
      'get_qa_findings',
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
    }
    expect((await rpc(token, 'ping')).json()).toMatchObject({ result: {} });
  });

  it('accepts a notification with a 202 and no body', async () => {
    const { token } = await connect('alice');
    const res = await app.inject({
      method: 'POST',
      url: MCP_PATH,
      headers: as(token),
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect([res.statusCode, res.body]).toEqual([202, '']);
  });

  it('offers no stream and no session to end', async () => {
    const { token } = await connect('alice');
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({ method, url: MCP_PATH, headers: as(token) });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });

  it('refuses a batch, a message that is not JSON-RPC 2.0, and another protocol version', async () => {
    const { token } = await connect('alice');
    const post = (payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: MCP_PATH,
        headers: { ...as(token), ...headers },
        payload: payload as Record<string, unknown>,
      });
    expect((await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).statusCode).toBe(
      400,
    );
    expect((await post({ id: 1, method: 'ping' })).statusCode).toBe(400);
    expect(
      (
        await post(
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { 'mcp-protocol-version': '2024-11-05' },
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { 'mcp-protocol-version': MCP_PROTOCOL_VERSION },
        )
      ).statusCode,
    ).toBe(200);
  });

  it('refuses a request that names another site as its origin', async () => {
    const { token } = await connect('alice');
    const from = (origin: string) =>
      rpc(token, 'ping', undefined, { origin, host: 'cat.example' });
    expect((await from('https://evil.example')).statusCode).toBe(403);
    expect((await from('not a url')).statusCode).toBe(403);
    expect((await from('https://cat.example')).statusCode).toBe(200);
  });

  it('answers an unknown method and an unknown tool with protocol errors', async () => {
    const { token } = await connect('alice');
    const error = async (method: string, params?: unknown) =>
      ((await rpc(token, method, params)).json() as { error: { code: number } }).error
        .code;
    expect(await error('resources/list')).toBe(-32601);
    expect(await error('tools/call', { name: 'delete_everything' })).toBe(-32602);
    expect(
      await error('tools/call', { name: 'list_projects', arguments: { x: 1 } }),
    ).toBe(-32602);
    expect(await error('tools/call', { name: 'get_project_progress' })).toBe(-32602);
    expect(
      await error('tools/call', {
        name: 'get_qa_findings',
        arguments: { project: 'a', tenant: 2 },
      }),
    ).toBe(-32602);
  });
});

describe('the tools', () => {
  it('list the token’s own organisation’s projects and no one else’s', async () => {
    await project('alice', 'alpha-job');
    await project('carol', 'carol-secret-job');
    const { token } = await connect('alice');
    const result = await call(token, 'list_projects');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      projects: [
        { name: 'alpha-job', sourceLanguage: 'en', targetLanguage: 'es', files: 1 },
      ],
    });
    // The text block is the same data, for a client that reads only text.
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(JSON.stringify(result)).not.toContain('carol');

    // A colleague in the same organisation sees the same projects.
    const colleague = await connect('pat');
    expect((await call(colleague.token, 'list_projects')).structuredContent).toEqual(
      result.structuredContent,
    );
  });

  it('report progress by status, and name a file by its position, never its name', async () => {
    await project('alice', 'alpha-job');
    const db = openProjectDb(
      projectPath(config.storageRoot, tenantOf(config, alice), 'alpha-job'),
    );
    const segments = listSegments(db, 1);
    db.close();
    const session = await login('alice');
    const first = segments.find((s) => !s.locked)!;
    const edit = await app.inject({
      method: 'PUT',
      url: `/api/projects/alpha-job/segments/${first.id}`,
      headers: as(session),
      payload: { targetTokens: [{ t: 'text', v: 'Texto de prueba' }] },
    });
    expect(edit.statusCode, edit.body).toBe(200);

    const { token } = await connect('alice');
    const result = await call(token, 'get_project_progress', { project: 'alpha-job' });
    const files = (
      result.structuredContent as {
        files: Array<{
          file: number;
          kind: string;
          segments: number;
          byStatus: Record<string, number>;
        }>;
      }
    ).files;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ file: 1, kind: 'docx', segments: segments.length });
    const counted = Object.values(files[0]!.byStatus).reduce((a, b) => a + b, 0);
    expect(counted).toBe(segments.length);
    expect(files[0]!.byStatus.new).toBe(segments.filter((s) => !s.locked).length - 1);

    const said = JSON.stringify(result);
    expect(said).not.toContain(FILE_NAME);
    expect(said).not.toContain('acme');
    expect(said).not.toContain('Texto de prueba');
  });

  it('report QA findings as counts, with no message and no text', async () => {
    await project('alice', 'alpha-job');
    const path = projectPath(config.storageRoot, tenantOf(config, alice), 'alpha-job');
    const db = openProjectDb(path);
    const [one, two] = listSegments(db, 1).filter((s) => !s.locked);
    const add = (segmentId: number, rule: string, severity: string, dismissed: number) =>
      db
        .prepare(
          `INSERT INTO qa_issue (segment_id, rule, severity, message, dismissed, run_at)
           VALUES (?, ?, ?, 'the number 4471 from the client text is missing', ?, ?)`,
        )
        .run(segmentId, rule, severity, dismissed, new Date().toISOString());
    add(one!.id, 'num.missing', 'error', 0);
    add(two!.id, 'num.missing', 'error', 1);
    add(two!.id, 'punct.terminal', 'warning', 0);
    db.close();

    const { token } = await connect('alice');
    const result = await call(token, 'get_qa_findings', { project: 'alpha-job' });
    expect(result.structuredContent).toEqual({
      project: 'alpha-job',
      stale: false,
      blocking: 1,
      byRule: [
        { rule: 'num.missing', severity: 'error', open: 1, dismissed: 1 },
        { rule: 'punct.terminal', severity: 'warning', open: 1, dismissed: 0 },
      ],
      files: [{ file: 1, blocking: 1 }],
    });
    const said = JSON.stringify(result);
    expect(said).not.toContain('4471');
    expect(said).not.toContain(FILE_NAME);
  });

  it('answer another organisation’s project exactly as one that does not exist', async () => {
    await project('carol', 'carol-secret-job');
    const { token } = await connect('alice');
    for (const tool of ['get_project_progress', 'get_qa_findings']) {
      const theirs = await call(token, tool, { project: 'carol-secret-job' });
      const missing = await call(token, tool, { project: 'no-such-job' });
      expect(theirs.isError).toBe(true);
      expect(theirs.content[0]!.text.replace('carol-secret-job', 'no-such-job')).toBe(
        missing.content[0]!.text,
      );
      // A name that could not be a project's is the same refusal, never a path.
      const odd = await call(token, tool, { project: '../../etc/passwd' });
      expect(odd.isError).toBe(true);
      expect(odd.content[0]!.text).toContain('no project named');
    }
  });
});

describe('the official MCP client', () => {
  it('connects with a connector token, lists the tools and calls one', async () => {
    await project('alice', 'alpha-job');
    const { token } = await connect('alice');
    // A real socket: the client speaks HTTP, and `inject` would not exercise its transport.
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${address}${MCP_PATH}`),
      {
        requestInit: { headers: as(token) },
      },
    );
    const client = new Client({ name: 'connector-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe('tessera');
      expect(client.getInstructions()).toContain('read-only');

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        'list_projects',
        'get_project_progress',
        'get_qa_findings',
      ]);
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

      const listed = await client.callTool({ name: 'list_projects', arguments: {} });
      expect(listed.isError).toBe(false);
      expect(listed.structuredContent).toEqual({
        projects: [
          { name: 'alpha-job', sourceLanguage: 'en', targetLanguage: 'es', files: 1 },
        ],
      });

      const missing = await client.callTool({
        name: 'get_project_progress',
        arguments: { project: 'no-such-job' },
      });
      expect(missing.isError).toBe(true);
      await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(
        /Unknown tool/,
      );
    } finally {
      await client.close();
    }
  });

  it('is refused with a session in place of a connector token', async () => {
    const session = await login('alice');
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${address}${MCP_PATH}`),
      {
        requestInit: { headers: as(session) },
      },
    );
    const client = new Client({ name: 'connector-test', version: '0.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
    await client.close().catch(() => undefined);
  });
});
