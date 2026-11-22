/**
 * An XLSX through `runCli` (`v1-spec.md` §3.10; issue #169): add-file reads the
 * workbook, and export hands back every part unchanged when nothing was
 * translated.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPart, readXlsx } from '@cat-tool/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/xlsx');
const BOOK = join(FIXTURES, 'edge-cases.en.xlsx');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-cli-xlsx-'));
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

describe('cat-tool: XLSX', () => {
  it('add-file reads a .xlsx and export writes every part back', () => {
    const project = join(dir, 'project.catdb');
    expect(run('init', project, '--src', 'en', '--tgt', 'es').code).toBe(0);
    const added = run('add-file', project, BOOK);
    expect(added.err).toBe('');
    // Four locked: a table's two headers and its totals label, and "2026".
    expect(added.out).toBe('Added edge-cases.en.xlsx as file #1: 16 segments (4 locked)');

    const out = join(dir, 'out');
    expect(run('export', project, '--out', out).code).toBe(0);
    const before = readXlsx(new Uint8Array(readFileSync(BOOK)));
    const after = readXlsx(new Uint8Array(readFileSync(join(out, 'edge-cases.en.xlsx'))));
    for (const part of before.parts) {
      expect(
        Buffer.from(getPart(after, part.name)!).equals(Buffer.from(part.data)),
        part.name,
      ).toBe(true);
    }
  });

  it('refuses a source language without segmentation rules, as a DOCX does', () => {
    const project = join(dir, 'ja.catdb');
    run('init', project, '--src', 'ja', '--tgt', 'en');
    const result = run('add-file', project, BOOK);
    expect(result.code).toBe(1);
    expect(result.err).toContain('cannot segment ja');
  });
});
