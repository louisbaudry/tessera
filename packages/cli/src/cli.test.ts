/**
 * A full job through `runCli`, no process spawned, no UI in the loop —
 * backlog #25's "done when". Runs against a real fixture DOCX and a
 * hand-built TMX whose one unit matches one of that file's segments.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importDocx, plainText, readDocx, translatableSegments } from '@cat-tool/core';
import { listSegments, listTmRefs, openProjectDb, setSegmentTarget } from '@cat-tool/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli, USAGE } from './cli.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/docx');
const FIXTURE = join(FIXTURES, 'form-minimal.docx');

const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const partDigests = (bytes: Uint8Array): Map<string, string> =>
  new Map(readDocx(bytes).parts.map((p) => [p.name, digest(p.data)]));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(argv, { stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const tmx = (source: string, target: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
<header srclang="en" adminlang="en" o-tmf="TW4" datatype="plaintext" segtype="sentence"/>
<body>
<tu tuid="1"><tuv xml:lang="en"><seg>${source}</seg></tuv><tuv xml:lang="de"><seg>${target}</seg></tuv></tu>
</body>
</tmx>`;

/** The source text of a segment with no tags, the simplest thing a TMX can match. */
function plainSegment(projectPath: string) {
  const db = openProjectDb(projectPath);
  try {
    const found = listSegments(db, 1).find(
      (s) => !s.locked && s.sourceTokens.every((t) => t.t === 'text'),
    );
    if (!found) throw new Error('fixture has no plain segment');
    return { id: found.id, text: plainText(found.sourceTokens) };
  } finally {
    db.close();
  }
}

