/**
 * The glossary API through Fastify's `inject` (smart-glossary-spec.md
 * §5a.1, backlog #43a): storage, attaching, and a session from detection
 * to commit, against a small real fixture DOCX whose text repeats terms.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hashPassword,
  plainText,
  type AuditActor,
  type GlossaryMismatch,
  type Segment,
} from '@cat-tool/core';
import {
  addVariant,
  createAccount,
  insertTerm,
  listDecisions,
  listEvents,
  listVariants,
  openGlossary,
  openPlatformDb,
  openProjectDb,
  type Account,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import type { SessionView } from './glossary-session.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/docx/prose-short.docx',
);

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-glossary-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  const platform = openPlatformDb(config.dbPath);
  alice = createAccount(platform, {
    email: 'alice@example.com',
    passwordHash: hashPassword('alice-pw'),
    actor: SETUP,
  });
  createAccount(platform, {
    email: 'bob@example.com',
    passwordHash: hashPassword('bob-pw'),
    actor: SETUP,
  });
  platform.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { token: string }).token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** A project with the prose fixture uploaded; returns the file id. */
async function projectWithFile(
  token: string,
  name = 'ms',
  srcLang = 'en',
  tgtLang = 'de',
): Promise<number> {
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: auth(token),
    payload: { name, srcLang, tgtLang },
  });
  expect(made.statusCode, made.body).toBe(201);
  const form = new FormData();
  form.append('file', new Blob([readFileSync(FIXTURE)]), 'prose-short.docx');
  const up = await app.inject({
    method: 'POST',
    url: `/api/projects/${name}/files`,
    headers: auth(token),
    payload: form,
  });
  expect(up.statusCode, up.body).toBe(201);
  const files = await app.inject({
    method: 'GET',
    url: `/api/projects/${name}`,
    headers: auth(token),
  });
  return (files.json() as { files: { id: number }[] }).files[0]!.id;
}

const countTerms = (glossary: ReturnType<typeof openGlossary>): number =>
  (glossary.prepare('SELECT COUNT(*) AS n FROM term').get() as { n: number }).n;

const createGlossaryNamed = (token: string, name: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/glossaries',
    headers: auth(token),
    payload: { name },
  });

