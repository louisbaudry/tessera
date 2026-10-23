/**
 * A PPTX through `runCli` (`v1-spec.md` §3.9; issue #169): add-file reads the
 * deck, and export hands back every part unchanged when nothing was translated.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPart, readPptx } from '@cat-tool/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';

const DECK = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/pptx/lo-deck.en.pptx',
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-cli-pptx-'));
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

describe('cat-tool: PPTX', () => {
  it('add-file reads a .pptx and export writes every part back', () => {
    const project = join(dir, 'project.catdb');
    expect(run('init', project, '--src', 'en', '--tgt', 'es').code).toBe(0);
    const added = run('add-file', project, DECK);
    expect(added.err).toBe('');
    expect(added.out).toMatch(
      /Added lo-deck\.en\.pptx as file #1: \d+ segments \(0 locked\)/,
    );

    const out = join(dir, 'out');
    expect(run('export', project, '--out', out).code).toBe(0);
    const before = readPptx(new Uint8Array(readFileSync(DECK)));
    const after = readPptx(new Uint8Array(readFileSync(join(out, 'lo-deck.en.pptx'))));
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
    const result = run('add-file', project, DECK);
    expect(result.code).toBe(1);
    expect(result.err).toContain('cannot segment ja');
  });
});
