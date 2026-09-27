/**
 * Hidden tags in a target (v1-spec.md §7.2; backlog #29).
 *
 * The translator sees and places only visible tags (`FormatEntry.visible`,
 * §3.3). Everything else — the run properties that carry a paragraph's
 * font and size, spell-check markers, bookmarks, an anchored drawing, a
 * tracked deletion — is carried: every target written to a project
 * (`setSegmentTarget`) gets its source's hidden tags by one rule, here,
 * so the editor never has to show them and the delivered document does
 * not lose them.
 *
 * A target whose visible part is exactly the source's (a copy of the
 * source, a TM match of the same sentence) gets the source's own hidden
 * tags, where the source has them. Any other target is dressed per
 * *container* — the top level, and each visible pair it places — from
 * what the source had inside the same container:
 *
 * 1. **Plain formatting.** The source text directly inside the container
 *    (not in a nested visible pair) is attributed to its innermost run
 *    tag if that run is hidden, or to no run. Whichever covers the most
 *    characters is the container's plain formatting; when it is a hidden
 *    run, it wraps the container's whole target content. A visible run
 *    placed inside then nests in it, which the renderer resolves to the
 *    innermost run (`renderTokens`). Whitespace-only text counts only
 *    where there is nothing else: a space at a paragraph's edge decides
 *    nothing, but a container of nothing but spaces keeps their run.
 * 2. **Verbatim minorities.** A hidden run that lost (1) — a note number
 *    raised by hand, a checkbox in a symbol font — wraps an occurrence
 *    of its own text in the target's text of that container, when the
 *    translator kept it verbatim and it stands apart from the characters
 *    around it (`8` after a word, never inside `18`, nor in `1,8` or
 *    `8.5`) — the first such occurrence. A run that came after all of
 *    the container's other text, as a note number does, wraps only an
 *    occurrence that ends the container's target text, whatever
 *    punctuation follows: `2021.1` ends in a note number, not a decimal,
 *    and a `1` earlier in the sentence is never it.
 * 3. **Wrappers.** A hidden paired tag that is not a run (`w:ins`,
 *    `w:sdt`, `w:smartTag`) and encloses every character and every
 *    visible tag of its container's source encloses all of its target
 *    content — a tracked insertion of a whole sentence stays one in
 *    translation — unless the target places a visible tag there from
 *    outside it. One that left anything out is placed empty: which
 *    words of a translation "are" the inserted ones is not a question
 *    this can answer, and wrapping what it did not wrap would also put
 *    a link or a field, say, inside a tracked insertion, where OOXML
 *    allows neither.
 * 4. **Placeholders.** A hidden placeholder before all of its container's
 *    source text leads its target content (a bookmark start before a
 *    heading), and so does the start of a range (bookmark, comment,
 *    permission) whose end follows some text — a range grows to the whole
 *    sentence rather than collapse to nothing. Any other trails it.
 * 5. **Everything else** — a hidden run nothing matched, a partial
 *    wrapper — is placed empty at the end of its container. A hidden tag
 *    whose visible container the target does not place goes to the
 *    nearest enclosing container that it does.
 *
 * Leading and trailing tags sit just inside the wrapping ones, so a
 * dressed target begins with opens and ends with closes (see the dressing
 * below for why).
 *
 * So the target's hidden tags are exactly the source's, each once, even
 * for a target with no text: the tag rules (`tag.missing`, `tag.extra`)
 * only ever speak of tags the translator can see, and nothing hidden is
 * lost on export. Whatever hidden tags the given target carried are
 * discarded first, which makes the result a function of the visible
 * target alone — idempotent, whether the target was typed, matched from
 * a memory whose hidden tags were another document's, or copied.
 *
 * On the fixture corpus, retyping every segment's text with its tags in
 * place leaves 45 of 270,571 non-space characters in a font, size or
 * raise other than the source's (`project/carry.test.ts` pins it).
 */

import type { FormatEntry, Token } from './token.js';

type Open = Extract<Token, { t: 'open' }>;
type Tag = Exclude<Token, { t: 'text' }>;

/** The top level, as a container id: tag ids start at 1. */
const TOP = 0;

/**
 * Each tag token's format entry. A close takes its open's; a stray close
 * with no open falls back to its id, which is its open's `fmt` wherever a
 * segment's tokens are made (`renumberRegion`) and what `renderTokens`
 * looks tags up by.
 */
