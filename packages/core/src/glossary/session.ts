/**
 * The glossary session (smart-glossary-spec.md §5; backlog #41): what the
 * side panel is deciding, as a small explicit state machine, pure like
 * `portal-core/order.ts`. Nothing here touches a `.ctg` — decision 6 is
 * "propose, confirm at session end" — until `commit` hands the decided
 * entries to a writer it is given (`db/glossary/session.ts`). `core`
 * stays headless: no connection, no clock, no I/O.
 *
 *   flagged ──choose──▶ decided ──┐
 *      │                          ├─▶ commit(write) ─▶ one term_decision per entry
 *      ├──propose_edit──▶ proposed ┘
 *      └──skip──▶ skipped   (nothing written; re-flagged next session)
 *
 * A flag can change state, or return to `flagged` (`reopen`), until the
 * session is committed or discarded; after that every operation throws.
 */

import type { DecisionKind } from '../model/glossary.js';
import { termKey } from './key.js';

export class GlossarySessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlossarySessionError';
  }
}

/** What one decision needs to know about a flagged term. */
export interface SessionFlag {
  /** Identifies the flag within a session: the `termKey` of the source term. */
  readonly key: string;
  /** The source-language term, as shown. */
  readonly term: string;
  /** The existing entry it is about, or null for a term the glossary lacks. */
  readonly termId: number | null;
  /** Renderings on offer, as text — ranked by whoever produced them. */
  readonly offered: readonly string[];
  /** Segment `ord` where the term was first seen. */
  readonly firstOrd: number | null;
}

/** The two ways to change an entry that exists (§5's `propose_edit`). */
export type EditKind = 'override' | 'deprecate';

export type FlagState =
  | { readonly state: 'flagged' }
  | {
      readonly state: 'decided';
      readonly rendering: string;
      readonly kind: 'accepted_suggestion' | 'custom';
    }
  | {
      readonly state: 'proposed';
      readonly rendering: string;
      readonly edit: EditKind;
    }
  | { readonly state: 'skipped' };

/** One decision the session will write: exactly one `term_decision` row. */
export interface SessionEntry {
  readonly flag: SessionFlag;
  readonly kind: DecisionKind;
  /** The rendering chosen — or, for a deprecation, the one forbidden. */
  readonly rendering: string;
  /** The offered renderings other than `rendering`, as text. */
  readonly rejected: readonly string[];
}

/** The session's language pair, fixed for its life. */
export interface SessionLangs {
  readonly srcLang: string;
  readonly tgtLang: string;
}

export interface SerializedSession {
  readonly version: 1;
  readonly langs: SessionLangs;
  readonly closed: 'committed' | 'discarded' | null;
  readonly flags: readonly { readonly flag: SessionFlag; readonly state: FlagState }[];
}

export class GlossarySession {
  readonly langs: SessionLangs;
  private readonly flags = new Map<string, { flag: SessionFlag; state: FlagState }>();
  private closed: 'committed' | 'discarded' | null = null;

  constructor(langs: SessionLangs, flags: readonly SessionFlag[]) {
    if (langs.srcLang === '' || langs.tgtLang === '') {
      throw new GlossarySessionError('a session needs a language pair');
    }
    this.langs = { srcLang: langs.srcLang, tgtLang: langs.tgtLang };
    for (const flag of flags) {
      if (flag.key === '' || flag.key !== termKey(flag.key)) {
        throw new GlossarySessionError(
          `a flag's key is the termKey of its term, not "${flag.key}"`,
        );
      }
      if (this.flags.has(flag.key)) {
        throw new GlossarySessionError(`two flags for "${flag.key}"`);
      }
      this.flags.set(flag.key, { flag, state: { state: 'flagged' } });
    }
  }

  /** Every flag with where it stands, in the order it was flagged. */
  list(): readonly { readonly flag: SessionFlag; readonly state: FlagState }[] {
    return [...this.flags.values()];
  }

  get status(): 'open' | 'committed' | 'discarded' {
    return this.closed ?? 'open';
  }

  private assertOpen(): void {
    if (this.closed !== null) {
      throw new GlossarySessionError(`the session was ${this.closed}`);
    }
  }

  private open(key: string): { flag: SessionFlag; state: FlagState } {
    this.assertOpen();
    const entry = this.flags.get(key);
    if (!entry) throw new GlossarySessionError(`no flag "${key}" in this session`);
    return entry;
  }

  private static rendering(text: string): string {
    if (termKey(text) === '') {
      throw new GlossarySessionError('a rendering needs non-empty text');
    }
    return text;
  }

  /**
   * Picks a rendering. Whether it was one of those on offer is read off
   * `offered` (by `termKey`), never claimed: it decides `accepted_suggestion`
   * against `custom`.
   */
  choose(key: string, rendering: string): void {
    const entry = this.open(key);
    const text = GlossarySession.rendering(rendering);
    const offered = entry.flag.offered.some((o) => termKey(o) === termKey(text));
    entry.state = {
      state: 'decided',
      rendering: text,
      kind: offered ? 'accepted_suggestion' : 'custom',
    };
  }

