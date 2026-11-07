/**
 * `pnpm bench:project` — what a project of N segments costs (issue #180,
 * `v1-spec.md` §7.1a). Kept out of `pnpm test` and the build, like
 * `pnpm bench:tm`: it generates synthetic files of 10,000 to 150,000 segments
 * in the OS temp directory and deletes them. Its numbers are synthetic (short,
 * mostly distinct English sentences, 5% repeats of 50 of them, half translated),
 * so they say how the code scales, never how long a client's real job takes.
 *
 * Two layers per size, each timed once:
 *   - the repository: import, list, edit with its QA rerun, a full QA sweep,
 *     export;
 *   - the API (`--http`, Fastify `inject`, no browser): upload, the segment
 *     list the grid loads, one edit, the QA list, the download.
 * The browser itself (memory and rendering of the grid) is not measured here.
 *
 * Usage (after `pnpm build`, which the script of the same name in package.json runs):
 *   node scripts/bench-project.mjs [--sizes 10000,100000] [--format xliff|docx] [--http]
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(join(ROOT, 'packages/core/dist/index.js'));
const dbm = await import(join(ROOT, 'packages/db/dist/index.js'));

const { values } = parseArgs({
  options: {
    sizes: { type: 'string', default: '10000,100000' },
    format: { type: 'string', default: 'xliff' },
    http: { type: 'boolean', default: false },
  },
});
const SIZES = values.sizes.split(',').map(Number);
const FORMAT = values.format;
if (!['xliff', 'docx'].includes(FORMAT) || SIZES.some((n) => !(n > 0))) {
  console.error(
    'usage: bench-project.mjs [--sizes 10000,100000] [--format xliff|docx] [--http]',
  );
  process.exit(2);
}
const ACTOR = { actor: { kind: 'system', name: 'bench' }, label: null };

/** The sentence of unit `i`: distinct, except that every 20th repeats one of 50. */
const sentence = (i) => {
  const k = i % 20 === 0 ? (i / 20) % 50 : i;
  return `Sentence ${k} about the quarterly report and its number ${k * 7} figures.`;
};

function xliffBytes(n) {
  const units = Array.from(
    { length: n },
    (_, i) =>
      `<unit id="u${i}"><segment><source>${sentence(i)}</source></segment></unit>`,
  );
  return new TextEncoder().encode(
    `<?xml version="1.0"?>\n<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" trgLang="de"><file id="f">${units.join('\n')}</file></xliff>`,
  );
}

function docxBytes(n) {
  const pkg = core.readDocx(
    new Uint8Array(readFileSync(join(ROOT, 'fixtures/docx/form-minimal.docx'))),
  );
  const part = pkg.parts.find((p) => p.name === 'word/document.xml');
  const xml = new TextDecoder().decode(part.data);
  const paragraphs = Array.from(
    { length: n },
    (_, i) => `<w:p><w:r><w:t>${sentence(i)}</w:t></w:r></w:p>`,
  ).join('');
  const start = xml.indexOf('<w:body>') + '<w:body>'.length;
  const end =
    xml.lastIndexOf('<w:sectPr') >= 0
      ? xml.lastIndexOf('<w:sectPr')
      : xml.indexOf('</w:body>');
  part.data = new TextEncoder().encode(xml.slice(0, start) + paragraphs + xml.slice(end));
  return core.writeDocx(pkg);
}

const bytesFor = (n) => (FORMAT === 'docx' ? docxBytes(n) : xliffBytes(n));
const fileName = FORMAT === 'docx' ? 'big.docx' : 'big.xlf';

/** Runs `fn`, stores its wall time in ms under `label`, returns its result. */
async function timed(out, label, fn) {
  const started = performance.now();
  const result = await fn();
  out[label] = Math.round(performance.now() - started);
  return result;
}