function formatsOf(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): (token: Tag) => FormatEntry | undefined {
  const byId = new Map(formats.map((f) => [f.id, f]));
  const openFmt = new Map<number, number>();
  for (const token of tokens) if (token.t === 'open') openFmt.set(token.id, token.fmt);
  return (token) =>
    byId.get(token.t === 'close' ? (openFmt.get(token.id) ?? token.id) : token.fmt);
}

/**
 * The tokens with every hidden tag removed — what the translator sees.
 * A tag whose format the table cannot explain counts as visible, the way
 * the grid shows it (v1-spec.md §7.1): hiding what nobody can account
 * for is how it would get lost.
 */
export function withoutHiddenTags(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): Token[] {
  const formatOf = formatsOf(tokens, formats);
  return tokens.filter((t) => t.t === 'text' || formatOf(t)?.visible !== false);
}

/**
 * Whether two targets are the same to the translator: the same visible
 * tags in the same places around the same text, however their text is
 * split into tokens and wherever their hidden tags sit. An edit that
 * changes nothing visible is not an edit (`editSegmentTarget`).
 */
export function sameVisibleTarget(
  a: readonly Token[],
  b: readonly Token[],
  formats: readonly FormatEntry[],
): boolean {
  return (
    JSON.stringify(joined(withoutHiddenTags(a, formats))) ===
    JSON.stringify(joined(withoutHiddenTags(b, formats)))
  );
}

/**
 * Whether a target is no translation at all: nothing visible but
 * whitespace. Hidden tags alone, or spaces, are nothing a reader would
 * call a translation — an edit leaving only that makes the segment
 * untranslated (`editSegmentTarget`), and confirm refuses it.
 */
export function isBlankTarget(
  tokens: readonly Token[] | null,
  formats: readonly FormatEntry[],
): boolean {
  return (tokens === null ? [] : withoutHiddenTags(tokens, formats)).every(
    (t) => t.t === 'text' && t.v.trim() === '',
  );
}

/** Text tokens joined, empty ones dropped: two streams that read the same compare equal. */
function joined(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const previous = out[out.length - 1];
    if (token.t === 'text' && token.v === '') continue;
    if (token.t === 'text' && previous?.t === 'text') {
      out[out.length - 1] = { t: 'text', v: previous.v + token.v };
    } else {
      out.push(token);
    }
  }
  return out;
}

/** A hidden tag of the source, and where it goes. */
interface Hidden {
  readonly open: Tag;
  /** The matching close, for a pair. */
  close?: Token;
  readonly entry: FormatEntry;
  /** Index of its open (or placeholder) token in the source. */
  readonly at: number;
  /** Index of its close in the source; `at` for a placeholder. */
  end: number;
  /** Innermost visible pair enclosing it, or {@link TOP}. */
  readonly container: number;
  /** The chain of visible pairs enclosing it, innermost first. */
  readonly ancestors: readonly number[];
  /** For a run: the non-whitespace text directly inside it, trimmed. */
  text: string;
}

const RANGE_START = /^<w:(bookmark|commentRange|perm)Start\b[^>]*\bw:id="([^"]*)"/;
const RANGE_END = /^<w:(bookmark|commentRange|perm)End\b[^>]*\bw:id="([^"]*)"/;

/** Letter, number, or anything else: where a verbatim match may stand. */
const charClass = (ch: string | undefined): 'L' | 'N' | 'O' | null =>
  ch === undefined ? null : /\p{L}/u.test(ch) ? 'L' : /\p{N}/u.test(ch) ? 'N' : 'O';

/**
 * What joins the digits of one number: a decimal or thousands separator
 * (a no-break, narrow no-break or thin space among them), a time, a
 * fraction, a range.
 */
const NUMBER_JOINER = /[.,:/'\u2019\u00A0\u202F\u2009-]/;

/**
 * Every index where `needle` stands apart in `text`: not glued to a
 * character of the same class as its own edge, so `8` is found after a
 * word but not inside `18`, and `Nota` not inside `Notable`. A digit
 * edge is glued through a separator to a digit beyond it too: `1` is
 * part of `1,5` and of `1.000`, not a note number beside them.
 */
function findApart(text: string, needle: string): number[] {
  const first = charClass(needle[0]);
  const last = charClass(needle[needle.length - 1]);
  const gluedAt = (edge: 'L' | 'N' | 'O' | null, at: number, step: 1 | -1): boolean =>
    edge !== 'O' &&
    (charClass(text[at]) === edge ||
      (edge === 'N' &&
        NUMBER_JOINER.test(text[at] ?? '') &&
        charClass(text[at + step]) === 'N'));
  const found: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    if (!gluedAt(first, i - 1, -1) && !gluedAt(last, i + needle.length, 1)) found.push(i);
  }
  return found;
}