  /** Queues a change to an entry that exists; nothing is written until `commit`. */
  proposeEdit(key: string, edit: EditKind, rendering: string): void {
    const entry = this.open(key);
    if (entry.flag.termId === null) {
      throw new GlossarySessionError(
        `"${key}" has no entry yet: there is nothing to edit, only to choose`,
      );
    }
    if (edit !== 'override' && edit !== 'deprecate') {
      throw new GlossarySessionError(`unknown edit "${String(edit)}"`);
    }
    entry.state = {
      state: 'proposed',
      rendering: GlossarySession.rendering(rendering),
      edit,
    };
  }

  /** Leaves it undecided. Not remembered: it is asked again next session. */
  skip(key: string): void {
    this.open(key).state = { state: 'skipped' };
  }

  /** Back to undecided — a decision taken back before the session ends. */
  reopen(key: string): void {
    this.open(key).state = { state: 'flagged' };
  }

  /** What `commit` would write, in flag order: one entry per decided or proposed flag. */
  pending(): SessionEntry[] {
    const out: SessionEntry[] = [];
    for (const { flag, state } of this.flags.values()) {
      if (state.state === 'decided') {
        out.push(entryOf(flag, state.kind, state.rendering));
      } else if (state.state === 'proposed') {
        out.push(
          entryOf(
            flag,
            state.edit === 'deprecate' ? 'deprecation' : 'override',
            state.rendering,
          ),
        );
      }
    }
    return out;
  }

  /** The flags nobody decided, which the next session asks about again. */
  remaining(): SessionFlag[] {
    return [...this.flags.values()]
      .filter(({ state }) => state.state === 'flagged' || state.state === 'skipped')
      .map(({ flag }) => flag);
  }

  /**
   * The one write. `write` receives every entry and applies them — all or
   * none, which is its job (`commitGlossarySession` runs it in one
   * transaction). The session closes only if `write` returns; if it throws,
   * the session is still open with every decision in it. Returns the number
   * of entries written.
   */
  commit(write: (entries: readonly SessionEntry[]) => void): number {
    this.assertOpen();
    const entries = this.pending();
    write(entries);
    this.closed = 'committed';
    return entries.length;
  }

  /** Drops everything. Nothing was written. */
  discard(): void {
    this.assertOpen();
    this.closed = 'discarded';
  }

  toJSON(): SerializedSession {
    return {
      version: 1,
      langs: this.langs,
      closed: this.closed,
      flags: this.list(),
    };
  }

  /** Restores a session from what `toJSON` wrote, re-validating all of it. */
  static fromJSON(value: unknown): GlossarySession {
    const bad = (why: string): never => {
      throw new GlossarySessionError(`not a glossary session: ${why}`);
    };
    if (typeof value !== 'object' || value === null) return bad('not an object');
    const v = value as Partial<SerializedSession>;
    if (v.version !== 1) return bad(`version ${String(v.version)}`);
    if (!Array.isArray(v.flags)) return bad('flags');
    if (typeof v.langs?.srcLang !== 'string' || typeof v.langs.tgtLang !== 'string') {
      return bad('langs');
    }
    if (v.closed !== null && v.closed !== 'committed' && v.closed !== 'discarded') {
      return bad('closed');
    }
    const flags = v.flags.map((f) => {
      const flag = (f as { flag?: SessionFlag }).flag;
      if (
        !flag ||
        typeof flag.key !== 'string' ||
        typeof flag.term !== 'string' ||
        !(flag.termId === null || Number.isInteger(flag.termId)) ||
        !(flag.firstOrd === null || Number.isInteger(flag.firstOrd)) ||
        !Array.isArray(flag.offered) ||
        !flag.offered.every((o) => typeof o === 'string')
      ) {
        return bad('a flag');
      }
      return flag;
    });
    const session = new GlossarySession(v.langs, flags);
    v.flags.forEach((f, i) => {
      const state = (f as { state?: FlagState }).state;
      const flag = flags[i]!;
      const entry = session.flags.get(flag.key)!;
      switch (state?.state) {
        case 'flagged':
        case 'skipped':
          entry.state = { state: state.state };
          break;
        case 'decided':
          session.choose(flag.key, state.rendering);
          break;
        case 'proposed':
          session.proposeEdit(flag.key, state.edit, state.rendering);
          break;
        default:
          bad(`the state of "${flag.key}"`);
      }
    });
    session.closed = v.closed;
    return session;
  }
}

function entryOf(flag: SessionFlag, kind: DecisionKind, rendering: string): SessionEntry {
  const chosen = termKey(rendering);
  return {
    flag,
    kind,
    rendering,
    rejected: flag.offered.filter((o) => termKey(o) !== chosen),
  };
}
