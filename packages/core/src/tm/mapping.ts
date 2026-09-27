/**
 * Project `Token` ↔ TM `TmToken` mapping (tm-format-spec.md §3; backlog
 * #15c).
 *
 * A project token's `fmt` indexes a *per-file* format table — meaningless
 * outside the file that produced it. The TM therefore stores only what
 * survives a move between documents: that a tag of a given `kind`
 * occupied a given position. Writing drops the payload; reading rebuilds
 * one by matching tags to the *receiving* segment's own formatting.
 *
 * "A unit from a 2023 client file matching a segment in today's document
 * must apply today's document's bold, never the 2023 file's" — this
 * module is where that rule actually gets enforced.
 */

import type { FormatEntry } from '../docx/tokenize.js';
import { validateTagStructure } from '../model/tags.js';
import type { TagKind, TmToken, Token } from '../model/token.js';

/**
 * Reduces project tokens to their TM form: `fmt` dropped, `kind` carried
 * as a hint (`k`) instead, ids renumbered from 1 in source order —
 * exactly the identity a project token loses no matter which file it
 * ends up matched against later.
 */
export function toTmTokens(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): TmToken[] {
  const formatById = new Map(formats.map((f) => [f.id, f]));
  const renumbered = new Map<number, number>();
  const nextId = (): number => renumbered.size + 1;

  const out: TmToken[] = [];
  for (const token of tokens) {
    if (token.t === 'text') {
      out.push(token);
      continue;
    }
    let id = renumbered.get(token.id);
    if (id === undefined) {
      id = nextId();
      renumbered.set(token.id, id);
    }
    if (token.t === 'close') {
      out.push({ t: 'close', id });
      continue;
    }
    const k = formatById.get(token.id)?.kind;
    out.push(token.t === 'open' ? { t: 'open', id, k } : { t: 'ph', id, k });
  }
  return out;
}

export type RemapResult =
  | { readonly ok: true; readonly tokens: readonly Token[] }
  | { readonly ok: false; readonly reason: string };

/**
 * A tag's kind *and* role: `other` names both hidden runs and hidden
 * placeholders (a spell-check marker, a drawing), so kind alone let the
 * Nth `other` placeholder of a match take the id of an `other` run and
 * render a `<w:r>` with no close (backlog #29).
 */
type Slot = `${'open' | 'ph'}:${TagKind}`;

/** Ordered ids of a token stream's `open`/`ph` tokens, grouped by slot. */
function idsBySlot(
  tokens: readonly (Token | TmToken)[],
  kindOf: (id: number) => TagKind | undefined,
): Map<Slot, number[]> {
  const queues = new Map<Slot, number[]>();
  for (const token of tokens) {
    if (token.t !== 'open' && token.t !== 'ph') continue;
    const kind = kindOf(token.id);
    if (!kind) continue;
    const slot: Slot = `${token.t}:${kind}`;
    const queue = queues.get(slot);
    if (queue) queue.push(token.id);
    else queues.set(slot, [token.id]);
  }
  return queues;
}

/**
 * Rebuilds a retrieved TM variant as project tokens, mapped onto the
 * *receiving* segment's own formatting by `(kind, order)`
 * (tm-format-spec.md §3): the Nth `bold` tag in the TM match takes the
 * fmt id of the Nth `bold` tag already present in `sourceTokens`. Pairs
 * and placeholders are counted apart, so a placeholder only ever takes a
 * placeholder's id and a pair a pair's.
 *
 * Succeeds only when every kind occurs exactly as many times in the
 * match as in the receiving segment's source — a real correspondence,
 * not a guess. A translator may legitimately restructure formatting
 * during translation, so any mismatch (extra, missing, or unhinted tags)
 * refuses rather than approximates: the caller's job is then the
 * `tm_exact_tagdiff` path (`v1-spec.md` §6.1) — target *text* only, tags
 * dropped, flagged for review. Never a guessed, possibly tag-invalid,
 * placement.
 */
export function remapTmTokens(
  tmTokens: readonly TmToken[],
  sourceTokens: readonly Token[],
  sourceFormats: readonly FormatEntry[],
): RemapResult {
  const sourceFormatById = new Map(sourceFormats.map((f) => [f.id, f]));
  const sourceQueues = idsBySlot(sourceTokens, (id) => sourceFormatById.get(id)?.kind);

  const tmSlotCounts = new Map<Slot, number>();
  for (const token of tmTokens) {
    if (token.t !== 'open' && token.t !== 'ph') continue;
    if (!token.k) {
      return { ok: false, reason: `tag ${token.id} in the match carries no kind hint` };
    }
    const slot: Slot = `${token.t}:${token.k}`;
    tmSlotCounts.set(slot, (tmSlotCounts.get(slot) ?? 0) + 1);
  }

  const allSlots = new Set<Slot>([...tmSlotCounts.keys(), ...sourceQueues.keys()]);
  for (const slot of allSlots) {
    const inMatch = tmSlotCounts.get(slot) ?? 0;
    const inSource = sourceQueues.get(slot)?.length ?? 0;
    if (inMatch !== inSource) {
      const [role, kind] = slot.split(':');
      return {
        ok: false,
        reason:
          `"${kind}" ${role === 'ph' ? 'placeholder' : 'pair'} occurs ${inMatch} ` +
          `time(s) in the match but ${inSource} time(s) in this segment's source — ` +
          `tags do not correspond`,
      };
    }
  }

  const cursors = new Map<Slot, number>();
  const remappedId = new Map<number, number>(); // TM tag id -> receiving fmt id
  const out: Token[] = [];
  for (const token of tmTokens) {
    if (token.t === 'text') {
      out.push(token);
      continue;
    }
    if (token.t === 'close') {
      const id = remappedId.get(token.id);
      if (id === undefined) {
        return {
          ok: false,
          reason: `close tag ${token.id} in the match has no matching open`,
        };
      }
      out.push({ t: 'close', id });
      continue;
    }
    const slot: Slot = `${token.t}:${token.k!}`; // every open/ph was hinted, checked above
    const queue = sourceQueues.get(slot)!; // counts matched, so this exists
    const cursor = cursors.get(slot) ?? 0;
    const id = queue[cursor]!;
    cursors.set(slot, cursor + 1);
    remappedId.set(token.id, id);
    out.push(token.t === 'open' ? { t: 'open', id, fmt: id } : { t: 'ph', id, fmt: id });
  }

  if (!validateTagStructure(out).ok) {
    return { ok: false, reason: 'remapping produced an invalid tag structure' };
  }
  return { ok: true, tokens: out };
}
