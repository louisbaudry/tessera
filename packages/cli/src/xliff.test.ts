/**
 * XLIFF 2.x through `runCli` (`v1-spec.md` §3.8; issue #169): add-file reads
 * the file as it is segmented, and export hands back the original, byte for
 * byte, when nothing was translated.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/xliff');
const BASIC = join(FIXTURES, 'basic.en-de.xlf');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-cli-xliff-'));
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

describe('cat-tool: XLIFF', () => {
  it('add-file reads an .xlf, and export writes the original back', () => {
    const project = join(dir, 'project.catdb');
    expect(run('init', project, '--src', 'en', '--tgt', 'de').code).toBe(0);
    const added = run('add-file', project, BASIC);
    expect(added.err).toBe('');
    expect(added.out).toContain(
      'Added basic.en-de.xlf as file #1: 10 segments (1 locked)',
    );

    const out = join(dir, 'out');
    const exported = run('export', project, '--out', out);
    expect(exported.code).toBe(0);
    expect(exported.out).toContain('0 targets written, 0/10 segments with a target');
    const written = join(out, 'basic.en-de.xlf');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written).equals(readFileSync(BASIC))).toBe(true);
  });

  it('imports a source language that has no segmentation rules, which a DOCX cannot', () => {
    const file = join(dir, 'ja.xlf');
    writeFileSync(
      file,
      `<?xml version="1.0"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.1" srcLang="ja" trgLang="en">
  <file id="f"><unit id="1"><segment><source>こんにちは。</source></segment></unit></file>
</xliff>`,
    );
    const project = join(dir, 'ja.catdb');
    run('init', project, '--src', 'ja', '--tgt', 'en');
    const result = run('add-file', project, file);
    expect(result.err).toBe('');
    expect(result.out).toContain('1 segments (0 locked)');
  });

  it('refuses XLIFF 1.2 and a file for another language pair, by name', () => {
    const project = join(dir, 'project.catdb');
    run('init', project, '--src', 'en', '--tgt', 'de');
    const old = run('add-file', project, join(FIXTURES, 'xliff-12.en-de.xlf'));
    expect(old.code).toBe(1);
    expect(old.err).toContain('XLIFF 1.2 is not supported');

    const other = join(dir, 'other.catdb');
    run('init', other, '--src', 'en', '--tgt', 'fr');
    const wrong = run('add-file', other, BASIC);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("target language is de, the project's is fr");
  });
});