describe('cat-tool: a full job, headless', () => {
  it('init → add-file → add-tm → pretranslate → qa → export', () => {
    const project = join(dir, 'job', 'project.catdb');

    const init = run('init', project, '--src', 'en', '--tgt', 'de', '--name', 'Job');
    expect(init.code, init.err).toBe(0);
    expect(init.out).toContain('Created project "Job" (en → de)');
    expect(existsSync(project)).toBe(true);

    const added = run('add-file', project, FIXTURE);
    expect(added.code, added.err).toBe(0);
    expect(added.out).toMatch(
      /^Added form-minimal\.docx as file #1: \d+ segments \(\d+ locked\)$/,
    );

    // Nothing translated yet: the export is the original, part for part.
    const untouched = run('export', project, '--out', join(dir, 'untouched'));
    expect(untouched.code, untouched.err).toBe(0);
    expect(untouched.out).toMatch(
      /0\/\d+ paragraphs rebuilt, 0\/\d+ segments with a target/,
    );
    expect(
      partDigests(readFileSync(join(dir, 'untouched', 'form-minimal.docx'))),
    ).toEqual(partDigests(readFileSync(FIXTURE)));

    // A memory holding exactly one of the file's own sentences.
    const { text } = plainSegment(project);
    const target = `Uebersetzt ${text}`;
    const tmxPath = join(dir, 'client.tmx');
    writeFileSync(tmxPath, tmx(text, target));
    const imported = run('add-tm', project, tmxPath);
    expect(imported.code, imported.err).toBe(0);
    expect(imported.out).toContain(
      `Imported ${tmxPath} into ${join(dir, 'client.ctm')}: 1 units, 2 variants`,
    );
    expect(imported.out).toMatch(/Attached .*client\.ctm as TM #1 \(priority 1\)/);

    // A fresh memory to write confirmations into, consulted after the client's.
    const job = run('add-tm', project, join(dir, 'job.ctm'), '--write-target');
    expect(job.code, job.err).toBe(0);
    expect(job.out).toContain('Created empty memory');
    expect(job.out).toMatch(/TM #2 \(priority 2, write target\)/);

    const pre = run('pretranslate', project);
    expect(pre.code, pre.err).toBe(0);
    expect(pre.out).toMatch(
      /^Pre-translated: 1 exact, 0 tag-diff \(draft\), 0 propagated, \d+ unmatched, \d+ skipped/,
    );

    const qa = run('qa', project);
    const summary = /QA: (\d+) issues across (\d+) segments — .*; (\d+) blocking$/.exec(
      qa.out,
    );
    expect(summary, qa.out).not.toBeNull();
    expect(qa.code).toBe(Number(summary![3]) > 0 ? 1 : 0);

    const out = run('export', project, '--out', join(dir, 'out'));
    expect(out.code, out.err).toBe(0);
    expect(out.out).toMatch(/1\/\d+ paragraphs rebuilt, 1\/\d+ segments with a target/);
    const delivered = new Uint8Array(readFileSync(join(dir, 'out', 'form-minimal.docx')));
    const texts = translatableSegments(importDocx(delivered)).map((s) => s.text);
    expect(texts.some((t) => t.includes(target))).toBe(true);
    expect(texts.length).toBe(
      translatableSegments(importDocx(readFileSync(FIXTURE))).length,
    );
  });

  it('qa exits 1 while a blocking issue remains', () => {
    const project = join(dir, 'project.catdb');
    run('init', project, '--src', 'en', '--tgt', 'de');
    run('add-file', project, FIXTURE);

    // A target with none of the source's tags: tag.missing, an error.
    const db = openProjectDb(project);
    const tagged = listSegments(db, 1).find(
      (s) => !s.locked && s.formatTable.length > 0,
    )!;
    setSegmentTarget(db, tagged.id, {
      targetTokens: [{ t: 'text', v: 'ohne Tags' }],
      status: 'translated',
      origin: null,
    });
    db.close();

    const qa = run('qa', project);
    expect(qa.code).toBe(1);
    expect(qa.out).toContain(`#${tagged.id}\terror\ttag.missing`);

    const scoped = run('qa', project, '--file', '1');
    expect(scoped.code).toBe(1);
  });
});

describe('cat-tool: refusals', () => {
  it('prints usage with no command, and for an unknown one', () => {
    expect(run().code).toBe(1);
    expect(run().out).toBe(USAGE);
    expect(run('--help').code).toBe(0);
    const unknown = run('frobnicate');
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('unknown command "frobnicate"');
  });

  it('init refuses an existing file and requires the language pair', () => {
    const project = join(dir, 'project.catdb');
    expect(run('init', project, '--src', 'en').code).toBe(1);
    expect(run('init', project, '--src', 'en').err).toContain(
      '--src and --tgt are required',
    );
    expect(run('init', project, '--src', 'en', '--tgt', 'de').code).toBe(0);
    const again = run('init', project, '--src', 'en', '--tgt', 'de');
    expect(again.code).toBe(1);
    expect(again.err).toContain('already exists');
  });

  it('every other command wants a project that init made', () => {
    const missing = join(dir, 'nope.catdb');
    for (const command of ['add-file', 'add-tm', 'pretranslate', 'qa', 'export']) {
      const result = run(command, missing, 'x');
      expect(result.code, command).toBe(1);
      expect(result.err, command).toContain('run "cat-tool init" first');
    }
  });

  it('add-file refuses a missing document and a duplicate rel_path', () => {
    const project = join(dir, 'project.catdb');
    run('init', project, '--src', 'en', '--tgt', 'de');
    expect(run('add-file', project, join(dir, 'nope.docx')).err).toContain(
      'no such file',
    );
    expect(run('add-file', project, FIXTURE).code).toBe(0);
    const twice = run('add-file', project, FIXTURE);
    expect(twice.code).toBe(1);
    expect(twice.err).toContain('already in this project');
    expect(run('add-file', project, FIXTURE, '--rel-path', 'copy.docx').code).toBe(0);
  });

  it('add-file refuses a source language without segmentation rules', () => {
    const project = join(dir, 'project.catdb');
    run('init', project, '--src', 'ja', '--tgt', 'en');
    const result = run('add-file', project, FIXTURE);
    expect(result.code).toBe(1);
    expect(result.err).toContain('cannot segment ja');
  });

  it('add-tm refuses an unknown format, a missing file, and an import over an existing .ctm', () => {
    const project = join(dir, 'project.catdb');
    run('init', project, '--src', 'en', '--tgt', 'de');
    expect(run('add-tm', project, join(dir, 'memory.xlsx')).err).toContain(
      'unsupported memory format',
    );
    expect(run('add-tm', project, join(dir, 'nope.tmx')).err).toContain('no such file');

    writeFileSync(join(dir, 'client.tmx'), tmx('a', 'b'));
    expect(run('add-tm', project, join(dir, 'client.tmx')).code).toBe(0);
    const again = run('add-tm', project, join(dir, 'client.tmx'));
    expect(again.code).toBe(1);
    expect(again.err).toContain('already exists');

    // Attaching the produced .ctm directly is fine, and priorities keep counting.
    expect(run('add-tm', project, join(dir, 'client.ctm'), '--priority', '7').code).toBe(
      0,
    );
    const db = openProjectDb(project);
    expect(listTmRefs(db).map((r) => r.priority)).toEqual([1, 7]);
    db.close();

    expect(
      run('add-tm', project, join(dir, 'x.ctm'), '--priority', 'seven').err,
    ).toContain('non-negative integer');
  });

  it('a failed import leaves no half-made memory behind', () => {
    const project = join(dir, 'project.catdb');
    run('init', project, '--src', 'en', '--tgt', 'de');
    writeFileSync(join(dir, 'broken.tmx'), '<tmx version="1.4"><body><tu>');
    expect(run('add-tm', project, join(dir, 'broken.tmx')).code).toBe(1);
    expect(existsSync(join(dir, 'broken.ctm'))).toBe(false);
  });

  it('--file must name a file the project has; export needs one', () => {
    const project = join(dir, 'project.catdb');
    run('init', project, '--src', 'en', '--tgt', 'de');
    expect(run('export', project).err).toContain('no files to export');
    run('add-file', project, FIXTURE);
    for (const command of ['pretranslate', 'qa', 'export']) {
      expect(run(command, project, '--file', '9').err, command).toContain('no file #9');
    }
    expect(run('export', project, '--file', '1', '--out', join(dir, 'one')).code).toBe(0);
    expect(existsSync(join(dir, 'one', 'form-minimal.docx'))).toBe(true);
  });

  it('rejects an option it does not know', () => {
    const result = run(
      'init',
      join(dir, 'p.catdb'),
      '--src',
      'en',
      '--tgt',
      'de',
      '--bogus',
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain('--bogus');
  });
});