/**
 * Where `needle` ends `text` — nothing but spaces and punctuation after
 * it — standing apart from what comes before it, or -1. A separator
 * does not glue it here: what ends a sentence after `2021.` is not
 * another digit of 2021.
 */
function findEnding(text: string, needle: string): number {
  const at = text.lastIndexOf(needle);
  if (at < 0 || !/^[\s\p{P}]*$/u.test(text.slice(at + needle.length))) return -1;
  const first = charClass(needle[0]);
  return first !== 'O' && charClass(text[at - 1]) === first ? -1 : at;
}

/**
 * The target with its source's hidden tags carried by the rule above.
 * `formats` is the segment's format table, which source and target share.
 */
export function carryHiddenTags(
  target: readonly Token[],
  source: readonly Token[],
  formats: readonly FormatEntry[],
): Token[] {
  if (sameVisibleTarget(target, source, formats)) return [...source];
  // Text joined: whether a minority's text stands apart is read across
  // the whole run of text, never cut short where a hidden tag once split
  // it — which is also what keeps the rule idempotent.
  const visible = joined(withoutHiddenTags(target, formats));

  // --- the source: containers, hidden tags, plain-formatting coverage ---
  const formatOf = formatsOf(source, formats);
  const hidden: Hidden[] = [];
  const openHidden = new Map<number, Hidden>();
  /** Visible pairs of the source by id, with their extent. */
  const pairs = new Map<number, { at: number; end: number }>();
  /** Per container: characters per plain formatting (hidden run id, or TOP for none). */
  const coverage = new Map<number, Map<number, number>>();
  /** The same for whitespace-only text, which decides only where nothing else does. */
  const blankCoverage = new Map<number, Map<number, number>>();
  /** Indexes of text tokens that are more than whitespace. */
  const textAt: number[] = [];
  /** Per container: indexes of the visible tags directly in it. */
  const visibleTagsIn = new Map<number, number[]>();
  /** Each visible tag's index in the source (its open, for a pair). */
  const visibleAt = new Map<number, number>();
  const noteVisible = (container: number, at: number) =>
    visibleTagsIn.set(container, [...(visibleTagsIn.get(container) ?? []), at]);

  const stack: Array<{ token: Open; entry: FormatEntry | undefined }> = [];
  const visibleChain = (): number[] => {
    const chain: number[] = [];
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.entry?.visible !== false) chain.push(stack[i]!.token.id);
    }
    return chain;
  };

  source.forEach((token, at) => {
    if (token.t === 'text') {
      const blank = token.v.trim() === '';
      if (!blank) textAt.push(at);
      const container = visibleChain()[0] ?? TOP;
      let run: { token: Open; entry: FormatEntry | undefined } | undefined;
      for (let i = stack.length - 1; i >= 0 && !run; i--) {
        if (stack[i]!.entry?.placement === 'run') run = stack[i];
      }
      // Text in a visible run is formatted by a tag the translator places.
      if (run && run.entry?.visible !== false) return;
      const key = run ? run.token.id : TOP;
      const table = blank ? blankCoverage : coverage;
      const counts = table.get(container) ?? new Map<number, number>();
      counts.set(
        key,
        (counts.get(key) ?? 0) + (blank ? token.v.length : token.v.trim().length),
      );
      table.set(container, counts);
      const record = run && openHidden.get(run.token.id);
      if (record && !blank) record.text += token.v;
      return;
    }
    const entry = formatOf(token);
    if (token.t === 'close') {
      const top = stack.pop();
      if (top && entry?.visible === false) {
        const record = openHidden.get(top.token.id);
        if (record) {
          record.close = token;
          record.end = at;
          record.text = record.text.trim();
        }
      } else if (top) {
        const pair = pairs.get(top.token.id);
        if (pair) pair.end = at;
        noteVisible(visibleChain()[0] ?? TOP, at);
      }
      return;
    }
    if (entry?.visible !== false) {
      noteVisible(visibleChain()[0] ?? TOP, at);
      visibleAt.set(token.id, at);
    }
    if (entry?.visible === false) {
      const chain = visibleChain();
      const record: Hidden = {
        open: token,
        entry,
        at,
        end: at,
        container: chain[0] ?? TOP,
        ancestors: chain,
        text: '',
      };
      hidden.push(record);
      if (token.t === 'open') openHidden.set(token.id, record);
    } else if (token.t === 'open') {
      pairs.set(token.id, { at, end: source.length });
    }
    if (token.t === 'open') stack.push({ token, entry });
  });

  /** First and last source text index inside a container, if it has any. */
  const textSpan = (container: number): readonly [number, number] | null => {
    const extent =
      container === TOP ? { at: -1, end: source.length } : pairs.get(container);
    if (!extent) return null;
    const inside = textAt.filter((i) => i > extent.at && i < extent.end);
    return inside.length ? [inside[0]!, inside[inside.length - 1]!] : null;
  };

  /** A range start whose end follows it in the same container, text between. */
  const startsARange = (tag: Hidden): boolean => {
    const start = RANGE_START.exec(tag.entry.open);
    if (!start) return false;
    const end = hidden.find((other) => {
      const m = RANGE_END.exec(other.entry.open);
      return m !== null && m[1] === start[1] && m[2] === start[2];
    });
    return (
      end !== undefined &&
      end.container === tag.container &&
      textAt.some((i) => i > tag.at && i < end.at)
    );
  };

  // --- which containers the target places ---
  const placed = new Set<number>([TOP]);
  for (const token of visible) {
    if (token.t === 'open' && pairs.has(token.id)) placed.add(token.id);
  }

  /** Each visible tag the target places, and the container it is directly in. */
  const targetHome = new Map<number, number>();
  {
    const chain: number[] = [TOP];
    for (const token of visible) {
      if (token.t === 'text') continue;
      if (token.t === 'close') {
        chain.pop();
        continue;
      }
      targetHome.set(token.id, chain[chain.length - 1]!);
      if (token.t === 'open') {
        chain.push(placed.has(token.id) ? token.id : chain[chain.length - 1]!);
      }
    }
  }
  /** Whether every visible tag the target places directly in `home` was inside `tag`. */
  const holdsWhatTargetPlaces = (tag: Hidden, home: number): boolean =>
    [...targetHome].every(([id, where]) => {
      if (where !== home) return true;
      const at = visibleAt.get(id);
      return at !== undefined && at > tag.at && at < tag.end;
    });

  interface Plan {
    lead: Token[];
    wrappers: Hidden[];
    run: Hidden | null;
    minorities: Hidden[];
    /** Carried at the container's end, in source order. */
    rest: Hidden[];
  }
  const plans = new Map<number, Plan>();
  const planFor = (container: number): Plan => {
    let plan = plans.get(container);
    if (!plan) {
      plan = { lead: [], wrappers: [], run: null, minorities: [], rest: [] };
      plans.set(container, plan);
    }
    return plan;
  };

  const dominant = (container: number): number => {
    let best = TOP;
    let most = 0;
    // A Map iterates in insertion order, which is source order: ties go
    // to whichever formatting came first.
    const counts = coverage.get(container) ?? blankCoverage.get(container);
    for (const [key, chars] of counts ?? []) {
      if (chars > most) {
        best = key;
        most = chars;
      }
    }
    return best;
  };

  for (const tag of hidden) {
    const home = tag.ancestors.find((id) => placed.has(id)) ?? TOP;
    const plan = planFor(home);
    // Displaced from an unplaced container: nothing about its position
    // survives, so it is simply carried.
    if (home !== tag.container) {
      plan.rest.push(tag);
      continue;
    }
    const span = textSpan(home);
    if (tag.open.t === 'ph') {
      if ((span && tag.at < span[0]) || startsARange(tag)) plan.lead.push(tag.open);
      else plan.rest.push(tag);
    } else if (tag.entry.placement === 'run') {
      if (plan.run === null && dominant(home) === tag.open.id) plan.run = tag;
      else plan.minorities.push(tag);
    } else if (
      span &&
      tag.at < span[0] &&
      tag.end > span[1] &&
      (visibleTagsIn.get(home) ?? []).every((i) => i > tag.at && i < tag.end) &&
      holdsWhatTargetPlaces(tag, home)
    ) {
      plan.wrappers.push(tag);
    } else {
      plan.rest.push(tag);
    }
  }

  // --- verbatim minorities: find each one's text in its container ---
  /** Per visible text token index: the runs to wrap around parts of it. */
  const claims = new Map<number, Array<{ at: number; run: Hidden }>>();
  {
    const containerOf: number[] = [];
    const chain: number[] = [TOP];
    const inVisibleRun: boolean[] = [];
    const runDepth: number[] = [0];
    const formatOfVisible = formatsOf(visible, formats);
    visible.forEach((token, i) => {
      if (token.t === 'open') {
        chain.push(placed.has(token.id) ? token.id : chain[chain.length - 1]!);
        runDepth.push(
          runDepth[runDepth.length - 1]! +
            (formatOfVisible(token)?.placement === 'run' ? 1 : 0),
        );
      } else if (token.t === 'close') {
        chain.pop();
        runDepth.pop();
      }
      containerOf[i] = chain[chain.length - 1]!;
      inVisibleRun[i] = runDepth[runDepth.length - 1]! > 0;
    });
    for (const [container, plan] of plans) {
      const kept: Hidden[] = [];
      const span = textSpan(container);
      for (const run of plan.minorities) {
        const candidates: Array<{ i: number; at: number }> = [];
        // Nothing of the container's source text came after this run: a
        // note number, most likely, which ends its sentence in any
        // language — so only where the container's target text ends.
        const trailing = span !== null && span[1] < run.end;
        let last = -1;
        visible.forEach((token, i) => {
          if (token.t === 'text' && containerOf[i] === container) last = i;
        });
        if (run.text !== '') {
          visible.forEach((token, i) => {
            if (token.t !== 'text' || containerOf[i] !== container || inVisibleRun[i]) {
              return;
            }
            if (!trailing) {
              for (const at of findApart(token.v, run.text)) candidates.push({ i, at });
            } else if (i === last) {
              const at = findEnding(token.v, run.text);
              if (at >= 0) candidates.push({ i, at });
            }
          });
        }
        const free = candidates.find(
          ({ i, at }) =>
            !(claims.get(i) ?? []).some(
              (c) => at < c.at + c.run.text.length && c.at < at + run.text.length,
            ),
        );
        if (free) {
          claims.set(
            free.i,
            [...(claims.get(free.i) ?? []), { at: free.at, run }].sort(
              (a, b) => a.at - b.at,
            ),
          );
        } else {
          kept.push(run);
        }
      }
      // Unmatched minorities are carried empty, with the rest.
      plan.rest.push(...kept);
    }
  }

  // --- the target: each placed container's content, dressed ---
  // Leading and trailing tags go inside the wrapping pairs, so a dressed
  // target begins with opens and ends with closes. That is what lets
  // export's fold (`mergeSegments`) fuse two neighbouring sentences'
  // identical runs and put the space it inserts between them inside the
  // paragraph's formatting, not in a bare run of its own. The render is
  // the same either way: a paragraph-level tag closes the run around it.
  const opening = (plan: Plan): Token[] => [
    ...plan.wrappers.map((w) => w.open),
    ...(plan.run ? [plan.run.open] : []),
    ...plan.lead,
  ];
  const closing = (plan: Plan): Token[] => [
    ...plan.rest
      .sort((a, b) => a.at - b.at)
      .flatMap((tag) => [tag.open, ...(tag.close ? [tag.close] : [])]),
    ...(plan.run?.close ? [plan.run.close] : []),
    ...plan.wrappers
      .map((w) => w.close)
      .filter((t): t is Token => t !== undefined)
      .reverse(),
  ];
  const text = (i: number, v: string): Token[] => {
    const taken = claims.get(i);
    if (!taken) return [{ t: 'text', v }];
    const out: Token[] = [];
    let from = 0;
    for (const { at, run } of taken) {
      if (at > from) out.push({ t: 'text', v: v.slice(from, at) });
      out.push(run.open, { t: 'text', v: run.text }, ...(run.close ? [run.close] : []));
      from = at + run.text.length;
    }
    if (from < v.length) out.push({ t: 'text', v: v.slice(from) });
    return out;
  };

  const out: Token[] = [];
  const top = plans.get(TOP);
  if (top) out.push(...opening(top));
  // Each container is dressed once, even in a target that (invalidly)
  // places its pair twice: a hidden tag is carried exactly once.
  const opened = new Set<number>();
  const closed = new Set<number>();
  visible.forEach((token, i) => {
    if (token.t === 'text') {
      out.push(...text(i, token.v));
      return;
    }
    if (token.t === 'close' && opened.has(token.id) && !closed.has(token.id)) {
      closed.add(token.id);
      out.push(...closing(planFor(token.id)), token);
      return;
    }
    out.push(token);
    if (token.t === 'open' && placed.has(token.id) && !opened.has(token.id)) {
      opened.add(token.id);
      out.push(...opening(planFor(token.id)));
    }
  });
  if (top) out.push(...closing(top));
  return out;
}
