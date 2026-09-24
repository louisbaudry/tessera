/**
 * 🏁 THE GOLDEN END-TO-END TEST — backlog #26.
 *
 * One real job, start to finish, with a memory in the loop and a
 * translator's edits applied: a real client document (`prose-short.docx`
 * from the fixture corpus) and a Trados-shaped TMX whose units are that
 * document's own sentences translated into German
 * (`fixtures/golden/prose-short.en-de.tmx`) go through every CLI command
 * in the order a script would run them, the two things pre-translate
 * leaves for a human are done through the repository, and everything the
 * job prints — plus the text of the delivered document — is compared
 * against `fixtures/golden/prose-short.en-de.expected.txt`, byte for
 * byte.
 *
 * The roundtrip gate (`roundtrip.gate.test.ts`) proves a *zero-edit*
 * export is byte-identical. This proves the rest: that a memory's tags
 * land on today's document's formatting, that a paragraph half translated
 * folds back together, that the QA chain blocks on a dropped tag and
 * stops blocking once it is fixed, that a dismissal survives the rule
 * firing again, and that the parts the job never touched come back
 * untouched. It is deliberately a golden file rather than a list of
 * `expect`s: any change to what the pipeline says or delivers shows up
 * as a diff to read and approve, not as a test somebody forgot to write.
 *
 * Regenerate with `UPDATE_GOLDEN=1 pnpm test:golden`, then review the
 * diff of the expected file before committing it — the diff *is* the
 * review.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatActor,
  importDocx,
  plainText,
  readDocx,
  translatableSegments,
} from '@cat-tool/core';
import type { AuditActor, Token } from '@cat-tool/core';
import {
  confirmSegment,
  dismissQaIssue,
  listAllSegments,
  listQaIssues,
  openProjectDb,
  openTm,
  setSegmentTarget,
} from '@cat-tool/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';
import { cliActor } from './support.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCX = join(ROOT, 'fixtures/docx/prose-short.docx');
const TMX = join(ROOT, 'fixtures/golden/prose-short.en-de.tmx');
const EXPECTED = join(ROOT, 'fixtures/golden/prose-short.en-de.expected.txt');

/** The translator whose review the job simulates, through the repository. */
const REVIEWER: AuditActor = { actor: { kind: 'cli', name: 'golden' }, label: 'golden' };

const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const partDigests = (bytes: Uint8Array): Map<string, string> =>
  new Map(readDocx(bytes).parts.map((p) => [p.name, digest(p.data)]));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-golden-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/**
 * Everything the job prints, in order, with the temp directory it ran in
 * written as `<job>`, the repository as `<repo>`, audit timestamps as
 * `<at>`, TM unit uuids as `<uuid>`, the CLI's own actor as `cli:<user>` and path separators as
 * `/`, so the transcript is the same on every machine and every OS.
 */
class Transcript {
  private readonly lines: string[] = [];

  constructor(private readonly jobDir: string) {}

  section(title: string): void {
    if (this.lines.length > 0) this.lines.push('');
    this.lines.push(`## ${title}`);
  }

  run(...argv: string[]): number {
    this.section(`$ cat-tool ${argv.map((a) => this.scrub(a)).join(' ')}`);
    const code = runCli(argv, {
      stdout: (line) => this.lines.push(this.scrub(line)),
      stderr: (line) => this.lines.push(`stderr: ${this.scrub(line)}`),
    });
    this.lines.push(`exit ${code}`);
    return code;
  }

  note(line: string): void {
    this.lines.push(line);
  }

  text(): string {
    return `${this.lines.join('\n')}\n`;
  }

  private scrub(line: string): string {
    return line
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<at>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
      .split(`${formatActor(cliActor().actor)}\t`)
      .join('cli:<user>\t')
      .split(this.jobDir)
      .join('<job>')
      .split(ROOT)
      .join('<repo>')
      .replaceAll('\\', '/');
  }
}

