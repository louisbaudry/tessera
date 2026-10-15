/**
 * The gated drafting run (backlog #135; `planning/translation-engine-spec.md`
 * §3, D4, D12, D15): for each segment the memories left empty, ask a draft
 * engine and hold the answer as a suggestion, never as the segment's target.
 *
 * This is the `db` half of a draft. `core/draft` makes the prompt and reads the
 * reply back (`draftSegment`); this module finds what goes into it from the
 * project's own files (the attached memories, the write-target glossary, the
 * neighbouring segments) and keeps what comes out. The network is the
 * adapter's, behind the seam, so everything here runs offline against a fake.
 *
 * Four rules, each tested:
 * - **The gate is asked before every segment**, not once per run (D4, D15): a
 *   client switched off mid-run stops the remaining segments, and an engine the
 *   gate does not name is the same as `off`.
 * - **`ai.requested` is logged before the send**, in its own transaction, so a
 *   call that dies in flight is still on the record (`audit-spec.md` §4).
 * - **Nothing a TM can place reaches the engine.** An exact hit or a confirmed
 *   sibling means pre-translate places that segment; a draft for it would send
 *   client text for nothing and offer a worse answer than the memory's.
 * - **A refused reply is counted and stored nowhere** (`validateDraft`).
 */

import {
  draftSegment,
  draftTerms,
  FUZZY_FLOOR,
  hasSpacedWords,
  isBlankTarget,
  isProtectedFromPretranslate,
  operandOfSource,
  plainText,
  PROMPT_LIMITS,
  withoutHiddenTags,
  DRAFT_REJECTIONS,
  type AuditActor,
  type DraftEngineAdapter,
  type DraftReference,
  type DraftRejection,
  type EngineDecision,
  type GlossaryTermEntry,
  type Segment,
} from '@cat-tool/core';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

import { appendAuditEvent } from '../audit/events.js';
import { listTermEntries } from '../glossary/terms.js';
import { retrieveFuzzy } from '../tm/fuzzy.js';
import { getDraftSuggestion, putDraftSuggestion } from './draft-suggestions.js';
import { listGlossaryRefs } from './glossary-refs.js';
import { findExactTmMatch } from './pretranslate.js';
import { getProject } from './project.js';
import { listAllSegments } from './segments.js';
import { attachTms, detachTms, listTmRefs, tmAlias } from './tm-refs.js';

/**
 * Tokens (input and output, as the engine reports them) one run may spend
 * before it stops and reports (D12). A placeholder until real spend per client
 * is seen, so it is deliberately modest; a caller that knows better passes its
 * own.
 */
export const DEFAULT_DRAFT_TOKEN_CEILING = 200_000;

export class DraftRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftRunError';
  }
}

export interface DraftSuggestionsOptions {
  /** Who ran it; required. The engine is an origin, never an actor. */
  readonly actor: AuditActor;
  readonly adapter: DraftEngineAdapter;
  /**
   * What the client allows right now (`engineFor`, which reads
   * `platform.sqlite`), asked again before every segment. A function and not a
   * value so a withdrawal during the run is seen by the next segment.
   */
  readonly gate: () => EngineDecision;
  /** Limit candidates to one file; omit for the whole project. */
  readonly fileId?: number;
  /** Stops the run when the engine's reported tokens reach it. */
  readonly tokenCeiling?: number;
  /** Asked before each segment; true ends the run cleanly (a cancelled job). */
  readonly shouldStop?: () => boolean;
  /** Told after each candidate, with how many are done of how many. */
  readonly onProgress?: (done: number, total: number) => void;
  /** Clock for `createdAt`; tests freeze it. */
  readonly now?: () => Date;
}

/** Why a run ended. Only `done` means every candidate was asked. */
export type DraftStop =
  | 'done'
  /** The gate named no engine, or not this adapter's, before a segment. */
  | 'gate_closed'
  /** The token ceiling was reached; a rerun resumes, as stored segments are skipped. */
  | 'ceiling'
  | 'cancelled'
  /** The adapter threw; nothing is retried here, and `error` says why. */
  | 'engine_error';

