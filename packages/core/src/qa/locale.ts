/**
 * Locale conventions the `num.*` and `punct.*` QA rules depend on
 * (backlog #24; `planning/v1-spec.md` §6.4).
 *
 * Kept as data, per language, for the same reason segmentation rules are
 * (`segment/rules.ts`): the rule code is the same for every language, and
 * only the table says what a correctly localised number or a correctly
 * spaced French colon looks like. Region matters here where it does not
 * for segmentation — `es-MX` writes `1,000.50` like English while `es-ES`
 * writes `1.000,50`, and `fr-CA` puts a no-break space before a colon
 * but not before a semicolon — so lookups try the full tag before
 * falling back to the primary subtag.
 *
 * Every invisible or lookalike character is spelled as a `\uXXXX` escape,
 * never a bare glyph (CLAUDE.md): a narrow no-break space that an editor
 * silently turned into a plain space would make the French spacing check
 * pass on exactly the input it exists to catch.
 */

import { primarySubtag } from '../segment/rules.js';

/**
 * Whitespace accepted as a digit-grouping separator and as the space
 * French typography puts before `;` `:` `!` `?` — plain space, no-break
 * space, narrow no-break space, thin space.
 */
export const GROUPING_SPACES: readonly string[] = [' ', '\u00A0', '\u202F', '\u2009'];

export interface NumberFormat {
  /** Characters that may separate groups of three digits. */
  readonly grouping: ReadonlySet<string>;
  /** The decimal separator, or `null` when nothing is recognised as one. */
  readonly decimal: string | null;
}

const COMMA_POINT: NumberFormat = { grouping: new Set([',']), decimal: '.' };
const POINT_COMMA: NumberFormat = {
  grouping: new Set(['.', ...GROUPING_SPACES]),
  decimal: ',',
};
const SPACE_COMMA: NumberFormat = { grouping: new Set(GROUPING_SPACES), decimal: ',' };
const APOSTROPHE_POINT: NumberFormat = {
  grouping: new Set(["'", '\u2019', ...GROUPING_SPACES]),
  decimal: '.',
};
/**
 * For a language this table does not know: nothing is a decimal
 * separator and only whitespace groups, so `num.*` compares digit
 * strings and never claims `1,5` and `1.5` are the same number — or
 * different ones — in a locale it cannot vouch for.
 */
const GENERIC: NumberFormat = { grouping: new Set(GROUPING_SPACES), decimal: null };

const NUMBER_FORMAT_BY_PRIMARY: Readonly<Record<string, NumberFormat>> = {
  en: COMMA_POINT,
  es: POINT_COMMA,
  fr: SPACE_COMMA,
  de: POINT_COMMA,
  it: POINT_COMMA,
  pt: POINT_COMMA,
  nl: POINT_COMMA,
};

/** Full-tag exceptions, lowercase, consulted before the primary subtag. */
const NUMBER_FORMAT_BY_TAG: Readonly<Record<string, NumberFormat>> = {
  'es-mx': COMMA_POINT,
  'es-us': COMMA_POINT,
  'de-ch': APOSTROPHE_POINT,
  'fr-ch': APOSTROPHE_POINT,
  'it-ch': APOSTROPHE_POINT,
};

const normaliseTag = (lang: string): string => lang.toLowerCase().replace(/_/g, '-');

/** The number conventions for a BCP-47 tag; {@link GENERIC} when unknown. */
export function numberFormatFor(lang: string): NumberFormat {
  return (
    NUMBER_FORMAT_BY_TAG[normaliseTag(lang)] ??
    NUMBER_FORMAT_BY_PRIMARY[primarySubtag(lang)] ??
    GENERIC
  );
}

export interface SpacingProfile {
  /** Marks that must not be preceded by a space at all. */
  readonly noSpaceBefore: ReadonlySet<string>;
  /** Marks that must be preceded by a no-break space (French). */
  readonly noBreakSpaceBefore: ReadonlySet<string>;
  /** Marks that must be followed by a no-break space (`«`). */
  readonly noBreakSpaceAfter: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The locale-neutral profile, and the one used when no target language
 * is known: `,` and `.` never take a space before them in any of the
 * seven languages, while `;` and `:` do in French, so those two are
 * only checked once the locale says which way.
 */
const NEUTRAL: SpacingProfile = {
  noSpaceBefore: new Set([',', '.']),
  noBreakSpaceBefore: NONE,
  noBreakSpaceAfter: NONE,
};

const DEFAULT: SpacingProfile = {
  noSpaceBefore: new Set([',', '.', ';', ':']),
  noBreakSpaceBefore: NONE,
  noBreakSpaceAfter: NONE,
};

/** France, Belgium, and everywhere else `fr-*` except the two below. */
const FRENCH: SpacingProfile = {
  noSpaceBefore: new Set([',', '.']),
  noBreakSpaceBefore: new Set([';', ':', '!', '?', '\u00BB']),
  noBreakSpaceAfter: new Set(['\u00AB']),
};

/** Québec (OQLF): a no-break space before `:` and inside `« »` only. */
const FRENCH_CA: SpacingProfile = {
  noSpaceBefore: new Set([',', '.', ';']),
  noBreakSpaceBefore: new Set([':', '\u00BB']),
  noBreakSpaceAfter: new Set(['\u00AB']),
};

/**
 * Swiss French: no space before `;` `!` `?`, and practice before `:`
 * varies enough that requiring anything would be a false positive.
 */
const FRENCH_CH: SpacingProfile = {
  noSpaceBefore: new Set([',', '.', ';']),
  noBreakSpaceBefore: NONE,
  noBreakSpaceAfter: NONE,
};

const SPACING_BY_TAG: Readonly<Record<string, SpacingProfile>> = {
  'fr-ca': FRENCH_CA,
  'fr-ch': FRENCH_CH,
};

/** The spacing conventions for a target language, or the neutral profile when none is known. */
export function spacingProfileFor(lang: string | undefined): SpacingProfile {
  if (lang === undefined) return NEUTRAL;
  const byTag = SPACING_BY_TAG[normaliseTag(lang)];
  if (byTag) return byTag;
  return primarySubtag(lang) === 'fr' ? FRENCH : DEFAULT;
}

/** Whether a target language takes Spanish inverted marks (`¿` `¡`). */
export function usesInvertedMarks(lang: string | undefined): boolean {
  return lang !== undefined && primarySubtag(lang) === 'es';
}
