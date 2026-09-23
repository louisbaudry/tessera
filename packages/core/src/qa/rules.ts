/**
 * QA rule registry and rule checks. See `planning/v1-spec.md` §6.4.
 *
 * A check is pure: tokens in, findings out, no DB and no project in the
 * loop, same headless rule as the rest of `core`. `db/project/qa-issues.ts`
 * is where a finding becomes a persisted, dismissible `qa_issue` row.
 */

import { DEFAULT_SEVERITY, type QaRule, type QaSeverity } from '../model/qa.js';
import type { SegmentStatus } from '../model/segment.js';
import { extraTags, missingTags, validateTagStructure } from '../model/tags.js';
import { plainText, type AnyToken } from '../model/token.js';
import {
  GROUPING_SPACES,
  numberFormatFor,
  spacingProfileFor,
  usesInvertedMarks,
} from './locale.js';
import { compareNumerals, extractNumerals, type Numeral } from './numbers.js';

export interface QaFinding {
  readonly rule: QaRule;
  readonly severity: QaSeverity;
  readonly message: string;
}

/**
 * Project-wide sibling data for `consistency.*` (backlog #23) — other
 * segments' rendered text, keyed the two ways those rules need. Omitted
 * (`undefined`) when a check runs with no project in the loop, e.g. a
 * bare `{source, target}` context in a unit test; the consistency checks
 * below simply report nothing in that case, same as a missing `target`.
 */
export interface QaSiblingContext {
  /** Other segments sharing this segment's `source_hash`, rendered target
   *  plain text, excluding any equal to this segment's own target. */
  readonly sameSourceOtherTargets: readonly string[];
  /** Other segments whose rendered target plain text equals this
   *  segment's own, rendered *source* plain text, excluding any sharing
   *  this segment's `source_hash`. */
  readonly sameTargetOtherSources: readonly string[];
}

/**
 * What a check needs. `source`/`target` cover the tag rules; later fields
 * are optional and added as a later rule needs them (backlog #23) —
 * existing checks never have to widen their own signature to match,
 * since each check only destructures what it uses.
 */
export interface QaCheckContext {
  readonly source: readonly AnyToken[];
  readonly target: readonly AnyToken[] | null;
  /** Needed by `seg.empty`. */
  readonly status?: SegmentStatus;
  /** Per-project allow-list suppression for `seg.untranslated`, keyed by
   *  this segment's `source_hash` (backlog #23). */
  readonly untranslatedAllowed?: boolean;
  /** Needed by `consistency.*`. */
  readonly siblings?: QaSiblingContext;
  /**
   * The project's languages, BCP-47 (backlog #24). `num.*` needs both
   * and reports nothing without them — "locale-aware" is meaningless
   * with no locale, and a guess is exactly the false positive those
   * rules exist to avoid. `punct.inverted` and the French half of
   * `punct.spacing` need `tgtLang` the same way.
   */
  readonly srcLang?: string;
  readonly tgtLang?: string;
}

export type QaCheck = (context: QaCheckContext) => readonly QaFinding[];

/**
 * One finding per rule per segment, not one per tag id.
 *
 * `qa_issue` has no column for "which occurrence," and the QA panel
 * (backlog #33) filters and jumps by rule, not by individual tag — so a
 * segment missing three tags is one actionable row, not three, with every
 * id named in its message. This also keeps dismissal keyed by `(segment,
 * rule)` meaningful: dismissing "tag.missing" dismisses the segment's tag
 * problem, not one of several near-duplicate rows.
 */
const summarise = (label: string, ids: readonly number[]): string =>
  `${label}${ids.length > 1 ? 's' : ''}: ${ids.join(', ')}`;

/**
 * Fires when a target is missing a tag the source has. Never fires with
 * no target at all — that is `seg.empty`'s job (backlog #23), not this
 * rule's; a segment with no target has nothing to compare yet.
 */
const checkTagMissing: QaCheck = ({ source, target }) => {
  if (target === null) return [];
  const missing = missingTags(source, target);
  const ids = [...missing.pairs, ...missing.placeholders].sort((a, b) => a - b);
  if (ids.length === 0) return [];
  return [
    {
      rule: 'tag.missing',
      severity: DEFAULT_SEVERITY['tag.missing'],
      message: summarise('Missing tag', ids),
    },
  ];
};