const attach = (
  token: string,
  project: string,
  glossary: string,
  writeTarget?: boolean,
) =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${project}/glossaries`,
    headers: auth(token),
    payload: { glossary, writeTarget },
  });

const sessionUrl = (project: string, fileId: number) =>
  `/api/projects/${project}/files/${fileId}/glossary/session`;

const startSession = (token: string, project: string, fileId: number) =>
  app.inject({ method: 'POST', url: sessionUrl(project, fileId), headers: auth(token) });

const act = (
  token: string,
  project: string,
  fileId: number,
  action: string,
  payload: Record<string, unknown>,
) =>
  app.inject({
    method: 'POST',
    url: `${sessionUrl(project, fileId)}/${action}`,
    headers: auth(token),
    payload,
  });

describe('glossaries under the account root', () => {
  it('creates an empty glossary under the account root, lists it, and refuses a second by that name', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/glossaries', headers: auth(token) })
      ).json(),
    ).toEqual([]);

    const made = await createGlossaryNamed(token, 'acme');
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toEqual({ slug: 'acme' });
    expect(
      existsSync(join(config.storageRoot, alice.storageRoot, 'glossaries', 'acme.ctg')),
    ).toBe(true);
    expect((await createGlossaryNamed(token, 'acme')).statusCode).toBe(409);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/glossaries',
      headers: auth(token),
    });
    expect(listed.json()).toEqual([{ slug: 'acme' }]);
    expect(listed.body).not.toContain(alice.storageRoot);
  });

  it('refuses a name outside the slug alphabet, so no request names a path', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    for (const name of ['../x', 'a/b', 'A B', '', undefined, 3]) {
      expect((await createGlossaryNamed(token, name)).statusCode, String(name)).toBe(400);
    }
  });

  it("does not show one account another's glossaries", async () => {
    const a = await login('alice@example.com', 'alice-pw');
    const b = await login('bob@example.com', 'bob-pw');
    await createGlossaryNamed(a, 'acme');
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/glossaries', headers: auth(b) })
      ).json(),
    ).toEqual([]);
    await projectWithFile(b, 'bobs');
    expect((await attach(b, 'bobs', 'acme')).statusCode).toBe(404);
  });
});

describe('attaching a glossary to a project', () => {
  it('attaches after the others, moves the write target, shows slugs not paths, and logs each change under the session', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    await projectWithFile(token);
    await createGlossaryNamed(token, 'base');
    await createGlossaryNamed(token, 'acme');

    const first = await attach(token, 'ms', 'base');
    expect(first.statusCode, first.body).toBe(201);
    const second = await attach(token, 'ms', 'acme', true);
    const refs = (
      second.json() as {
        refs: { id: number; glossary: string; priority: number; writeTarget: boolean }[];
      }
    ).refs;
    expect(refs.map((r) => [r.glossary, r.priority, r.writeTarget])).toEqual([
      ['base', 1, false],
      ['acme', 2, true],
    ]);
    expect(second.body).not.toContain(alice.storageRoot);

    const moved = await app.inject({
      method: 'POST',
      url: `/api/projects/ms/glossaries/${refs[0]!.id}/write-target`,
      headers: auth(token),
    });
    expect(
      (moved.json() as { refs: { glossary: string; writeTarget: boolean }[] }).refs.map(
        (r) => [r.glossary, r.writeTarget],
      ),
    ).toEqual([
      ['base', true],
      ['acme', false],
    ]);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/projects/ms/glossaries',
      headers: auth(token),
    });
    expect((listed.json() as { refs: unknown[] }).refs).toHaveLength(2);

    const db = openProjectDb(
      join(config.storageRoot, alice.storageRoot, 'projects', 'ms.catdb'),
    );
    const events = listEvents(db, { subjectType: 'project' }).filter(
      (e) =>
        e.action === 'project.setting_changed' &&
        (JSON.parse(e.detail!) as { key: string }).key === 'glossary_refs',
    );
    db.close();
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.actor === 'account:' + alice.id)).toBe(true);
  });

  it('refuses a glossary that does not exist, one already attached, and a bad body', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    await projectWithFile(token);
    await createGlossaryNamed(token, 'acme');
    expect((await attach(token, 'ms', 'nope')).statusCode).toBe(404);
    expect((await attach(token, 'ms', 'acme')).statusCode).toBe(201);
    expect((await attach(token, 'ms', 'acme')).statusCode).toBe(409);
    expect((await attach(token, 'ms', '../x')).statusCode).toBe(400);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/projects/ms/glossaries',
      headers: auth(token),
      payload: { glossary: 'acme', writeTarget: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('a glossary session over one file', () => {
  it('detects repeated terms with no renderings, since Stage 2 is not run', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const fileId = await projectWithFile(token);
    const res = await startSession(token, 'ms', fileId);
    expect(res.statusCode, res.body).toBe(201);
    const { replaced, session } = res.json() as {
      replaced: boolean;
      session: SessionView;
    };
    expect(replaced).toBe(false);
    expect(session.status).toBe('open');
    expect(session.aligned).toBe(false);
    expect(session.langs).toEqual({ srcLang: 'en', tgtLang: 'de' });
    expect(session.flags.length).toBeGreaterThan(0);
    expect(session.counts.flagged).toBe(session.flags.length);
    for (const flag of session.flags) {
      expect(flag.state).toEqual({ state: 'flagged' });
      expect(flag.offered).toEqual([]);
      expect(flag.termId).toBeNull();
      expect(flag.occurrences).toBeGreaterThanOrEqual(3);
      expect(flag.ords.length).toBeGreaterThan(0);
    }
    // A second start replaces the first, and says so.
    const again = await startSession(token, 'ms', fileId);
    expect((again.json() as { replaced: boolean }).replaced).toBe(true);
    // The held session is readable.
    const got = await app.inject({
      method: 'GET',
      url: sessionUrl('ms', fileId),
      headers: auth(token),
    });
    expect((got.json() as { session: SessionView }).session.flags).toHaveLength(
      session.flags.length,
    );
  });

  it('chooses, skips, takes a decision back, and refuses what the session refuses', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const fileId = await projectWithFile(token);
    const { session } = (await startSession(token, 'ms', fileId)).json() as {
      session: SessionView;
    };
    const [a, b] = session.flags;

    const chosen = await act(token, 'ms', fileId, 'choose', {
      key: a!.key,
      rendering: 'Erstes',
    });
    const after = (chosen.json() as { session: SessionView }).session;
    expect(after.flags[0]!.state).toEqual({
      state: 'decided',
      rendering: 'Erstes',
      kind: 'custom',
    });
    expect(after.counts.decided).toBe(1);

    const skipped = (
      (await act(token, 'ms', fileId, 'skip', { key: b!.key })).json() as {
        session: SessionView;
      }
    ).session;
    expect(skipped.counts).toMatchObject({ decided: 1, skipped: 1 });

    const reopened = (
      (await act(token, 'ms', fileId, 'reopen', { key: a!.key })).json() as {
        session: SessionView;
      }
    ).session;
    expect(reopened.counts.decided).toBe(0);

    // An unknown flag, a missing field, an edit to an entry that does not exist.
    expect(
      (await act(token, 'ms', fileId, 'choose', { key: 'no such term', rendering: 'x' }))
        .statusCode,
    ).toBe(400);
    expect((await act(token, 'ms', fileId, 'choose', { key: a!.key })).statusCode).toBe(
      400,
    );
    expect(
      (
        await act(token, 'ms', fileId, 'propose', {
          key: a!.key,
          edit: 'override',
          rendering: 'x',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await act(token, 'ms', fileId, 'propose', {
          key: a!.key,
          edit: 'delete',
          rendering: 'x',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('refuses a commit with no write target and keeps every decision', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const fileId = await projectWithFile(token);
    const { session } = (await startSession(token, 'ms', fileId)).json() as {
      session: SessionView;
    };
    await act(token, 'ms', fileId, 'choose', {
      key: session.flags[0]!.key,
      rendering: 'x',
    });

    const commit = await app.inject({
      method: 'POST',
      url: `${sessionUrl('ms', fileId)}/commit`,
      headers: auth(token),
    });
    expect(commit.statusCode, commit.body).toBe(409);
    expect(commit.body).toContain('write target');
    const got = await app.inject({
      method: 'GET',
      url: sessionUrl('ms', fileId),
      headers: auth(token),
    });
    expect((got.json() as { session: SessionView }).session.counts.decided).toBe(1);

    // Attached but not the write target: still nowhere to write.
    await createGlossaryNamed(token, 'acme');
    await attach(token, 'ms', 'acme');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${sessionUrl('ms', fileId)}/commit`,
          headers: auth(token),
        })
      ).statusCode,
    ).toBe(409);
  });

  it('commits decided flags into the write target, and asks the skipped one again next time', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const fileId = await projectWithFile(token);
    await createGlossaryNamed(token, 'acme');
    await attach(token, 'ms', 'acme', true);

    const first = (await startSession(token, 'ms', fileId)).json() as {
      session: SessionView;
    };
    const [decided, skipped] = first.session.flags;
    await act(token, 'ms', fileId, 'choose', { key: decided!.key, rendering: 'Erstes' });
    await act(token, 'ms', fileId, 'skip', { key: skipped!.key });

    const commit = await app.inject({
      method: 'POST',
      url: `${sessionUrl('ms', fileId)}/commit`,
      headers: auth(token),
    });
    expect(commit.statusCode, commit.body).toBe(200);
    const done = commit.json() as { written: number; session: SessionView };
    expect(done.written).toBe(1);
    expect(done.session.status).toBe('committed');

    // The write is in the glossary, decided by the session's account.
    const glossary = openGlossary(
      join(config.storageRoot, alice.storageRoot, 'glossaries', 'acme.ctg'),
    );
    expect(countTerms(glossary)).toBe(1);
    const decisions = glossary.prepare('SELECT * FROM term_decision').all() as {
      chosen: string;
      decided_by: string;
      source_project: string;
    }[];
    glossary.close();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      chosen: 'erstes',
      decided_by: 'alice@example.com',
      source_project: 'ms',
    });

    // The session is closed and gone; the next one skips what is decided
    // and asks about the term nobody decided.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: sessionUrl('ms', fileId),
          headers: auth(token),
        })
      ).statusCode,
    ).toBe(404);
    const next = (await startSession(token, 'ms', fileId)).json() as {
      replaced: boolean;
      session: SessionView;
    };
    expect(next.replaced).toBe(false);
    const keys = next.session.flags.map((f) => f.key);
    expect(keys).not.toContain(decided!.key);
    expect(keys).toContain(skipped!.key);
  });

  it('discards a session, writing nothing', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const fileId = await projectWithFile(token);
    await createGlossaryNamed(token, 'acme');
    await attach(token, 'ms', 'acme', true);
    const { session } = (await startSession(token, 'ms', fileId)).json() as {
      session: SessionView;
    };
    await act(token, 'ms', fileId, 'choose', {
      key: session.flags[0]!.key,
      rendering: 'x',
    });

    const gone = await app.inject({
      method: 'DELETE',
      url: sessionUrl('ms', fileId),
      headers: auth(token),
    });
    expect((gone.json() as { session: SessionView }).session.status).toBe('discarded');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: sessionUrl('ms', fileId),
          headers: auth(token),
        })
      ).statusCode,
    ).toBe(404);
    const glossary = openGlossary(
      join(config.storageRoot, alice.storageRoot, 'glossaries', 'acme.ctg'),
    );
    expect(countTerms(glossary)).toBe(0);
    glossary.close();
  });

  it("is one account's own: another's request finds no session, and no file", async () => {
    const a = await login('alice@example.com', 'alice-pw');
    const b = await login('bob@example.com', 'bob-pw');
    const fileId = await projectWithFile(a);
    await startSession(a, 'ms', fileId);
    await projectWithFile(b, 'ms');
    // Bob's project of the same name has its own file ids, and no session.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: sessionUrl('ms', fileId),
          headers: auth(b),
        })
      ).statusCode,
    ).toBe(404);
    expect((await startSession(b, 'ms', 9999)).statusCode).toBe(404);
    expect((await startSession(a, 'nope', fileId)).statusCode).toBe(404);
  });

  it('says plainly that a source language with no stopword list cannot be detected', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const fileId = await projectWithFile(token, 'ko', 'ko', 'en');
    const res = await startSession(token, 'ko', fileId);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('stopword');
  });
});

