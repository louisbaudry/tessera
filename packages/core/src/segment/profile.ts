/**
 * Editable segmentation profiles (segmentation-spec.md §3; backlog #12a–c).
 *
 * The built-in {@link LanguageRules} are the default profile for each
 * language. A user's customisation is stored as a **delta** from those
 * defaults, never as a copy: a memory created today still benefits when
 * the built-in English list improves, and the delta is exactly what a
 * user wants shown when they ask "what did I change?".
 *
 * Deletions are explicit, so removing `No` from the English list survives
 * an update that would otherwise re-add it.
 */

import { rulesFor, type LanguageRules } from './rules.js';

/**
 * One user rule, SRX-compatible by construction: a pair of regular
 * expressions and a verdict. Rules are ordered and first match wins,
 * which is why no-break exceptions are written above break rules.
 */
export interface SegmentationRule {
  /** true = always break here; false = never break here. */
  readonly break: boolean;
  /** Pattern matched against the text *ending* at the candidate position. */
  readonly beforeBreak: string;
  /**
   * Pattern matched against the text *starting* at the candidate position.
   * Empty means "always matches", per SRX.
   */
  readonly afterBreak: string;
  /** Shown in the editor. Lost on SRX export (documented lossiness). */
  readonly note?: string;
}

/** The complete, effective rule set the segmenter consumes. */
export interface SegmentationProfile extends LanguageRules {
  /**
   * Strings never broken internally — product names, legal citations.
   * The Trados "variables" resource.
   */
  readonly variables: readonly string[];
  /** Ordered; evaluated before all built-in logic, first match wins. */
  readonly userRules: readonly SegmentationRule[];
}

/** Additions and removals against a base list. */
export interface ListDelta {
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
}

/**
 * A stored customisation: the difference between the built-in defaults
 * and what the user wants. This is what `.ctm` persists
 * (tm-format-spec.md, `seg_profile`).
 */
export interface ProfileDelta {
  readonly version: 1;
  /** BCP-47; resolved against the primary subtag's built-in defaults. */
  readonly lang: string;
  readonly abbreviations?: ListDelta;
  readonly ordinalPrefixes?: ListDelta;
  readonly ordinalFollowers?: ListDelta;
  readonly variables?: ListDelta;
  /** Full ordered replacement — order is meaning, so no add/remove delta. */
  readonly userRules?: readonly SegmentationRule[];
  readonly breakOnColon?: boolean;
  readonly breakOnSemicolon?: boolean;
  readonly invertedMarks?: boolean;
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/** The built-in defaults for a language, as a full profile. */
export function defaultProfile(lang: string): SegmentationProfile {
  return { ...rulesFor(lang), variables: [], userRules: [] };
}

function applyList(
  base: readonly string[],
  delta: ListDelta | undefined,
): readonly string[] {
  if (!delta) return base;
  const removed = new Set(delta.removed ?? []);
  const out = base.filter((item) => !removed.has(item));
  for (const item of delta.added ?? []) {
    if (!out.includes(item) && !removed.has(item)) out.push(item);
  }
  return out;
}

/** Layers a stored delta over the built-in defaults. */
export function resolveProfile(delta?: ProfileDelta | null): SegmentationProfile;
export function resolveProfile(
  lang: string,
  delta?: ProfileDelta | null,
): SegmentationProfile;
export function resolveProfile(
  langOrDelta?: string | ProfileDelta | null,
  maybeDelta?: ProfileDelta | null,
): SegmentationProfile {
  const delta = typeof langOrDelta === 'string' ? maybeDelta : langOrDelta;
  const lang = typeof langOrDelta === 'string' ? langOrDelta : delta?.lang;
  if (!lang) throw new ProfileError('resolveProfile needs a language or a delta');
  if (delta && primary(delta.lang) !== primary(lang)) {
    throw new ProfileError(`delta is for "${delta.lang}" but was applied to "${lang}"`);
  }

  const base = defaultProfile(lang);
  if (!delta) return base;
  return {
    ...base,
    abbreviations: applyList(base.abbreviations, delta.abbreviations),
    ordinalPrefixes: applyList(base.ordinalPrefixes, delta.ordinalPrefixes),
    ordinalFollowers: applyList(base.ordinalFollowers, delta.ordinalFollowers),
    variables: applyList(base.variables, delta.variables),
    userRules: delta.userRules ?? base.userRules,
    breakOnColon: delta.breakOnColon ?? base.breakOnColon,
    breakOnSemicolon: delta.breakOnSemicolon ?? base.breakOnSemicolon,
    invertedMarks: delta.invertedMarks ?? base.invertedMarks,
  };
}

function primary(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0]!;
}

/**
 * Compiles a rule's patterns, reporting rather than throwing.
 *
 * SRX assumes ICU/Java regex; JavaScript differs on possessive
 * quantifiers and some classes, so the `u` flag is tried first and
 * dropped as a fallback before the rule is declared unusable.
 */