/** Fires when a target carries a tag the source never had. */
const checkTagExtra: QaCheck = ({ source, target }) => {
  if (target === null) return [];
  const extra = extraTags(source, target);
  const ids = [...extra.pairs, ...extra.placeholders].sort((a, b) => a - b);
  if (ids.length === 0) return [];
  return [
    {
      rule: 'tag.extra',
      severity: DEFAULT_SEVERITY['tag.extra'],
      message: summarise('Extra tag', ids),
    },
  ];
};

/**
 * Fires when the target's tags are not well-formed — unclosed, closed
 * without an open, or interleaved.
 *
 * Source is never checked: `assembleFile`'s own corpus-wide invariant
 * (backlog #9) guarantees every source tokenises validly, and re-checking
 * it here would be dead code with no failing input to ever prove it. A
 * target can still go bad, because `setSegmentTarget` (backlog #16)
 * writes whatever tokens it is given with no structural validation of
 * its own — this rule is the QA-time backstop for that gap, not a
 * duplicate of `renderTokens`'s own export-time rejection (backlog #10),
 * which only ever sees a target after this rule has already run.
 */
const checkTagUnbalanced: QaCheck = ({ target }) => {
  if (target === null) return [];
  const structure = validateTagStructure(target);
  if (structure.ok) return [];
  const described = structure.errors
    .map((e) => {
      switch (e.code) {
        case 'unclosed':
          return `tag ${e.id} never closed`;
        case 'close-without-open':
          return `tag ${e.id} closed without being opened`;
        case 'interleaved':
          return `tag ${e.id} closes across tag ${e.expected}`;
        case 'duplicate-open':
          return `tag ${e.id} opened twice`;
        case 'duplicate-ph':
          return `placeholder ${e.id} used twice`;
      }
    })
    .join('; ');
  return [
    {
      rule: 'tag.unbalanced',
      severity: DEFAULT_SEVERITY['tag.unbalanced'],
      message: described,
    },
  ];
};

/**
 * Statuses `seg.empty` fires for. Not `SEGMENT_STATUSES`' array order read
 * as "≥ translated" (`v1-spec.md` §6.4's wording) — `locked` sorts after
 * `confirmed` in that array but *means* "not editable — untranslatable
 * content, or locked by the user" (`model/segment.ts`), and a locked
 * segment is deliberately allowed an empty target. An explicit set avoids
 * turning every locked-and-empty segment — the common untranslatable-
 * content case — into a false positive.
 */
const SEG_EMPTY_FIRING_STATUSES: ReadonlySet<SegmentStatus> = new Set([
  'translated',
  'confirmed',
]);

/** Fires when a translated-or-confirmed segment has no (or blank) target. */
const checkSegEmpty: QaCheck = ({ target, status }) => {
  if (status === undefined || !SEG_EMPTY_FIRING_STATUSES.has(status)) return [];
  const text = target === null ? '' : plainText(target);
  if (text.trim().length > 0) return [];
  return [
    {
      rule: 'seg.empty',
      severity: DEFAULT_SEVERITY['seg.empty'],
      message: 'Target is empty',
    },
  ];
};

/**
 * Fires when the target is character-for-character identical to the
 * source. Suppressed when the source has no letters at all (numbers,
 * punctuation, a lone tag — nothing to translate) or when the segment's
 * `source_hash` is on the project's allow-list (`untranslatedAllowed`).
 */
const checkSegUntranslated: QaCheck = ({ source, target, untranslatedAllowed }) => {
  if (target === null || untranslatedAllowed) return [];
  const sourceText = plainText(source);
  if (!/\p{L}/u.test(sourceText)) return [];
  if (plainText(target) !== sourceText) return [];
  return [
    {
      rule: 'seg.untranslated',
      severity: DEFAULT_SEVERITY['seg.untranslated'],
      message: 'Target is identical to source',
    },
  ];
};