async function repository(n) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-project-'));
  const out = { layer: 'repository', format: FORMAT, segments: n };
  try {
    const db = dbm.openProjectDb(join(dir, 'p.catdb'));
    dbm.createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'de' });
    const bytes = bytesFor(n);
    const assembled = await timed(out, 'assembleMs', () =>
      FORMAT === 'docx'
        ? core.assembleFile(bytes, core.rulesFor('en'))
        : core.assembleXliff(bytes, { srcLang: 'en', tgtLang: 'de' }),
    );
    const file = await timed(out, 'insertFileMs', () =>
      dbm.insertFile(db, fileName, assembled, { actor: ACTOR }),
    );
    const segments = await timed(out, 'listSegmentsMs', () =>
      dbm.listSegments(db, file.id),
    );
    const json = JSON.stringify({ segments });
    out.segmentsJsonMB = +(Buffer.byteLength(json) / 1e6).toFixed(1);
    const parseStart = performance.now();
    JSON.parse(json);
    out.segmentsJsonParseMs = Math.round(performance.now() - parseStart);
    db.transaction(() => {
      segments.forEach((s, i) => {
        if (i % 2 !== 0) return;
        dbm.setSegmentTarget(db, s.id, {
          actor: ACTOR,
          targetTokens: [{ t: 'text', v: `Satz ${i} zum Quartalsbericht.` }],
          status: 'translated',
          origin: null,
        });
      });
    })();
    const middle = segments[Math.floor(n / 2) + 1];
    await timed(out, 'editOneWithQaMs', () =>
      dbm.editSegmentTarget(db, middle.id, {
        actor: ACTOR,
        tokens: [{ t: 'text', v: 'Ein neuer Satz.' }],
      }),
    );
    await timed(out, 'qaSweepMs', () =>
      dbm.runQaRulesFor(
        db,
        segments.map((s) => s.id),
      ),
    );
    await timed(out, 'exportMs', () => dbm.exportFile(db, file.id, { actor: ACTOR }));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

async function api(n) {
  const { buildApp } = await import(join(ROOT, 'packages/server/dist/app.js'));
  const dir = mkdtempSync(join(tmpdir(), 'bench-project-api-'));
  const config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  const platform = dbm.openPlatformDb(config.dbPath);
  dbm.createAccount(platform, {
    email: 'bench@example.com',
    passwordHash: core.hashPassword('bench-password'),
    actor: ACTOR,
  });
  platform.close();
  const app = await buildApp({ config, logger: false });
  const out = { layer: 'api', format: FORMAT, segments: n };
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'bench@example.com', password: 'bench-password' },
    });
    const headers = { authorization: `Bearer ${login.json().token}` };
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'job', srcLang: 'en', tgtLang: 'de' },
    });
    const bytes = bytesFor(n);
    out.uploadMB = +(bytes.length / 1e6).toFixed(1);
    const form = new FormData();
    form.append('file', new Blob([bytes]), fileName);
    const up = await timed(out, 'uploadMs', () =>
      app.inject({
        method: 'POST',
        url: '/api/projects/job/files',
        headers,
        payload: form,
      }),
    );
    if (up.statusCode !== 201) {
      out.error = `upload answered ${up.statusCode}: ${up.body.slice(0, 160)}`;
      return out;
    }
    const list = await timed(out, 'segmentListMs', () =>
      app.inject({ method: 'GET', url: '/api/projects/job/files/1/segments', headers }),
    );
    out.segmentListMB = +(list.rawPayload.length / 1e6).toFixed(1);
    const segment = list.json().segments[Math.floor(n / 2)];
    await timed(out, 'putOneMs', () =>
      app.inject({
        method: 'PUT',
        url: `/api/projects/job/segments/${segment.id}`,
        headers,
        payload: {
          targetTokens: [{ t: 'text', v: 'Ein Satz.' }],
          baseUpdatedAt: segment.updatedAt,
        },
      }),
    );
    await timed(out, 'qaListMs', () =>
      app.inject({ method: 'GET', url: '/api/projects/job/files/1/qa-issues', headers }),
    );
    const download = await timed(out, 'downloadMs', () =>
      app.inject({ method: 'GET', url: '/api/projects/job/files/1/export', headers }),
    );
    out.downloadStatus = download.statusCode;
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

for (const n of SIZES) {
  console.log(JSON.stringify(await repository(n)));
  if (values.http) console.log(JSON.stringify(await api(n)));
}
