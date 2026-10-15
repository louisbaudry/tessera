/**
 * The engine seam and the validation of what comes back across it
 * (`planning/translation-engine-spec.md` §3 steps 6–7, §5; backlog #134).
 *
 * {@link DraftEngineAdapter} is the one thing an engine implements: a
 * request of plain data in, text out. The Anthropic and DeepL adapters
 * (slices 3 and 6) live in `server`, where the network is; nothing in `core`
 * imports a client, a database or a clock. Whether the caller may call it at
 * all is `resolveEngine`'s question, answered before any of this runs.
 *
 * **A reply is untrusted text until it has been read back into tokens.**
 * {@link validateDraft} maps the markers to the source's own tags and refuses
 * what cannot be: a dropped, repeated, invented or interleaved tag, a stray
 * angle bracket, text XML cannot carry, nothing at all. A refusal names why
 * and is counted by the caller; nothing is repaired, because a repaired
 * draft is one nobody reviewed. An accepted draft holds visible tags only —
 * the hidden ones are carried when it is written (`setSegmentTarget`,
 * `carryHiddenTags`), never placed by the engine.
 */

import { withoutHiddenTags } from '../model/hidden-tags.js';
import { missingTags, validateTagStructure } from '../model/tags.js';
import { parseTokens, plainText, TokenShapeError, type Token } from '../model/token.js';
import type { DraftEngine } from './engine.js';
import { parseMarked, visibleTagIds } from './markup.js';
import {
  buildPrompt,
  type BuiltPrompt,
  type DraftInput,
  type DraftSource,
} from './prompt.js';

/** What an engine is asked: the assembled prompt, and the marked source for one that ignores it. */
export interface DraftRequest {
  readonly srcLang: string;
  readonly tgtLang: string;
  /** The source with markers in place; DeepL's whole input (slice 6). */
  readonly sourceText: string;
  readonly prompt: {
    readonly version: string;
    readonly system: string;
    readonly user: string;
    readonly inputSha256: string;
  };
}

/** What an engine answers: the raw reply text, never tokens. */
export interface DraftResult {
  readonly text: string;
  /** The model or engine version that answered; recorded in provenance. */
  readonly model: string;
  readonly usage?: DraftUsage;
}

export interface DraftUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * An engine behind the seam. It may throw (a network error, a refusal): that
 * is the caller's to retry or stop on, and is not a draft outcome.
 */
export interface DraftEngineAdapter {
  /** Which engine this is; the gate already allowed exactly this one. */
  readonly engine: DraftEngine;
  /**
   * The model id this adapter is configured to call, known before a request is
   * sent: `ai.requested` is logged ahead of the send, so it cannot wait for the
   * reply's own `model` (which is what an accepted draft's provenance records).
   */
  readonly model: string;
  draft(request: DraftRequest): Promise<DraftResult>;
}

/** Why a reply was refused. A closed set, so a job can count each cause. */
export const DRAFT_REJECTIONS = [
  /** Nothing visible but whitespace. */
  'empty',
  /** An angle bracket that is not a marker. */
  'malformed_markup',
  /** A marker the source does not have. */
  'unknown_tag',
  /** Pairs that cross or never close, a close with no open, a marker used twice. */
  'tag_structure',
  /** A source tag the reply dropped. */
  'tag_missing',
  /** Tokens the file could not render (text XML cannot carry, a tag in a role its format does not fit). */
  'invalid_tokens',
] as const;
export type DraftRejection = (typeof DRAFT_REJECTIONS)[number];

export type DraftValidation =
  | { readonly ok: true; readonly tokens: Token[] }
  | { readonly ok: false; readonly reason: DraftRejection; readonly detail: string };

/**
 * Reads an engine's reply back as target tokens for `source`.
 *
 * The reply's outer whitespace is dropped: it belongs to the source, and the
 * prompt asks for none, so a model's trailing newline is not a difference.
 * Nothing else is touched.
 */