/** Fires when the same source elsewhere in the project was translated differently. */
const checkConsistencyTargetDiffers: QaCheck = ({ target, siblings }) => {
  if (target === null || !siblings) return [];
  const own = plainText(target);
  const differing = [
    ...new Set(siblings.sameSourceOtherTargets.filter((t) => t !== own)),
  ];
  if (differing.length === 0) return [];
  return [
    {
      rule: 'consistency.target_differs',
      severity: DEFAULT_SEVERITY['consistency.target_differs'],
      message: `Same source translated differently elsewhere: ${differing.join(' | ')}`,
    },
  ];
};

/** Fires when the same target rendering elsewhere in the project came from a different source. */
const checkConsistencySourceDiffers: QaCheck = ({ target, siblings }) => {
  if (target === null || !siblings) return [];
  const distinct = [...new Set(siblings.sameTargetOtherSources)];
  if (distinct.length === 0) return [];
  return [
    {
      rule: 'consistency.source_differs',
      severity: DEFAULT_SEVERITY['consistency.source_differs'],
      message: `Same rendering used for a different source elsewhere: ${distinct.join(' | ')}`,
    },
  ];
};

/**
 * Stands in for a placeholder tag in {@link visibleText}: U+FFFC OBJECT
 * REPLACEMENT CHARACTER, which is what it means, and which is neither a
 * digit, a space nor punctuation, so no rule below can see through it.
 */
const PLACEHOLDER_CHAR = '\uFFFC';

/**
 * The segment as the reader sees it, for the `num.*`/`punct.*` rules —
 * unlike {@link plainText}, which is what *matching* needs. Paired tags
 * are formatting and vanish, but a placeholder is content: a tab, a
 * line break, a footnote reference, an image. Dropping it would glue
 * `1<tab>000` into one number and read `word<br> word` as a double
 * space, so each becomes one opaque character instead.
 */
function visibleText(tokens: readonly AnyToken[]): string {
  let out = '';
  for (const token of tokens) {
    if (token.t === 'text') out += token.v;
    else if (token.t === 'ph') out += PLACEHOLDER_CHAR;
  }
  return out;
}

const listSurfaces = (numerals: readonly Numeral[]): string =>
  numerals.map((n) => n.surface).join(', ');

/**
 * Runs the locale-aware numeral comparison (`qa/numbers.ts`) once for
 * both `num.*` rules. `null` when either language is missing: with no
 * locale there is no way to say whether `1,000` and `1 000` are the same
 * number, and guessing is the false positive these rules exist to avoid.
 */
const compareSegmentNumerals = ({ source, target, srcLang, tgtLang }: QaCheckContext) => {
  if (target === null || srcLang === undefined || tgtLang === undefined) return null;
  return compareNumerals(
    extractNumerals(visibleText(source), numberFormatFor(srcLang)),
    extractNumerals(visibleText(target), numberFormatFor(tgtLang)),
  );
};

/** Fires when a source number has no counterpart in the target by surface, value, digits or components. */
const checkNumMissing: QaCheck = (context) => {
  const comparison = compareSegmentNumerals(context);
  if (comparison === null || comparison.missing.length === 0) return [];
  return [
    {
      rule: 'num.missing',
      severity: DEFAULT_SEVERITY['num.missing'],
      message: `Missing number${comparison.missing.length > 1 ? 's' : ''}: ${listSurfaces(comparison.missing)}`,
    },
  ];
};

/**
 * Fires when a source number is present in the target only by its digits
 * — its separators were changed to something the target locale does not
 * write (`1,000` → `1 000` in an English target). A correct localisation
 * (`1,000.50` → `1 000,50` in French) matches by value and never fires.
 */
const checkNumAltered: QaCheck = (context) => {
  const comparison = compareSegmentNumerals(context);
  if (comparison === null || comparison.altered.length === 0) return [];
  const pairs = comparison.altered.map((a) => `${a.from.surface} \u2192 ${a.to.surface}`);
  return [
    {
      rule: 'num.altered',
      severity: DEFAULT_SEVERITY['num.altered'],
      message: `Number${pairs.length > 1 ? 's' : ''} reformatted: ${pairs.join('; ')}`,
    },
  ];
};

