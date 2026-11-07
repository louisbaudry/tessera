/**
 * A glossary CSV read back, or refused by line (Epic 16 slice S3, issue #356,
 * `software-localisation-spec.md` §6 G3). Pure: text in, rows and refusals
 * out; writing them into a `.ctg` is `db`'s (`db/glossary/session.ts`,
 * `importGlossaryRows`).
 *
 * The columns are `term,lang,rendering,status,avoid,keep` (the first three
 * are required, the rest may be left out of the header or blank in a row),
 * in any order, one rendering of one term per row:
 *
 * - `term` is the source-language form; the source language is the import's,
 *   not a column, because a file with two source languages is two files.
 * - `lang` is the target language of `rendering`.
 * - `status` is `official` or `review` (blank is `official`). A `.ctg` has no
 *   term status, so it is kept as a note on the rendering, never silently
 *   dropped (the import says so in its result).
 * - `avoid` is renderings not to use, separated by `|`: each becomes a
 *   `forbidden` rendering. A pipe is the separator because a comma is the
 *   column's own and a semicolon turns up inside terms.
 * - `keep` is `yes`/`no` (also `true`/`false`, `1`/`0`, blank is no): a term
 *   left as it is in the source language. Its rendering is the term itself,
 *   so the `rendering` cell may be empty or the term, and anything else is
 *   a contradiction and refused.
 *
 * A reader that repairs a bad file lets a wrong glossary in without telling
 * anyone, so every problem is a refusal naming its line, and the file is
 * refused as a whole when there is one (`refusals.length > 0`).
 */

import { primarySubtag } from '../model/lang.js';

import { termKey } from './key.js';

/** The two statuses the workbench's official glossary uses. */
export const GLOSSARY_IMPORT_STATUSES = ['official', 'review'] as const;
export type GlossaryImportStatus = (typeof GLOSSARY_IMPORT_STATUSES)[number];

/** The columns a file may have; the first three are required. */
export const GLOSSARY_IMPORT_COLUMNS = [
  'term',
  'lang',
  'rendering',
  'status',
  'avoid',
  'keep',
] as const;

/** The separator inside an `avoid` cell. */
export const GLOSSARY_AVOID_SEPARATOR = '|';

/** The most data rows one import takes; a larger glossary is imported in parts. */
export const MAX_GLOSSARY_IMPORT_ROWS = 20_000;

/** One valid row. `line` is the file's own 1-based line, for a later error to name. */
export interface GlossaryImportRow {
  readonly line: number;
  readonly term: string;
  readonly lang: string;
  /** What is written as the term's rendering: the cell, or the term itself for `keep`. */
  readonly rendering: string;
  readonly status: GlossaryImportStatus;
  readonly avoid: readonly string[];
  readonly keep: boolean;
}

/** Why a line of the file cannot be imported. `line` is 0 for the file as a whole. */
export interface GlossaryImportRefusal {
  readonly line: number;
  readonly message: string;
}

export interface ParsedGlossaryCsv {
  readonly rows: readonly GlossaryImportRow[];
  /** Empty when the file can be imported; `rows` is not to be used otherwise. */
  readonly refusals: readonly GlossaryImportRefusal[];
}

interface Record_ {
  readonly line: number;
  readonly cells: string[];
}

/**
 * RFC 4180 records with the line each starts on. A quoted cell may hold a
 * comma, a quote (doubled) or a line break; a bare quote in an unquoted cell
 * and a quote left open at the end are errors, not guesses.
 */
