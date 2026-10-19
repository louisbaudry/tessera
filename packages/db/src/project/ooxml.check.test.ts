/**
 * Differential OOXML validation of exports (issue #265, `planning/v1-spec.md`
 * §3.7).
 *
 * The roundtrip gate proves a zero-edit export is byte-identical. It cannot
 * speak for a *translated* document, where `renderTokens` rewrites every
 * paragraph that has a target: that output was only ever checked by eye or
 * by a one-off XSD run. This test translates every fixture segment by segment,
 * exports it through the repository, and asks the Open XML SDK validator
 * (`scripts/ooxml-validate`, MIT, a dev tool that ships nowhere:
 * `planning/prior-art.md`) what it finds in the original and in the export.
 * The export may add nothing the original did not already have.
 *
 * Differential on purpose. Some fixtures are invalid *in their original form*
 * and are kept that way (`fixtures/docx/README.md`), so an absolute "no
 * findings" bar would fail on files the gate requires us to preserve.
 *
 * Needs the .NET SDK, so it is its own script and CI job
 * (`pnpm test:ooxml`) and is excluded from `pnpm test`, like the gate.
 * A missing `dotnet` fails the run loudly: a skipped check reports green.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  readDocx,
  rulesFor,
  withoutHiddenTags,
  writeDocx,
  type Token,
} from '@cat-tool/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportFile } from './export.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { listSegments, setSegmentTarget } from './segments.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '../../../../fixtures/docx');
const TOOL = join(HERE, '../../../../scripts/ooxml-validate');
const fixtureNames = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.docx'))
  .sort();

/** One validator finding, as `scripts/ooxml-validate/Program.cs` prints it. */
interface Finding {
  readonly id: string;
  readonly type: string;
  readonly part: string;
  readonly path: string;
  readonly description: string;
}

let work: string;
let toolDll: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'cat-ooxml-'));
  const out = join(work, 'tool');
  try {
    execFileSync(
      'dotnet',
      ['build', TOOL, '-c', 'Release', '-o', out, '--nologo', '-v', 'q'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 280_000,
      },
    );
  } catch (error) {
    throw new Error(
      'the OOXML validator could not be built: this test needs the .NET 8 SDK on PATH ' +
        `and NuGet reachable (${(error as Error).message.split('\n')[0]})`,
    );
  }
  toolDll = join(out, 'ooxml-validate.dll');
}, 300_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** Validates every file in one process start; keyed by the path given. */
function validate(paths: readonly string[]): Map<string, Finding[]> {
  const stdout = execFileSync('dotnet', [toolDll, ...paths], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 280_000,
  });
  const parsed = JSON.parse(stdout) as Record<string, Finding[]>;
  return new Map(Object.entries(parsed));
}

/**
 * What identifies a finding across the original and the export. The XPath is
 * left out: a rewritten paragraph can shift the position of a finding that is
 * otherwise the same one.
 */
const keyOf = (f: Finding): string => `${f.id}|${f.part}|${f.description}`;

/** Findings in `after` beyond the count the same key has in `before`. */
function added(before: readonly Finding[], after: readonly Finding[]): Finding[] {
  const remaining = new Map<string, number>();
  for (const f of before) remaining.set(keyOf(f), (remaining.get(keyOf(f)) ?? 0) + 1);
  const extra: Finding[] = [];
  for (const f of after) {
    const left = remaining.get(keyOf(f)) ?? 0;
    if (left > 0) remaining.set(keyOf(f), left - 1);
    else extra.push(f);
  }
  return extra;
}

/**
 * Every translatable segment gets a target built from its own visible tokens
 * with the text changed (a non-ASCII letter, and `&<` so escaping is on the
 * path), so each paragraph with a segment is re-rendered from tokens.
 */
function translateAndExport(name: string, bytes: Uint8Array) {
  const db = openProjectDb(join(work, `${name}.catdb`));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'fr' });
  const file = insertFile(db, name, assembleFile(bytes, rulesFor('en')), {
    actor: TEST_ACTOR,
  });
  let translated = 0;
  db.transaction(() => {
    for (const s of listSegments(db, file.id)) {
      if (s.locked) continue;
      const visible = withoutHiddenTags(s.sourceTokens, s.formatTable);
      const target: Token[] = visible.map((t) =>
        t.t === 'text' ? { t: 'text', v: `é${t.v}&<` } : t,
      );
      setSegmentTarget(db, s.id, {
        actor: TEST_ACTOR,
        targetTokens: target,
        status: 'translated',
        origin: 'tm_exact',
      });
      translated += 1;
    }
  })();
  const exported = exportFile(db, file.id, { actor: TEST_ACTOR });
  db.close();
  return { exported, translated };
}

describe('differential OOXML validation of translated exports', () => {
  it('adds no validator finding the original did not already have, on every fixture', () => {
    const originals: string[] = [];
    const exports: string[] = [];
    const rendered: Record<string, number> = {};
    for (const name of fixtureNames) {
      const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)));
      const { exported, translated } = translateAndExport(name, bytes);
      expect(translated, `${name} has translatable segments`).toBeGreaterThan(0);
      expect(
        exported.summary.paragraphsRendered,
        `${name}: the export re-rendered paragraphs, so the test exercises the renderer`,
      ).toBeGreaterThan(0);
      rendered[name] = exported.summary.paragraphsRendered;
      const original = join(work, `orig-${name}`);
      const exportPath = join(work, `out-${name}`);
      writeFileSync(original, bytes);
      writeFileSync(exportPath, exported.bytes);
      originals.push(original);
      exports.push(exportPath);
    }

    const found = validate([...originals, ...exports]);
    const report: string[] = [];
    fixtureNames.forEach((name, i) => {
      const before = found.get(originals[i]!) ?? [];
      const after = found.get(exports[i]!) ?? [];
      for (const f of added(before, after)) {
        report.push(`${name}: ${f.id} in ${f.part} at ${f.path}: ${f.description}`);
      }
    });
    // A broken renderer adds a finding per paragraph; the first few say it.
    const shown = [
      ...report.slice(0, 15),
      ...(report.length > 15 ? [`... and ${report.length - 15} more`] : []),
    ];
    expect(report, shown.join('\n')).toEqual([]);
  }, 280_000);

  it('does report a finding for a document that is invalid, so a pass means something', () => {
    // Break a copy on purpose: an element the schema does not allow where a
    // paragraph is expected. If the validator stopped looking, this would pass
    // with no finding and the differential check above would be vacuous.
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'form-minimal.docx')));
    const pkg = readDocx(bytes);
    const main = pkg.parts.find((p) => p.name === 'word/document.xml')!;
    const xml = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(
      main.data,
    );
    const broken = xml.replace(/<w:p[ >]/, (m) => `<w:bogusElement/>${m}`);
    expect(broken).not.toBe(xml);
    const patched = {
      ...pkg,
      parts: pkg.parts.map((p) =>
        p.name === 'word/document.xml'
          ? { ...p, data: new TextEncoder().encode(broken) }
          : p,
      ),
    };
    const clean = join(work, 'self-clean.docx');
    const bad = join(work, 'self-bad.docx');
    writeFileSync(clean, bytes);
    writeFileSync(bad, writeDocx(patched));
    const found = validate([clean, bad]);
    expect(found.get(clean)).toEqual([]);
    expect(added(found.get(clean)!, found.get(bad)!).length).toBeGreaterThan(0);
  }, 120_000);
});