describe('glossary mismatches over one file (backlog #43c)', () => {
  const mismatchesUrl = (fileId: number) =>
    `/api/projects/ms/files/${fileId}/glossary/mismatches`;

  const segmentsOf = async (token: string, fileId: number): Promise<Segment[]> =>
    (
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/ms/files/${fileId}/segments`,
          headers: auth(token),
        })
      ).json() as { segments: Segment[] }
    ).segments;

  const setTarget = async (token: string, segment: Segment, text: string) => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/ms/segments/${segment.id}`,
      headers: auth(token),
      payload: {
        targetTokens: [{ t: 'text', v: text }],
        baseUpdatedAt: segment.updatedAt,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  /** A glossary where the fixture's repeated word "Palisuf" is "Gemeinde", never "Kirche". */
  function seedGlossary(): number {
    const g = openGlossary(
      join(config.storageRoot, alice.storageRoot, 'glossaries', 'acme.ctg'),
    );
    const term = insertTerm(g);
    addVariant(g, { termId: term.id, lang: 'en', text: 'Palisuf' });
    addVariant(g, { termId: term.id, lang: 'de', text: 'Gemeinde' });
    addVariant(g, { termId: term.id, lang: 'de', text: 'Kirche', forbidden: true });
    g.close();
    return term.id;
  }

  it('lists the segments that miss the preferred rendering or use a forbidden one, and no others', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const fileId = await projectWithFile(token);
    await createGlossaryNamed(token, 'acme');
    const termId = seedGlossary();
    await attach(token, 'ms', 'acme', true);

    const withTerm = (await segmentsOf(token, fileId)).filter((s) =>
      /palisuf/i.test(plainText(s.sourceTokens)),
    );
    expect(withTerm.length).toBeGreaterThanOrEqual(3);
    const [ok, forbidden, missing, untranslated] = withTerm as [
      Segment,
      Segment,
      Segment,
      Segment,
    ];
    await setTarget(token, ok, 'Unsere Gemeinde.');
    await setTarget(token, forbidden, 'Unsere Kirche.');
    await setTarget(token, missing, 'Unser Haus.');

    const res = await app.inject({
      method: 'GET',
      url: mismatchesUrl(fileId),
      headers: auth(token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { glossary: string; mismatches: GlossaryMismatch[] };
    expect(body.glossary).toBe('acme');
    expect(
      body.mismatches.map((m) => [m.segmentId, m.termId, m.kind, m.preferred, m.found]),
    ).toEqual([
      [forbidden.id, termId, 'forbidden', 'Gemeinde', 'Kirche'],
      [missing.id, termId, 'missing_preferred', 'Gemeinde', null],
    ]);
    expect(untranslated.targetTokens).toBeNull();
    expect(res.body).not.toContain(alice.storageRoot);
  });

  it('answers an empty list with no glossary when the project has no write target', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const fileId = await projectWithFile(token);
    await createGlossaryNamed(token, 'acme');
    seedGlossary();
    await attach(token, 'ms', 'acme', false);
    const res = await app.inject({
      method: 'GET',
      url: mismatchesUrl(fileId),
      headers: auth(token),
    });
    expect(res.json()).toEqual({ glossary: null, mismatches: [] });
  });

  it('is the account’s own: 404 for an unknown file, another account’s project, or no login', async () => {
    const a = await login('alice@example.com', 'alice-pw');
    const b = await login('bob@example.com', 'bob-pw');
    const fileId = await projectWithFile(a);
    expect(
      (await app.inject({ method: 'GET', url: mismatchesUrl(999), headers: auth(a) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: mismatchesUrl(fileId), headers: auth(b) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: mismatchesUrl(fileId) })).statusCode,
    ).toBe(401);
  });
});

// SQLite-heavy: a fixed 5 s starved out on the 2-fork Windows runner (#82), so the suite
// gets the slack the other heavy suites have.
describe(
  'recording an exception and accepting its proposal (backlog #110)',
  { timeout: 60_000 },
  () => {
    const base = '/api/projects/ms';
    const post = (token: string, url: string, payload: object) =>
      app.inject({ method: 'POST', url, headers: auth(token), payload });

    const segmentsOf = async (token: string, fileId: number): Promise<Segment[]> =>
      (
        (
          await app.inject({
            method: 'GET',
            url: `${base}/files/${fileId}/segments`,
            headers: auth(token),
          })
        ).json() as { segments: Segment[] }
      ).segments;

    const setTarget = async (token: string, segment: Segment, text: string) => {
      const res = await app.inject({
        method: 'PUT',
        url: `${base}/segments/${segment.id}`,
        headers: auth(token),
        payload: {
          targetTokens: [{ t: 'text', v: text }],
          baseUpdatedAt: segment.updatedAt,
        },
      });
      expect(res.statusCode, res.body).toBe(200);
    };

    /** "Palisuf" is "Gemeinde" (preferred), "Pfarrei" (acceptable) and never "Kirche". */
    function seed(): number {
      const g = openGlossary(
        join(config.storageRoot, alice.storageRoot, 'glossaries', 'acme.ctg'),
      );
      const term = insertTerm(g);
      addVariant(g, { termId: term.id, lang: 'en', text: 'Palisuf' });
      addVariant(g, { termId: term.id, lang: 'de', text: 'Gemeinde' });
      addVariant(g, { termId: term.id, lang: 'de', text: 'Pfarrei' });
      addVariant(g, { termId: term.id, lang: 'de', text: 'Kirche', forbidden: true });
      g.close();
      return term.id;
    }

    async function ready() {
      const token = await login('alice@example.com', 'alice-pw');
      const fileId = await projectWithFile(token);
      await createGlossaryNamed(token, 'acme');
      const termId = seed();
      await attach(token, 'ms', 'acme', true);
      const withTerm = (await segmentsOf(token, fileId)).filter((s) =>
        /palisuf/i.test(plainText(s.sourceTokens)),
      );
      expect(withTerm.length).toBeGreaterThanOrEqual(4);
      return { token, fileId, termId, withTerm };
    }

    const exceptions = (
      token: string,
      fileId: number,
      segmentId: number,
      termId: number,
    ) =>
      post(token, `${base}/files/${fileId}/glossary/exceptions`, { segmentId, termId });
    const proposals = async (token: string) =>
      (
        await app.inject({
          method: 'GET',
          url: `${base}/glossary/proposals`,
          headers: auth(token),
        })
      ).json() as {
        glossary: string | null;
        proposals: Array<{
          term: string;
          chosen: string;
          preferred: string;
          segments: number;
        }>;
      };

    it('records the alternative used, proposes it at three segments, and accepting it flips the entry', async () => {
      const { token, fileId, termId, withTerm } = await ready();
      for (const s of withTerm.slice(0, 3)) await setTarget(token, s, 'Unsere Pfarrei.');

      for (const s of withTerm.slice(0, 2)) {
        expect((await exceptions(token, fileId, s.id, termId)).statusCode).toBe(200);
      }
      expect((await proposals(token)).proposals).toEqual([]); // two is not a pattern yet
      expect((await exceptions(token, fileId, withTerm[2]!.id, termId)).statusCode).toBe(
        200,
      );

      const got = await proposals(token);
      expect(got.glossary).toBe('acme');
      expect(got.proposals).toEqual([
        {
          termId,
          lang: 'de',
          term: 'Palisuf',
          chosen: 'Pfarrei',
          preferred: 'Gemeinde',
          segments: 3,
        },
      ]);

      const accepted = await post(token, `${base}/glossary/proposals/accept`, {
        termId,
        lang: 'de',
        chosen: 'Pfarrei',
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect((await proposals(token)).proposals).toEqual([]);

      // the entry now prefers Pfarrei: "Unsere Gemeinde." is the one that departs
      await setTarget(token, withTerm[3]!, 'Unsere Gemeinde.');
      const list = (
        await app.inject({
          method: 'GET',
          url: `${base}/files/${fileId}/glossary/mismatches`,
          headers: auth(token),
        })
      ).json() as {
        mismatches: Array<{ segmentId: number; preferred: string; found: string | null }>;
      };
      expect(list.mismatches.map((m) => [m.segmentId, m.preferred, m.found])).toEqual([
        [withTerm[3]!.id, 'Pfarrei', 'Gemeinde'],
      ]);
    });

    it('refuses a row that is not an acceptable alternative: a forbidden one, one that matches, an unknown pair', async () => {
      const { token, fileId, termId, withTerm } = await ready();
      await setTarget(token, withTerm[0]!, 'Unsere Kirche.'); // forbidden
      await setTarget(token, withTerm[1]!, 'Unsere Gemeinde.'); // preferred: no mismatch
      expect((await exceptions(token, fileId, withTerm[0]!.id, termId)).statusCode).toBe(
        409,
      );
      expect((await exceptions(token, fileId, withTerm[1]!.id, termId)).statusCode).toBe(
        409,
      );
      expect((await exceptions(token, fileId, 999999, termId)).statusCode).toBe(409);
      expect((await exceptions(token, fileId, withTerm[0]!.id, 999999)).statusCode).toBe(
        409,
      );
      expect(
        (
          await post(token, `${base}/files/${fileId}/glossary/exceptions`, {
            segmentId: 'x',
          })
        ).statusCode,
      ).toBe(400);
      expect((await proposals(token)).proposals).toEqual([]);
    });

    it('refuses to accept what nothing proposes, and answers nothing without a write target', async () => {
      const { token, termId } = await ready();
      const stale = await post(token, `${base}/glossary/proposals/accept`, {
        termId,
        lang: 'de',
        chosen: 'Pfarrei',
      });
      expect(stale.statusCode).toBe(409);
      expect(
        (await post(token, `${base}/glossary/proposals/accept`, { termId })).statusCode,
      ).toBe(400);
    });

    it('answers nothing, and refuses to record, when the glossary is not the write target', async () => {
      const token = await login('alice@example.com', 'alice-pw');
      const fileId = await projectWithFile(token);
      await createGlossaryNamed(token, 'acme');
      const termId = seed();
      await attach(token, 'ms', 'acme', false);
      expect(await proposals(token)).toEqual({ glossary: null, proposals: [] });
      expect((await exceptions(token, fileId, 1, termId)).statusCode).toBe(409);
    });

    it('is the account’s own: another account’s project is a 404, and no login a 401', async () => {
      const { token, fileId, termId, withTerm } = await ready();
      const b = await login('bob@example.com', 'bob-pw');
      expect((await exceptions(b, fileId, withTerm[0]!.id, termId)).statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `${base}/glossary/proposals`,
            headers: auth(b),
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'GET', url: `${base}/glossary/proposals` }))
          .statusCode,
      ).toBe(401);
      void token;
    });
  },
);

describe('adding a term typed in the editor (backlog #129)', () => {
  const addTerm = (token: string, payload: unknown, project = 'ms') =>
    app.inject({
      method: 'POST',
      url: `/api/projects/${project}/glossary/terms`,
      headers: auth(token),
      payload: payload as object,
    });
  const glossaryFile = () =>
    openGlossary(join(config.storageRoot, alice.storageRoot, 'glossaries', 'acme.ctg'));

  async function ready() {
    const token = await login('alice@example.com', 'alice-pw');
    await projectWithFile(token);
    await createGlossaryNamed(token, 'acme');
    await attach(token, 'ms', 'acme', true);
    return token;
  }

  it('writes the term into the write target with the project’s pair, and adds to it the second time', async () => {
    const token = await ready();
    const first = await addTerm(token, { source: ' parish ', target: ' Gemeinde ' });
    expect(first.statusCode, first.body).toBe(201);
    const { termId, created } = first.json<{ termId: number; created: boolean }>();
    expect(created).toBe(true);

    const second = await addTerm(token, { source: 'PARISH', target: 'Pfarrei' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ termId, created: false });

    const g = glossaryFile();
    expect(
      listVariants(g, termId)
        .map((v) => `${v.lang}:${v.text}`)
        .sort(),
    ).toEqual(['de:Gemeinde', 'de:Pfarrei', 'en:parish']);
    const decisions = listDecisions(g, termId, 'de');
    expect(decisions.map((d) => [d.chosen, d.kind, d.sourceProject])).toEqual([
      ['gemeinde', 'custom', 'ms'],
      ['pfarrei', 'custom', 'ms'],
    ]);
    // Who: the session's account, as a label; never a field the client sent.
    expect(decisions[0]!.decidedBy).toBe('alice@example.com');
    g.close();
  });

  it('refuses text that is missing or blank as a 400, and a project with no glossary as a 409', async () => {
    const token = await ready();
    expect((await addTerm(token, {})).statusCode).toBe(400);
    expect((await addTerm(token, { source: 4, target: 'x' })).statusCode).toBe(400);
    expect((await addTerm(token, { source: 'parish', target: '  ' })).statusCode).toBe(
      400,
    );

    await projectWithFile(token, 'bare');
    const bare = await addTerm(token, { source: 'parish', target: 'Gemeinde' }, 'bare');
    expect(bare.statusCode).toBe(409);
    expect(bare.json()).toMatchObject({ error: expect.stringContaining('no glossary') });
    const g = glossaryFile();
    expect(countTerms(g)).toBe(0);
    g.close();
  });

  it('is the project owner’s: a stranger gets the answer a missing project gets', async () => {
    await ready();
    const bob = await login('bob@example.com', 'bob-pw');
    expect(
      (await addTerm(bob, { source: 'parish', target: 'Gemeinde' })).statusCode,
    ).toBe(404);
    const g = glossaryFile();
    expect(countTerms(g)).toBe(0);
    g.close();
  });
});