const TERMINAL_MARKS: ReadonlySet<string> = new Set(['.', '!', '?', '\u2026']);

/**
 * Closing quotes and brackets, whitespace and placeholders that may
 * legitimately follow a sentence's final mark — `He said "Go."`, `(see
 * §3.)`, a trailing footnote reference — and are skipped to find it.
 * Which quote closes is the locale's: German closes `„…“` with U+201C
 * and `‚…‘` with U+2018, the marks English *opens* with, and closes its
 * reversed guillemets `»…«` with U+00AB — so every quote mark that
 * closes somewhere is listed, whatever it means elsewhere. (The golden
 * end-to-end test, backlog #26, was the first thing to end a German
 * sentence with `.“` and be told it had no full stop.)
 */
const TRAILING_AFTER_TERMINAL = new RegExp(
  `[\\s${PLACEHOLDER_CHAR}"'\\u201C\\u201D\\u2018\\u2019\\u00AB\\u00BB\\u2039\\u203A)\\]}]+$`,
  'u',
);

/** The final `.` `!` `?` `…` of a text, or `null` when it ends otherwise. */
function terminalMark(text: string): string | null {
  const trimmed = text.replace(TRAILING_AFTER_TERMINAL, '');
  const last = trimmed.at(-1);
  return last !== undefined && TERMINAL_MARKS.has(last) ? last : null;
}

/**
 * Fires when one side ends in a sentence-final mark and the other does
 * not. Presence only, not which mark: a source `?` rendered with a `.`
 * is a translation choice, a dropped full stop is not.
 */
const checkPunctTerminal: QaCheck = ({ source, target }) => {
  if (target === null) return [];
  const targetText = visibleText(target);
  if (targetText.trim().length === 0) return [];
  const sourceMark = terminalMark(visibleText(source));
  const targetMark = terminalMark(targetText);
  if ((sourceMark === null) === (targetMark === null)) return [];
  return [
    {
      rule: 'punct.terminal',
      severity: DEFAULT_SEVERITY['punct.terminal'],
      message:
        sourceMark !== null
          ? `Source ends with "${sourceMark}" but target does not`
          : `Target ends with "${targetMark}" but source does not`,
    },
  ];
};

/**
 * Bracket and quote families `punct.brackets` counts. Guillemets are a
 * counted pair rather than a nested one because German writes them
 * reversed (`»Wort«`) — equal counts hold either way. The curly double
 * quotes are one parity family for the same reason: English closes `“`
 * with `”`, German closes `„` with `“`, Dutch closes `„` with `”`, and
 * every one of those is an even number of marks.
 */
const COUNTED_PAIRS: readonly { readonly open: string; readonly close: string }[] = [
  { open: '(', close: ')' },
  { open: '[', close: ']' },
  { open: '{', close: '}' },
  { open: '\u00AB', close: '\u00BB' },
];
const PARITY_FAMILIES: readonly { readonly chars: string; readonly label: string }[] = [
  { chars: '"', label: '"' },
  { chars: '\u201C\u201D\u201E', label: '\u201C\u201D' },
];

/**
 * A leading list enumerator — `a)`, `12)` — is not a bracket. Stripped
 * before counting so a target that keeps the source's `a) Apples` style
 * never reports its lone `)`.
 */
const LEADING_ENUMERATOR = /^\s*[0-9A-Za-z]{1,2}\)/u;

const countChar = (text: string, char: string): number => text.split(char).length - 1;

interface BracketImbalance {
  readonly label: string;
  readonly detail: string;
}

/** Every family out of balance in `text`, keyed by a label stable across source and target. */
function bracketImbalances(text: string): Map<string, BracketImbalance> {
  const body = text.replace(LEADING_ENUMERATOR, '');
  const out = new Map<string, BracketImbalance>();
  for (const { open, close } of COUNTED_PAIRS) {
    const opened = countChar(body, open);
    const closed = countChar(body, close);
    if (opened !== closed) {
      out.set(`${open}${close}`, {
        label: `${open}${close}`,
        detail: `${opened} \u00D7 ${open}, ${closed} \u00D7 ${close}`,
      });
    }
  }
  for (const { chars, label } of PARITY_FAMILIES) {
    const total = [...chars].reduce((n, c) => n + countChar(body, c), 0);
    if (total % 2 !== 0) {
      out.set(label, { label, detail: `${total} \u00D7 ${label}` });
    }
  }
  return out;
}