function readRecords(text: string): {
  records: Record_[];
  error: GlossaryImportRefusal | null;
} {
  const records: Record_[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endCell = (): void => {
    cells.push(cell);
    cell = '';
    quoted = false;
  };
  const endRecord = (): void => {
    endCell();
    // A blank line is not a record (a trailing newline, or a gap a spreadsheet left).
    if (!(cells.length === 1 && cells[0] === ''))
      records.push({ line: startLine, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      if (cell !== '' || quoted) {
        return {
          records,
          error: { line, message: 'a quote inside a cell that does not start with one' },
        };
      }
      inQuotes = true;
      quoted = true;
    } else if (c === ',') {
      endCell();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else if (quoted) {
      return {
        records,
        error: { line, message: 'text after the closing quote of a cell' },
      };
    } else {
      cell += c;
    }
  }
  if (inQuotes) {
    return {
      records,
      error: { line: startLine, message: 'a quote is opened and never closed' },
    };
  }
  if (cell !== '' || cells.length > 0 || quoted) endRecord();
  return { records, error: null };
}

/** `yes`/`no` and its common spellings, or null when the cell is neither. */
function readFlag(cell: string): boolean | null {
  const v = cell.trim().toLowerCase();
  if (v === '' || v === 'no' || v === 'false' || v === '0') return false;
  if (v === 'yes' || v === 'true' || v === '1') return true;
  return null;
}

/** A language tag's shape (BCP 47): a refusal here is a typo, not a registry check. */
export const LANG_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Reads a glossary CSV. `srcLang` is the language of every `term`; a row whose
 * `lang` is that language is refused, because a term is not its own rendering.
 *
 * Never throws: a bad file is a list of refusals, each with its line.
 */
export function parseGlossaryCsv(text: string, srcLang: string): ParsedGlossaryCsv {
  const refusals: GlossaryImportRefusal[] = [];
  const whole = (message: string): ParsedGlossaryCsv => ({
    rows: [],
    refusals: [...refusals, { line: 0, message }],
  });

  if (!LANG_TAG.test(srcLang)) return whole(`"${srcLang}" is not a language tag`);
  const { records, error } = readRecords(text.replace(/^﻿/, ''));
  if (error) return { rows: [], refusals: [error] };
  const header = records[0];
  if (!header) return whole('the file is empty');

  const names = header.cells.map((c) => c.trim().toLowerCase());
  const column = new Map<string, number>();
  for (const [i, name] of names.entries()) {
    if (!(GLOSSARY_IMPORT_COLUMNS as readonly string[]).includes(name)) {
      refusals.push({ line: header.line, message: `unknown column "${name}"` });
    } else if (column.has(name)) {
      refusals.push({ line: header.line, message: `column "${name}" appears twice` });
    } else {
      column.set(name, i);
    }
  }
  for (const required of ['term', 'lang', 'rendering']) {
    if (!column.has(required)) {
      refusals.push({
        line: header.line,
        message: `the header has no "${required}" column`,
      });
    }
  }
  if (refusals.length > 0) return { rows: [], refusals };

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) return whole('the file has a header and no rows');
  if (dataRecords.length > MAX_GLOSSARY_IMPORT_ROWS) {
    return whole(
      `${dataRecords.length} rows is more than one import takes (${MAX_GLOSSARY_IMPORT_ROWS})`,
    );
  }

  const cellOf = (r: Record_, name: string): string => {
    const i = column.get(name);
    return i === undefined ? '' : (r.cells[i] ?? '').trim();
  };
  const rows: GlossaryImportRow[] = [];
  const seen = new Map<string, number>();
  for (const r of dataRecords) {
    const problems: string[] = [];
    if (r.cells.length !== names.length) {
      refusals.push({
        line: r.line,
        message: `${r.cells.length} cells where the header has ${names.length}`,
      });
      continue;
    }
    const term = cellOf(r, 'term');
    const lang = cellOf(r, 'lang');
    let rendering = cellOf(r, 'rendering');
    const statusCell = cellOf(r, 'status').toLowerCase();
    const keep = readFlag(cellOf(r, 'keep'));
    const avoid = cellOf(r, 'avoid')
      .split(GLOSSARY_AVOID_SEPARATOR)
      .map((a) => a.trim())
      .filter((a) => a !== '');

    if (termKey(term) === '') problems.push('the term is empty');
    if (!LANG_TAG.test(lang)) {
      problems.push(
        lang === '' ? 'the language is empty' : `"${lang}" is not a language tag`,
      );
    } else if (primarySubtag(lang) === primarySubtag(srcLang)) {
      problems.push(
        `"${lang}" is the source language, and a term is not its own rendering`,
      );
    }
    const status = statusCell === '' ? 'official' : statusCell;
    if (!(GLOSSARY_IMPORT_STATUSES as readonly string[]).includes(status)) {
      problems.push(`status "${statusCell}" is neither official nor review`);
    }
    if (keep === null) problems.push(`keep "${cellOf(r, 'keep')}" is neither yes nor no`);
    if (keep === true) {
      if (rendering !== '' && termKey(rendering) !== termKey(term)) {
        problems.push(
          'keep means the rendering is the term itself, and this one differs',
        );
      }
      rendering = term;
    } else if (termKey(rendering) === '') {
      problems.push('the rendering is empty');
    }
    for (const a of avoid) {
      if (termKey(a) === termKey(rendering)) {
        problems.push(`"${a}" is both the rendering and a rendering to avoid`);
      }
    }

    if (problems.length === 0) {
      const key = `${termKey(term)}\u0000${primarySubtag(lang)}`;
      const first = seen.get(key);
      if (first !== undefined) {
        problems.push(`the term already has a rendering in ${lang} on line ${first}`);
      } else {
        seen.set(key, r.line);
      }
    }
    if (problems.length > 0) {
      for (const message of problems) refusals.push({ line: r.line, message });
      continue;
    }
    rows.push({
      line: r.line,
      term,
      lang,
      rendering,
      status: status as GlossaryImportStatus,
      avoid,
      keep: keep === true,
    });
  }
  return refusals.length > 0 ? { rows: [], refusals } : { rows, refusals: [] };
}
