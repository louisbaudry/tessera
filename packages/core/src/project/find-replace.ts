/**
 * Find and replace across a project's targets, the pure half (`v1-spec.md` §7.8;
 * backlog #148b, issue #170): what a pattern is, whether it may be run, and what
 * a replacement does to one target's tokens. Nothing here reads a database or runs
 * for longer than one segment; the project-wide run is `db/project/find-replace.ts`,
 * on a worker thread with a time limit, because a regular expression can take
 * exponential time and this module cannot stop one (`REPLACE_TIME_LIMIT_MS`'s reason).
 *
 * A match lives inside a run of text: the target is read with its hidden tags
 * removed and adjacent text joined, so a bookmark inside a phrase does not hide
 * it, and a visible tag is never inside a match or touched by a replacement.
 */

import { withoutHiddenTags } from '../model/hidden-tags.js';
import type { FormatEntry, Token } from '../model/token.js';
import { escapeRegex } from '../segment/srx.js';
import type { TextRange } from '../tm/concordance.js';

/** The longest pattern accepted, in characters. */
export const FIND_MAX_PATTERN_CHARS = 200;

/** The longest replacement accepted, in characters. */
export const REPLACE_MAX_CHARS = 1000;

/** Segments one run may change; more is a second run, so a preview stays one a person can read. */
export const REPLACE_MAX_SEGMENTS = 500;

/** How long a scan may run before its thread is terminated, in ms. */
export const REPLACE_TIME_LIMIT_MS = 10_000;

/**
 * How long an apply may run, in ms: longer than a scan's because it also writes
 * (each segment reruns QA). A pattern that hangs is ended by the scan's limit before
 * anyone can apply it; this longer one is reached only by an apply sent for a pattern
 * that was never previewed, and its transaction is rolled back with the thread.
 */
export const REPLACE_APPLY_TIME_LIMIT_MS = 60_000;

/** What to look for. */
export interface FindSpec {
  readonly pattern: string;
  /** A JavaScript regular expression (`u` flag) when true, a plain text search when false. */
  readonly regex: boolean;
  readonly caseSensitive: boolean;
}

/** A pattern ready to run. Built by {@link compileFind}, never by hand. */
export interface CompiledFind {
  /** Global and unicode, so every match is found and a surrogate pair is one character. */
  readonly re: RegExp;
  readonly regex: boolean;
}

/** Why a pattern or replacement cannot be run, or null when they can. */
export function findProblem(spec: FindSpec, replacement: string): string | null {
  if (replacement.length > REPLACE_MAX_CHARS) {
    return `A replacement is at most ${REPLACE_MAX_CHARS} characters.`;
  }
  const compiled = compileFind(spec);
  return 'error' in compiled ? compiled.error : null;
}

/**
 * The pattern as a runnable expression, or the reason it is not one. Nothing can
 * skip these checks, since a run is built from this and not from the spec: an empty
 * pattern and one over `FIND_MAX_PATTERN_CHARS` are refused. A text search is
 * escaped, so nothing in it is syntax. A regular expression that does not compile
 * says so in the engine's words; one that matches the empty string is refused, since
 * replacing it would put the replacement between every pair of characters.
 */
export function compileFind(spec: FindSpec): CompiledFind | { readonly error: string } {
  if (spec.pattern === '') return { error: 'Type what to find.' };
  if (spec.pattern.length > FIND_MAX_PATTERN_CHARS) {
    return { error: `A pattern is at most ${FIND_MAX_PATTERN_CHARS} characters.` };
  }
  const flags = spec.caseSensitive ? 'gu' : 'giu';
  let re: RegExp;
  try {
    re = new RegExp(spec.regex ? spec.pattern : escapeRegex(spec.pattern), flags);
  } catch (err) {
    // The engine's message repeats the pattern and its flags; only the reason is kept.
    const why =
      err instanceof Error
        ? err.message.replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, '')
        : '';
    return { error: `That is not a valid regular expression${why ? `: ${why}` : '.'}` };
  }
  if (spec.regex && new RegExp(re.source, re.flags.replace('g', '')).test('')) {
    return {
      error: 'That pattern matches the empty string, so it would match everywhere.',
    };
  }
  return { re, regex: spec.regex };
}

/** Where the pattern matches in `text`, empty matches left out, in order. */
export function matchRanges(text: string, find: CompiledFind): TextRange[] {
  const out: TextRange[] = [];
  for (const m of text.matchAll(find.re)) {
    if (m[0].length > 0) out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * `text` with every match replaced, and how many there were. A text search takes
 * the replacement verbatim; a regular expression's replacement is JavaScript's, so
 * `$1`, `$&` and `$$` mean what they do in `String.prototype.replace`.
 */
export function replaceText(
  text: string,
  find: CompiledFind,
  replacement: string,
): { readonly text: string; readonly count: number } {
  const count = matchRanges(text, find).length;
  if (count === 0) return { text, count };
  const replaced = find.regex
    ? text.replace(find.re, replacement)
    : text.replace(find.re, () => replacement);
  return { text: replaced, count };
}

/** Adjacent text tokens joined into one, so a match is not cut by how the text happens to be split. */
function joinText(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (token.t === 'text' && last?.t === 'text') {
      out[out.length - 1] = { t: 'text', v: last.v + token.v };
    } else {
      out.push(token);
    }
  }
  return out;
}

/**
 * A target after a replacement: its visible tokens, text runs rewritten, every tag
 * where it was. `count` is the matches replaced and `ranges` where they sat in the
 * target's plain text before (its text tokens, joined: tags take no room), so a
 * preview can mark them. With no match, `tokens` is the visible tokens unchanged and
 * the caller writes nothing. A run whose text is replaced with nothing disappears; a
 * target left with nothing visible is the caller's to judge (`editSegmentTarget`
 * makes it an untranslated segment again).
 */
export function replaceInTokens(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
  find: CompiledFind,
  replacement: string,
): { readonly tokens: Token[]; readonly count: number; readonly ranges: TextRange[] } {
  let count = 0;
  let offset = 0;
  const ranges: TextRange[] = [];
  const next: Token[] = [];
  for (const token of joinText(withoutHiddenTags(tokens, formats))) {
    if (token.t !== 'text') {
      next.push(token);
      continue;
    }
    for (const r of matchRanges(token.v, find)) {
      ranges.push({ start: offset + r.start, end: offset + r.end });
    }
    const done = replaceText(token.v, find, replacement);
    count += done.count;
    offset += token.v.length;
    if (done.text !== '') next.push({ t: 'text', v: done.text });
  }
  return { tokens: next, count, ranges };
}