/**
 * Fires when a bracket or quote family is unbalanced in the target —
 * unless the source has the identical imbalance. A segment split
 * mid-parenthesis, an emoticon, a `1)` list item: whatever left the
 * source unbalanced was there before the translator, and a target that
 * faithfully mirrors it is not the error this rule is for.
 */
const checkPunctBrackets: QaCheck = ({ source, target }) => {
  if (target === null) return [];
  const targetImbalances = bracketImbalances(visibleText(target));
  if (targetImbalances.size === 0) return [];
  const sourceImbalances = bracketImbalances(visibleText(source));
  const reported = [...targetImbalances.values()].filter(
    (t) => sourceImbalances.get(t.label)?.detail !== t.detail,
  );
  if (reported.length === 0) return [];
  return [
    {
      rule: 'punct.brackets',
      severity: DEFAULT_SEVERITY['punct.brackets'],
      message: `Unbalanced: ${reported.map((r) => r.detail).join('; ')}`,
    },
  ];
};

/** What may legitimately follow a sentence mark: whitespace, a closing mark, another mark. */
const MARK_FOLLOWER = new RegExp(
  `^[\\s${PLACEHOLDER_CHAR}"'\\u201D\\u2019\\u00BB)\\]}.,;:!?\\u2026]$`,
  'u',
);
const WORD_CHAR = /^[\p{L}\p{N}]$/u;

/**
 * Whether a mark followed by `after` is a sentence mark rather than part
 * of a token: `10:30`, `http://`, `page?id=3` all put something
 * word-like right after the mark, and none of them is what a spacing
 * rule is for. End of text counts as a sentence mark.
 */
const isSentenceMark = (after: string | undefined): boolean =>
  after === undefined || MARK_FOLLOWER.test(after);

/**
 * Fires, for a Spanish target only, on a closing `?` or `!` with no
 * opening `¿` or `¡` to match. Counted in *runs*, not characters, so
 * `¡¿Qué?!` and an emphatic `¡Hola!!!` balance — one opening run of
 * each mark against one closing run of each; and only a closing run in
 * sentence position counts, so a URL's `?` is not one.
 */
const checkPunctInverted: QaCheck = ({ target, tgtLang }) => {
  if (target === null || !usesInvertedMarks(tgtLang)) return [];
  const text = visibleText(target);
  // Only a run in sentence position closes anything: the `?` in
  // `https://example.com/?id=42` is not a question.
  const closing = [...text.matchAll(/[?!]+/gu)]
    .filter((m) => {
      const next = text.codePointAt(m.index + m[0].length);
      return isSentenceMark(next === undefined ? undefined : String.fromCodePoint(next));
    })
    .map((m) => m[0]);
  const opening = text.match(/[\u00BF\u00A1]+/gu) ?? [];
  const countRunsWith = (list: readonly string[], mark: string): number =>
    list.filter((run) => run.includes(mark)).length;
  const problems: string[] = [];
  if (countRunsWith(closing, '?') > countRunsWith(opening, '\u00BF')) {
    problems.push('? without \u00BF');
  }
  if (countRunsWith(closing, '!') > countRunsWith(opening, '\u00A1')) {
    problems.push('! without \u00A1');
  }
  if (problems.length === 0) return [];
  return [
    {
      rule: 'punct.inverted',
      severity: DEFAULT_SEVERITY['punct.inverted'],
      message: problems.join('; '),
    },
  ];
};

const ANY_SPACE: ReadonlySet<string> = new Set(GROUPING_SPACES);
const DOUBLE_SPACE = new RegExp(`[${GROUPING_SPACES.join('')}]{2,}`, 'u');