export interface DraftSuggestionsSummary {
  readonly stop: DraftStop;
  /** The adapter's error message, when `stop` is `engine_error`. */
  readonly error: string | null;
  /** Segments an engine was asked about: one `ai.requested` each. */
  readonly requested: number;
  /** Suggestions stored. */
  readonly stored: number;
  /** Replies refused, by reason. */
  readonly rejected: Readonly<Record<DraftRejection, number>>;
  readonly skipped: {
    /** Confirmed or locked. */
    readonly protected: number;
    /** Already holds a target (pre-translate placed one, or a person wrote it), or a source with nothing to translate. */
    readonly hasTarget: number;
    /** A current suggestion already exists. */
    readonly suggested: number;
    /** A memory hit or a confirmed sibling places it. */
    readonly covered: number;
  };
  readonly tokens: { readonly input: number; readonly output: number };
}

/** The glossary entries the write-target `.ctg` holds for the pair, or none. */
function glossaryEntries(
  db: Database.Database,
  langs: { readonly srcLang: string; readonly tgtLang: string },
): GlossaryTermEntry[] {
  const ref = listGlossaryRefs(db).find((r) => r.isWriteTarget && r.enabled);
  if (!ref || !existsSync(ref.path)) return [];
  let glossary: Database.Database | undefined;
  try {
    glossary = new Database(ref.path, { fileMustExist: true });
    glossary.pragma('query_only = ON');
    return listTermEntries(glossary, langs);
  } catch {
    // A glossary that cannot be read is the glossary panel's to report; a
    // draft without terms is still a draft.
    return [];
  } finally {
    glossary?.close();
  }
}

const noRejections = (): Record<DraftRejection, number> =>
  Object.fromEntries(DRAFT_REJECTIONS.map((r) => [r, 0])) as Record<
    DraftRejection,
    number
  >;

/** The visible source text of a segment, for a neighbour's context line. */
const sourceLine = (s: Segment): string =>
  plainText(withoutHiddenTags(s.sourceTokens, s.formatTable)).trim();

/**
 * Asks the engine for every segment the memories left empty, one request per
 * segment, and stores each valid reply as a suggestion.
 *
 * Sequential on purpose: the gate, the ceiling and `ai.requested` all depend on
 * the order of requests. It holds no transaction across an `await`; each log
 * entry and each stored suggestion is its own short one.
 *
 * @throws {DraftRunError} when the project has no identity row.
 */
