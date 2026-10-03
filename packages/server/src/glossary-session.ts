/**
 * What the server holds of a glossary session between requests
 * (smart-glossary-spec.md §5a.1, backlog #43a): `core`'s
 * `GlossarySession` plus the facts a client needs about each flag that
 * the session itself does not carry — how often the term occurs and in
 * which segments. Detection and the view are here, not in a route, so
 * they are provable without HTTP; a route parses, calls and sends.
 *
 * A session lives in this process's memory only (§5a.1): it is a
 * proposal, and undecided work is not worth a schema.
 */

import {
  extractCandidates,
  flagTerms,
  GlossarySession,
  toSessionFlag,
  type FlagState,
  type GlossaryLookup,
  type Segment,
  type SessionFlag,
  type SessionLangs,
} from '@cat-tool/core';
import { findRendering, type openGlossary } from '@cat-tool/db';

type GlossaryDb = ReturnType<typeof openGlossary>;

/** A session and what was known of its flags when it was started. */
export interface HeldSession {
  readonly session: GlossarySession;
  readonly fileId: number;
  /** Per flag `key`: how often it occurs and in which segments (`ord`). */
  readonly detail: ReadonlyMap<
    string,
    { readonly occurrences: number; readonly ords: readonly number[] }
  >;
}

/**
 * The write target as detection's glossary (`GlossaryLookup`). Only the
 * file a commit will write into is consulted, never the others attached:
 * a `termId` is a row in one file, and a flag naming another file's term
 * would commit onto whichever term has that number here. A term that
 * exists only in a glossary further down the priority list is therefore
 * a flag with no entry, and committing it writes a rendering into the
 * write target — a client glossary overriding a base one, which is what
 * attaching it over the other means (§2.1). With no write target there
 * is no entry known at all, and a commit refuses.
 */
export function lookupIn(
  writeTarget: GlossaryDb | null,
  langs: SessionLangs,
): GlossaryLookup {
  if (writeTarget === null) return () => null;
  return (key) => {
    const found = findRendering(writeTarget, {
      srcLang: langs.srcLang,
      srcText: key,
      tgtLang: langs.tgtLang,
    })[0];
    return found ? { termId: found.termId, preferred: found.target.text } : null;
  };
}

/**
 * Detection over one file's segments: Stage 1, then Stage 3 with
 * `alignments = null` — Stage 2 is not run (§4.2: no AI client or
 * opt-in exists yet, backlog #42), so every flag is "repeated,
 * undecided". Throws `UnsupportedGlossaryLanguage` for a source language
 * with no stopword list.
 */
export function startGlossarySession(
  fileId: number,
  segments: readonly Segment[],
  langs: SessionLangs,
  writeTarget: GlossaryDb | null,
): HeldSession {
  const candidates = extractCandidates(segments, { srcLang: langs.srcLang });
  const flags = flagTerms(candidates, null, lookupIn(writeTarget, langs));
  const detail = new Map(
    flags.map((f) => [f.key, { occurrences: f.occurrences, ords: f.ords }] as const),
  );
  return {
    session: new GlossarySession(langs, flags.map(toSessionFlag)),
    fileId,
    detail,
  };
}

export interface FlagView {
  readonly key: string;
  readonly term: string;
  /** The entry it is about, or null for a term the write target lacks. */
  readonly termId: number | null;
  /** Renderings on offer, in the order to show them. */
  readonly offered: readonly string[];
  readonly occurrences: number;
  /** Segments it occurs in, ascending: the panel jumps to the first. */
  readonly ords: readonly number[];
  readonly state: FlagState;
}

export interface SessionView {
  readonly status: 'open' | 'committed' | 'discarded';
  readonly langs: SessionLangs;
  readonly fileId: number;
  /** Always false until backlog #42: no flag has aligned renderings. */
  readonly aligned: false;
  readonly counts: {
    readonly flagged: number;
    readonly decided: number;
    readonly proposed: number;
    readonly skipped: number;
  };
  readonly flags: readonly FlagView[];
}

const withDetail = (held: HeldSession, flag: SessionFlag, state: FlagState): FlagView => {
  const known = held.detail.get(flag.key);
  return {
    key: flag.key,
    term: flag.term,
    termId: flag.termId,
    offered: flag.offered,
    occurrences: known?.occurrences ?? 0,
    ords: known?.ords ?? [],
    state,
  };
};

export function sessionView(held: HeldSession): SessionView {
  const flags = held.session
    .list()
    .map(({ flag, state }) => withDetail(held, flag, state));
  const counts = { flagged: 0, decided: 0, proposed: 0, skipped: 0 };
  for (const f of flags) counts[f.state.state] += 1;
  return {
    status: held.session.status,
    langs: held.session.langs,
    fileId: held.fileId,
    aligned: false,
    counts,
    flags,
  };
}

/**
 * Who a session belongs to: the account, the project and the file. A
 * second start for the same key replaces the first.
 */
export const sessionKey = (accountId: number, project: string, fileId: number): string =>
  `${accountId}:${project}:${fileId}`;