export function compileRule(
  rule: SegmentationRule,
): { before: RegExp; after: RegExp | null } | { error: string } {
  const attempt = (source: string, flags: string): RegExp | null => {
    try {
      return new RegExp(source, flags);
    } catch {
      return null;
    }
  };
  const before = attempt(rule.beforeBreak, 'gu') ?? attempt(rule.beforeBreak, 'g');
  if (!before) return { error: `beforeBreak does not compile: ${rule.beforeBreak}` };
  if (rule.afterBreak === '') return { before, after: null };
  const after = attempt(rule.afterBreak, 'yu') ?? attempt(rule.afterBreak, 'y');
  if (!after) return { error: `afterBreak does not compile: ${rule.afterBreak}` };
  return { before, after };
}

/**
 * Problems that make rules unusable or suspicious. Surfaced by the rule
 * editor before a rule is saved — a rule that will not compile is
 * reported, never silently dropped.
 */
export function ruleProblems(rules: readonly SegmentationRule[]): string[] {
  const problems: string[] = [];
  rules.forEach((rule, index) => {
    const compiled = compileRule(rule);
    if ('error' in compiled) problems.push(`rule ${index + 1}: ${compiled.error}`);
  });
  return problems;
}

/** Serialises a delta for storage in `.ctm`. */
export function serializeProfileDelta(delta: ProfileDelta): string {
  return JSON.stringify(delta);
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function checkListDelta(value: unknown, field: string): ListDelta | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new ProfileError(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of ['added', 'removed']) {
    if (record[key] !== undefined && !isStringArray(record[key])) {
      throw new ProfileError(`${field}.${key} must be an array of strings`);
    }
  }
  return value as ListDelta;
}

/**
 * Parses a stored delta, strictly.
 *
 * A malformed profile in a memory is refused loudly rather than partially
 * applied — mis-segmenting a whole job because a field was quietly
 * ignored is precisely the failure this format exists to avoid.
 */
export function parseProfileDelta(json: string): ProfileDelta {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new ProfileError(
      `profile delta is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new ProfileError('profile delta must be an object');
  }
  const record = raw as Record<string, unknown>;
  if (record['version'] !== 1) {
    throw new ProfileError(
      `unsupported profile delta version: ${String(record['version'])}`,
    );
  }
  if (typeof record['lang'] !== 'string' || record['lang'].length === 0) {
    throw new ProfileError('profile delta must name a language');
  }
  for (const field of [
    'abbreviations',
    'ordinalPrefixes',
    'ordinalFollowers',
    'variables',
  ]) {
    checkListDelta(record[field], field);
  }
  if (record['userRules'] !== undefined) {
    if (!Array.isArray(record['userRules'])) {
      throw new ProfileError('userRules must be an array');
    }
    record['userRules'].forEach((rule: unknown, index: number) => {
      if (typeof rule !== 'object' || rule === null) {
        throw new ProfileError(`userRules[${index}] must be an object`);
      }
      const r = rule as Record<string, unknown>;
      if (typeof r['break'] !== 'boolean') {
        throw new ProfileError(`userRules[${index}].break must be a boolean`);
      }
      for (const key of ['beforeBreak', 'afterBreak']) {
        if (typeof r[key] !== 'string') {
          throw new ProfileError(`userRules[${index}].${key} must be a string`);
        }
      }
    });
  }
  for (const flag of ['breakOnColon', 'breakOnSemicolon', 'invertedMarks']) {
    if (record[flag] !== undefined && typeof record[flag] !== 'boolean') {
      throw new ProfileError(`${flag} must be a boolean`);
    }
  }
  return raw as ProfileDelta;
}

/**
 * Computes the minimal delta that adds `items` to one of a profile's
 * lists — the import path for a Trados resource list. Items already in
 * the resolved list are not re-added; items the user had removed are
 * un-removed rather than double-listed.
 */
export function mergeListIntoDelta(
  delta: ProfileDelta,
  field: 'abbreviations' | 'ordinalFollowers' | 'variables' | 'ordinalPrefixes',
  items: readonly string[],
): ProfileDelta {
  const current = resolveProfile(delta.lang, delta)[field];
  const existing = new Set(current);
  const baseList = new Set(defaultProfile(delta.lang)[field]);
  const priorAdded = new Set(delta[field]?.added ?? []);
  const removed = new Set(delta[field]?.removed ?? []);
  const toAdd: string[] = [];
  const unRemove = new Set<string>();
  for (const item of items) {
    if (removed.has(item)) {
      if (unRemove.has(item)) continue;
      unRemove.add(item);
      // Un-removing only resurfaces an item the base (or a prior add)
      // still supplies; a stale removal of something no longer in the
      // built-in list must become an addition, or the item is lost.
      if (!baseList.has(item) && !priorAdded.has(item)) toAdd.push(item);
    } else if (!existing.has(item)) {
      existing.add(item); // dedupe repeats within `items`
      toAdd.push(item);
    }
  }
  const nextRemoved = [...removed].filter((item) => !unRemove.has(item));
  const nextAdded = [...(delta[field]?.added ?? []), ...toAdd];
  if (nextAdded.length === 0 && nextRemoved.length === 0) {
    const { [field]: _dropped, ...rest } = delta;
    return rest as ProfileDelta;
  }
  return {
    ...delta,
    [field]: {
      ...(nextAdded.length > 0 ? { added: nextAdded } : {}),
      ...(nextRemoved.length > 0 ? { removed: nextRemoved } : {}),
    },
  };
}