export async function draftSuggestions(
  db: Database.Database,
  options: DraftSuggestionsOptions,
): Promise<DraftSuggestionsSummary> {
  const project = getProject(db);
  if (!project) {
    throw new DraftRunError('project has no identity row — nothing to draft');
  }
  const { srcLang, tgtLang } = project;
  const ceiling = options.tokenCeiling ?? DEFAULT_DRAFT_TOKEN_CEILING;
  const now = options.now ?? (() => new Date());

  const attached = attachTms(db, listTmRefs(db)); // already priority order
  try {
    const all = listAllSegments(db);
    const entries = glossaryEntries(db, { srcLang, tgtLang });
    const fuzzyOn = hasSpacedWords(srcLang);

    const donors = new Set<string>();
    for (const s of all) {
      if (s.status === 'confirmed' && s.targetTokens) donors.add(s.sourceHash);
    }
    const exactCache = new Map<string, boolean>();
    const hasExact = (hash: string): boolean => {
      const hit = exactCache.get(hash);
      if (hit !== undefined) return hit;
      const found = findExactTmMatch(db, attached, srcLang, tgtLang, hash) !== null;
      exactCache.set(hash, found);
      return found;
    };

    const skipped = { protected: 0, hasTarget: 0, suggested: 0, covered: 0 };
    const candidates: Segment[] = [];
    for (const s of all) {
      if (options.fileId !== undefined && s.fileId !== options.fileId) continue;
      if (isProtectedFromPretranslate(s)) skipped.protected++;
      else if (
        (s.targetTokens && !isBlankTarget(s.targetTokens, s.formatTable)) ||
        sourceLine(s) === ''
      )
        skipped.hasTarget++;
      else if (getDraftSuggestion(db, s.id)) skipped.suggested++;
      else if (donors.has(s.sourceHash) || hasExact(s.sourceHash)) skipped.covered++;
      else candidates.push(s);
    }

    const neighbours = (s: Segment): { before: string[]; after: string[] } => {
      const sameFile = all.filter((o) => o.fileId === s.fileId);
      const i = sameFile.findIndex((o) => o.id === s.id);
      const lines = (from: number, to: number) =>
        sameFile
          .slice(from, to)
          .map(sourceLine)
          .filter((l) => l !== '');
      return {
        before: lines(Math.max(0, i - PROMPT_LIMITS.neighbours), i),
        after: lines(i + 1, i + 1 + PROMPT_LIMITS.neighbours),
      };
    };

    const referencesFor = (s: Segment): DraftReference[] => {
      if (!fuzzyOn) return [];
      const source = operandOfSource(s.sourceTokens, s.formatTable);
      const found = attached.flatMap((ref, priority) =>
        retrieveFuzzy(
          db,
          {
            srcLang,
            tgtLang,
            source,
            minScore: FUZZY_FLOOR,
            limit: PROMPT_LIMITS.references,
          },
          { schema: tmAlias(ref.id) },
        ).map((m) => ({ m, priority })),
      );
      // The closest match first, whichever memory holds it; priority only
      // breaks a tie (v1-spec.md §6.1a, 5), as pre-translate does.
      found.sort((a, b) => b.m.score - a.m.score || a.priority - b.priority);
      const seen = new Set<string>();
      const out: DraftReference[] = [];
      for (const { m } of found) {
        const key = `${m.sourcePlain}\u0000${JSON.stringify(m.tokens)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ source: [{ t: 'text', v: m.sourcePlain }], target: m.tokens });
        if (out.length === PROMPT_LIMITS.references) break;
      }
      return out;
    };

    const summary = {
      stop: 'done' as DraftStop,
      error: null as string | null,
      requested: 0,
      stored: 0,
      rejected: noRejections(),
      tokens: { input: 0, output: 0 },
    };

    let done = 0;
    for (const segment of candidates) {
      if (options.shouldStop?.()) {
        summary.stop = 'cancelled';
        break;
      }
      const decision = options.gate();
      if (decision.engine !== options.adapter.engine) {
        summary.stop = 'gate_closed';
        break;
      }
      if (summary.tokens.input + summary.tokens.output >= ceiling) {
        summary.stop = 'ceiling';
        break;
      }

      const { before, after } = neighbours(segment);
      let outcome;
      try {
        outcome = await draftSegment(
          options.adapter,
          {
            srcLang,
            tgtLang,
            source: { tokens: segment.sourceTokens, formats: segment.formatTable },
            references: referencesFor(segment),
            terms: draftTerms(entries, segment.sourceTokens, srcLang),
            before,
            after,
          },
          (prompt) => {
            appendAuditEvent(db, {
              actor: options.actor,
              action: 'ai.requested',
              subjectType: 'segment',
              subjectId: String(segment.id),
              detail: {
                engine: options.adapter.engine,
                model: options.adapter.model,
                prompt_version: prompt.version,
                input_sha256: prompt.inputSha256,
              },
            });
            summary.requested++;
          },
        );
      } catch (error) {
        summary.stop = 'engine_error';
        summary.error = error instanceof Error ? error.message : String(error);
        break;
      }

      if (outcome.usage) {
        summary.tokens.input += outcome.usage.inputTokens;
        summary.tokens.output += outcome.usage.outputTokens;
      }
      if (outcome.ok) {
        putDraftSuggestion(db, {
          segmentId: segment.id,
          sourceHash: segment.sourceHash,
          targetTokens: outcome.tokens,
          engine: outcome.provenance.engine,
          model: outcome.provenance.model,
          promptVersion: outcome.provenance.promptVersion,
          inputSha256: outcome.provenance.inputSha256,
          createdAt: now().toISOString(),
        });
        summary.stored++;
      } else {
        summary.rejected[outcome.reason]++;
      }
      options.onProgress?.(++done, candidates.length);
    }

    return { ...summary, skipped };
  } finally {
    detachTms(db, attached);
  }
}