describe('🏁 golden end-to-end', () => {
  it('prose-short.docx × prose-short.en-de.tmx: pre-translate, review, export', () => {
    const t = new Transcript(dir);
    const project = join(dir, 'job.catdb');
    const memory = join(dir, 'memory.tmx');
    // Imported beside a sibling `.ctm`, so the TMX is copied out of the
    // fixture tree first; nothing here may write into `fixtures/`.
    copyFileSync(TMX, memory);

    expect(t.run('init', project, '--src', 'en', '--tgt', 'de', '--name', 'Golden')).toBe(
      0,
    );
    expect(t.run('add-file', project, DOCX)).toBe(0);
    expect(t.run('add-tm', project, memory)).toBe(0);
    expect(t.run('add-tm', project, join(dir, 'job.ctm'), '--write-target')).toBe(0);
    expect(t.run('pretranslate', project)).toBe(0);

    // The QA chain stops here: a memory unit whose tags carried no kind
    // hint was placed as text only, and `tag.missing` blocks on it.
    expect(t.run('qa', project)).toBe(1);

    // What a translator does with that report, through the repository —
    // there is no CLI for either on purpose (v1-spec.md §2.4).
    t.section('review');
    let reviewed: number;
    const db = openProjectDb(project);
    try {
      // 1. Reapply the dropped tag on the tag-diff draft and confirm it,
      //    which writes it into the job's memory.
      const draft = listAllSegments(db).find((s) => s.origin === 'tm_exact_tagdiff');
      expect(draft, 'pre-translate produced a tag-diff draft').toBeDefined();
      const first = draft!.sourceTokens[0]!;
      const last = draft!.sourceTokens.at(-1)!;
      expect(first.t).toBe('open');
      expect(last.t).toBe('close');
      const repaired: Token[] = [
        first,
        { t: 'text', v: plainText(draft!.targetTokens!) },
        last,
      ];
      setSegmentTarget(db, draft!.id, {
        targetTokens: repaired,
        status: 'translated',
        origin: 'tm_exact_tagdiff',
        actor: REVIEWER,
      });
      confirmSegment(db, draft!.id, { actor: REVIEWER });
      reviewed = draft!.id;
      t.note(`confirmed #${draft!.id} with its tag reapplied`);

      // 2. Dismiss the one false positive: a `(… 14:2)` citation rendered
      //    the German way, `(… 14,2)`, reads to `num.missing`
      //    as one decimal number where two were expected.
      const citation = listQaIssues(db).filter((i) => i.rule === 'num.missing');
      expect(citation).toHaveLength(1);
      dismissQaIssue(db, citation[0]!.id);
      t.note(`dismissed #${citation[0]!.segmentId} num.missing`);
    } finally {
      db.close();
    }

    // The confirmation reached the write target.
    const job = openTm(join(dir, 'job.ctm'));
    try {
      const { units } = job.prepare('SELECT count(*) AS units FROM tu').get() as {
        units: number;
      };
      expect(units).toBe(1);
      t.note(`job.ctm holds ${units} unit`);
    } finally {
      job.close();
    }

    // Blocking issue fixed, false positive dismissed and still dismissed
    // after the rule fires again: the job may ship.
    expect(t.run('qa', project)).toBe(0);
    expect(t.run('export', project, '--out', join(dir, 'out'))).toBe(0);

    // Who did what to the segment a human had to fix, and the chain
    // over everything the job recorded (audit-spec.md §7).
    expect(t.run('history', project, String(reviewed))).toBe(0);
    expect(t.run('audit-verify', project)).toBe(0);

    // The delivered document, as its reader sees it.
    const delivered = new Uint8Array(readFileSync(join(dir, 'out', 'prose-short.docx')));
    t.section('delivered');
    for (const segment of translatableSegments(importDocx(delivered))) {
      t.note(`${segment.part}\t${JSON.stringify(segment.text)}`);
    }

    // Every part the job did not translate is the original, byte for
    // byte; the body is not.
    const before = partDigests(new Uint8Array(readFileSync(DOCX)));
    const after = partDigests(delivered);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [part, hash] of before) {
      if (part === 'word/document.xml') expect(after.get(part)).not.toBe(hash);
      else expect(after.get(part), part).toBe(hash);
    }

    const transcript = t.text();
    if (process.env['UPDATE_GOLDEN']) {
      writeFileSync(EXPECTED, transcript);
    }
    expect(
      existsSync(EXPECTED),
      `${EXPECTED} — run with UPDATE_GOLDEN=1 to create it`,
    ).toBe(true);
    const expected = readFileSync(EXPECTED, 'utf8').replaceAll('\r\n', '\n');
    expect(transcript).toBe(expected);
  });
});
