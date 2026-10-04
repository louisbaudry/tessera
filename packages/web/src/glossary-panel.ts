/**
 * The glossary panel's logic (smart-glossary-spec.md §5a.2; backlog #43b):
 * the session as the server shows it, what each card offers, what the
 * footer says and when Confirm is allowed. Pure, so all of it is provable
 * without a DOM; the component renders and nothing more.
 *
 * The view types mirror `server/src/glossary-session.ts`: the SPA depends
 * on `core`'s types only, never on the server package.
 */
import type {
  FlagState,
  GlossaryMismatch,
  MismatchKind,
  Segment,
  SessionLangs,
} from '@cat-tool/core';

export interface FlagView {
  readonly key: string;
  readonly term: string;
  /** The entry it is about, or null for a term the write target lacks. */
  readonly termId: number | null;
  /** Renderings on offer, in the order to show them. */
  readonly offered: readonly string[];
  readonly occurrences: number;
  /** `ord` of each segment it occurs in, ascending. */
  readonly ords: readonly number[];
  readonly state: FlagState;
}

export interface SessionCounts {
  readonly flagged: number;
  readonly decided: number;
  readonly proposed: number;
  readonly skipped: number;
}

export interface SessionView {
  readonly status: 'open' | 'committed' | 'discarded';
  readonly langs: SessionLangs;
  readonly fileId: number;
  /** False until a Stage 2 aligner exists (backlog #42). */
  readonly aligned: boolean;
  readonly counts: SessionCounts;
  readonly flags: readonly FlagView[];
}

export interface MismatchList {
  /** The write-target glossary's slug; null when the project has none. */
  readonly glossary: string | null;
  readonly mismatches: readonly GlossaryMismatch[];
}

/** "repeated 11 times, in 7 segments" — what a card says about its term. */
export function occurrenceText(flag: FlagView): string {
  const times = flag.occurrences === 1 ? 'once' : `${flag.occurrences} times`;
  const segments = flag.ords.length;
  return segments === 0
    ? `repeated ${times}`
    : `repeated ${times}, in ${segments} ${segments === 1 ? 'segment' : 'segments'}`;
}

/** What a card offers beyond choosing: an entry that exists can be overridden or have a rendering deprecated. */
export function cardActions(flag: FlagView): {
  readonly canEdit: boolean;
  /** Renderings that can be deprecated: only those offered, and only on an entry. */
  readonly deprecatable: readonly string[];
} {
  const canEdit = flag.termId !== null;
  return { canEdit, deprecatable: canEdit ? flag.offered : [] };
}

/** One line for a card's state; null while it is still undecided. */
export function stateText(state: FlagState): string | null {
  switch (state.state) {
    case 'flagged':
      return null;
    case 'decided':
      return `Chose “${state.rendering}”`;
    case 'proposed':
      return state.edit === 'override'
        ? `Will override with “${state.rendering}”`
        : `Will deprecate “${state.rendering}”`;
    case 'skipped':
      return 'Skipped';
  }
}

/** The footer's count of what Confirm would write, and what it would not. */
export function footerText(counts: SessionCounts): string {
  const written = counts.decided + counts.proposed;
  const parts = [`${written} ${written === 1 ? 'decision' : 'decisions'}`];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  const line = parts.join(', ');
  return counts.skipped > 0 ? `${line} — skipped terms are asked again next time` : line;
}

export interface ConfirmState {
  readonly enabled: boolean;
  /** Why not, when it is not; null when it is. */
  readonly reason: string | null;
}

/**
 * Confirm is the one write (§5): disabled with nothing decided, and, with
 * no write-target glossary, disabled and saying why instead of failing
 * with a 409 after the click.
 */
export function confirmState(
  counts: SessionCounts,
  writeTarget: string | null,
): ConfirmState {
  if (writeTarget === null) {
    return {
      enabled: false,
      reason: 'This project has no glossary to write into. Choose one first.',
    };
  }
  if (counts.decided + counts.proposed === 0) {
    return { enabled: false, reason: 'Nothing is decided yet.' };
  }
  return { enabled: true, reason: null };
}

/**
 * The version of a file's segments as the editor holds them: the newest
 * `updatedAt`, which every write moves (`nextVersion`). A list that
 * depends on stored targets reloads when it changes.
 */
export function latestVersion(segments: readonly Segment[]): string {
  let latest = '';
  for (const s of segments) if (s.updatedAt > latest) latest = s.updatedAt;
  return `${segments.length}:${latest}`;
}

/** Segment `ord` → segment id, for jumping from what the server names by `ord`. */
export function idsByOrd(segments: readonly Segment[]): ReadonlyMap<number, number> {
  return new Map(segments.map((s) => [s.ord, s.id]));
}

/** Each kind in words, as a `Record` over `core`'s union so a new kind fails this typecheck. */
export const MISMATCH_LABEL: Readonly<Record<MismatchKind, string>> = {
  forbidden: 'Forbidden rendering',
  missing_preferred: 'Preferred rendering missing',
};

/** What a mismatch row says about its segment, in one line. */
export function mismatchText(m: GlossaryMismatch): string {
  if (m.kind === 'forbidden') {
    return `uses “${m.found ?? ''}”, which the glossary forbids`;
  }
  const preferred = m.preferred === null ? '' : `“${m.preferred}”`;
  return m.found === null
    ? `does not use ${preferred}`
    : `uses “${m.found}”, not ${preferred}`;
}

/**
 * Whether a mismatch row can be recorded as an exception (§6; backlog #110): only
 * when the translator used another acceptable rendering of the term. A forbidden
 * one is not an exception to record, and a row naming nothing used has no
 * rendering to record.
 */
export const canRecordException = (m: GlossaryMismatch): boolean =>
  m.kind === 'missing_preferred' && m.found !== null;

/** An alternative recorded often enough to propose making it preferred. */
export interface ExceptionProposalView {
  readonly termId: number;
  readonly lang: string;
  /** The term as the source language writes it; null if the entry holds none. */
  readonly term: string | null;
  readonly chosen: string;
  readonly preferred: string;
  /** Distinct segments it was recorded for. */
  readonly segments: number;
}

/** What a proposal says, in one line: the evidence, then the change it would make. */
export function proposalText(p: ExceptionProposalView): string {
  const where = p.segments === 1 ? '1 segment' : `${p.segments} segments`;
  return `“${p.chosen}” was recorded as the translation in ${where}: make it preferred over “${p.preferred}”?`;
}

/** A name a person typed for a glossary, as the slug the API takes (trimmed, lower-cased). */
export function glossaryNameInput(raw: string): string {
  return raw.trim().toLowerCase();
}