/**
 * Fires on a double space, a space before `,` `.` (and `;` `:` outside
 * French), and — for a French target — on `;` `:` `!` `?` `»` not
 * preceded by a no-break space or `«` not followed by one. Which marks
 * take which spacing is the target locale's (`qa/locale.ts`), never the
 * source's: a French source's `mot :` copied into an English target is
 * exactly the space-before-colon this rule reports.
 */
const checkPunctSpacing: QaCheck = ({ target, tgtLang }) => {
  if (target === null) return [];
  const text = visibleText(target);
  // A blank target is `seg.empty`'s finding, not a run of spaces.
  if (text.trim().length === 0) return [];
  const profile = spacingProfileFor(tgtLang);
  const problems: string[] = [];

  if (DOUBLE_SPACE.test(text)) problems.push('double space');

  const chars = [...text];
  chars.forEach((char, i) => {
    const before = chars[i - 1];
    const after = chars[i + 1];
    if (
      profile.noSpaceBefore.has(char) &&
      before !== undefined &&
      ANY_SPACE.has(before)
    ) {
      // `wait ...` is a style, not a stray space; only the first dot of a
      // run is preceded by the space, so skip a dot that starts one.
      if (char === '.' && after === '.') return;
      problems.push(`space before "${char}"`);
    }
    if (profile.noBreakSpaceBefore.has(char) && isSentenceMark(after)) {
      if (before !== undefined && before === ' ') {
        problems.push(`plain space before "${char}" (expected a no-break space)`);
      } else if (before !== undefined && WORD_CHAR.test(before)) {
        problems.push(`no space before "${char}" (expected a no-break space)`);
      }
    }
    if (profile.noBreakSpaceAfter.has(char)) {
      if (after === ' ') {
        problems.push(`plain space after "${char}" (expected a no-break space)`);
      } else if (after !== undefined && WORD_CHAR.test(after)) {
        problems.push(`no space after "${char}" (expected a no-break space)`);
      }
    }
  });

  if (problems.length === 0) return [];
  return [
    {
      rule: 'punct.spacing',
      severity: DEFAULT_SEVERITY['punct.spacing'],
      message: [...new Set(problems)].join('; '),
    },
  ];
};

/**
 * Every rule this build knows how to check, keyed by `QaRule` so a
 * project's enabled set (backlog #22's per-project switches) can select
 * a subset directly rather than filtering an array by field. Every
 * `QaRule` has an entry as of backlog #24; `runQaChecks` below still
 * runs whatever this record defines and ignores what it doesn't, so a
 * rule added to `QA_RULES` ahead of its check is simply silent.
 */
export const QA_CHECKS: Readonly<Partial<Record<QaRule, QaCheck>>> = {
  'tag.missing': checkTagMissing,
  'tag.extra': checkTagExtra,
  'tag.unbalanced': checkTagUnbalanced,
  'seg.empty': checkSegEmpty,
  'seg.untranslated': checkSegUntranslated,
  'consistency.target_differs': checkConsistencyTargetDiffers,
  'consistency.source_differs': checkConsistencySourceDiffers,
  'num.missing': checkNumMissing,
  'num.altered': checkNumAltered,
  'punct.terminal': checkPunctTerminal,
  'punct.brackets': checkPunctBrackets,
  'punct.inverted': checkPunctInverted,
  'punct.spacing': checkPunctSpacing,
};

/**
 * Runs every enabled, implemented check against one segment's tokens.
 *
 * `enabledRules` is the project's switches (backlog #22): a rule absent
 * from `QA_CHECKS` never runs regardless of `enabledRules`, and a rule
 * present in `QA_CHECKS` but not in `enabledRules` is skipped without
 * being asked to compute anything.
 */
export function runQaChecks(
  context: QaCheckContext,
  enabledRules: ReadonlySet<QaRule>,
): readonly QaFinding[] {
  const findings: QaFinding[] = [];
  for (const rule of Object.keys(QA_CHECKS) as QaRule[]) {
    if (!enabledRules.has(rule)) continue;
    const check = QA_CHECKS[rule];
    if (check) findings.push(...check(context));
  }
  return findings;
}