export function validateDraft(replyText: string, source: DraftSource): DraftValidation {
  const ids = visibleTagIds(source.tokens, source.formats);
  const parsed = parseMarked(replyText.trim(), ids.length);
  if (!parsed.ok) return { ok: false, reason: parsed.code, detail: parsed.message };

  const tokens: Token[] = [];
  for (const piece of parsed.pieces) {
    if (piece.kind === 'text') {
      tokens.push({ t: 'text', v: piece.text });
      continue;
    }
    const id = ids[piece.n - 1]!; // parseMarked bounds n by ids.length
    tokens.push(
      piece.kind === 'close' ? { t: 'close', id } : { t: piece.kind, id, fmt: id },
    );
  }

  // Text, not `isBlankTarget`: that counts a visible tag as content, and a
  // reply of `<t1></t1>` is no translation.
  if (plainText(tokens).trim() === '') {
    return { ok: false, reason: 'empty', detail: 'the reply holds no text' };
  }
  const structure = validateTagStructure(tokens);
  if (!structure.ok) {
    const e = structure.errors[0]!;
    return {
      ok: false,
      reason: 'tag_structure',
      detail: `${e.code} on tag ${e.id} (token ${e.index})`,
    };
  }
  const missing = missingTags(withoutHiddenTags(source.tokens, source.formats), tokens);
  if (missing.pairs.length > 0 || missing.placeholders.length > 0) {
    return {
      ok: false,
      reason: 'tag_missing',
      detail: `the reply dropped tag(s) ${[...missing.pairs, ...missing.placeholders].join(', ')}`,
    };
  }
  try {
    return { ok: true, tokens: parseTokens(tokens, source.formats) };
  } catch (error) {
    if (error instanceof TokenShapeError) {
      return { ok: false, reason: 'invalid_tokens', detail: error.message };
    }
    throw error;
  }
}

/** What goes into `segment.target_set`'s `detail.provenance` when a draft is accepted (`audit-spec.md` §4). */
export interface DraftProvenance {
  readonly engine: DraftEngine;
  readonly model: string;
  readonly promptVersion: string;
  /** SHA-256 of the prompt; the prompt itself is never logged. */
  readonly inputSha256: string;
}

export type DraftOutcome =
  | {
      readonly ok: true;
      /** Visible tags only; hidden ones are carried at write. */
      readonly tokens: Token[];
      readonly provenance: DraftProvenance;
      readonly usage?: DraftUsage;
    }
  | {
      readonly ok: false;
      readonly reason: DraftRejection;
      readonly detail: string;
      readonly provenance: DraftProvenance;
      /** A refused reply still cost tokens, and the caller counts them. */
      readonly usage?: DraftUsage;
    };

/**
 * One draft: assemble the prompt, call the engine, read the reply back.
 *
 * `beforeSend` runs once the prompt is built and before the engine is called,
 * which is where the caller logs `ai.requested`; if it throws, nothing is sent.
 *
 * @throws {DraftInputError} for a source with nothing to translate.
 * @throws whatever the adapter throws; that is an engine failure, not a
 *   refused draft, and the caller decides whether to retry or stop.
 */
export async function draftSegment(
  adapter: DraftEngineAdapter,
  input: DraftInput,
  beforeSend?: (prompt: BuiltPrompt) => void,
): Promise<DraftOutcome> {
  const prompt = buildPrompt(input);
  // The data-leaving event is logged ahead of the send, not after it: a call
  // that dies in flight may still have delivered the text (`audit-spec.md` §4).
  beforeSend?.(prompt);
  const result = await adapter.draft({
    srcLang: input.srcLang,
    tgtLang: input.tgtLang,
    sourceText: prompt.sourceText,
    prompt: {
      version: prompt.version,
      system: prompt.system,
      user: prompt.user,
      inputSha256: prompt.inputSha256,
    },
  });
  const provenance: DraftProvenance = {
    engine: adapter.engine,
    model: result.model,
    promptVersion: prompt.version,
    inputSha256: prompt.inputSha256,
  };
  const checked = validateDraft(result.text, input.source);
  const usage = result.usage === undefined ? {} : { usage: result.usage };
  return checked.ok
    ? { ok: true, tokens: checked.tokens, provenance, ...usage }
    : { ok: false, reason: checked.reason, detail: checked.detail, provenance, ...usage };
}
