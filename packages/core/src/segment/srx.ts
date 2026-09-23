/**
 * SRX import and export (segmentation-spec.md §5; backlog #12f).
 *
 * SRX 2.0 (OSCAR, 2008; hosted by GALA) is the interchange format for
 * segmentation rules. Support in the wild is uneven — memoQ emits 1.0,
 * Okapi is natively SRX, Trados has none at all — so this module treats
 * SRX as best-effort interchange, never as the internal representation.
 *
 * Export maps the profile onto ordered `<rule>` elements: user rules
 * first (they outrank everything at home, so they must come first abroad
 * — SRX is first-match-wins), then generated no-break rules for the typed
 * lists, then generic break rules approximating the built-in logic.
 *
 * Import lifts recognisably generated rules back into the typed lists and
 * carries everything else verbatim as user rules. A pattern that will not
 * compile as a JavaScript regex is reported, never silently dropped —
 * SRX assumes ICU/Java regex, and the flavours differ.
 */

import { decodeXmlText } from '../docx/tokenize.js';
import { scanElements, type XmlElement } from '../docx/xml-scan.js';
import {
  compileRule,
  mergeListIntoDelta,
  type ProfileDelta,
  type SegmentationProfile,
  type SegmentationRule,
} from './profile.js';
import { SUPPORTED_LANGUAGES } from './rules.js';

/** Escapes a literal string for embedding in a regular expression. */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Undoes {@link escapeRegex}; returns null if the pattern is not literal. */
function unescapeRegex(pattern: string): string | null {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = pattern[++i];
      // Only the escapes escapeRegex produces are literal; anything else
      // (\s, \d, \w, \b…) is a character class and makes this a real regex.
      if (next === undefined || !/[.*+?^${}()|[\]\\]/.test(next)) return null;
      out += next;
    } else if (/[.*+?^${}()|[\]]/.test(ch)) {
      return null; // an unescaped metacharacter means a real regex
    } else {
      out += ch;
    }
  }
  return out;
}

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A generated no-break rule guarding one abbreviation. */
const abbreviationRule = (word: string): SegmentationRule => ({
  break: false,
  beforeBreak: `\\b${escapeRegex(word)}\\.`,
  afterBreak: '\\s',
});

/** A generated no-break rule guarding one ordinal follower. */
const followerRule = (word: string): SegmentationRule => ({
  break: false,
  beforeBreak: '\\d+\\.',
  afterBreak: `\\s*${escapeRegex(word)}`,
});

/**
 * Characters at which the engine could break inside a variable — every
 * terminator it knows, including the flag-gated colon and semicolon.
 * Matches {@link liftableVariableEnd} on import.
 */
const VARIABLE_TERMINATORS = new Set(['.', '!', '?', '…', ':', ';']);

/**
 * No-break rules covering each internal terminator of a variable, so
 * "Node.js" and "Yahoo! Japan" survive tools that would otherwise split
 * them. The engine vetoes breaks inside a variable at *any* terminator
 * (segmenter `strictlyInside`), so export must cover them all.
 */
function variableRules(variable: string): SegmentationRule[] {
  const rules: SegmentationRule[] = [];
  for (let i = 1; i < variable.length - 1; i++) {
    if (!VARIABLE_TERMINATORS.has(variable[i]!)) continue;
    rules.push({
      break: false,
      beforeBreak: escapeRegex(variable.slice(0, i + 1)),
      afterBreak: escapeRegex(variable.slice(i + 1)),
    });
  }
  return rules;
}

/** Generic break rules approximating the built-in terminator logic. */
function genericBreakRulesFor(invertedMarks: boolean): SegmentationRule[] {
  const openers = invertedMarks ? '\\p{Lu}\\d¿¡' : '\\p{Lu}\\d';
  return [
    // Initials and decimals, expressible losslessly as no-break rules.
    { break: false, beforeBreak: '(^|[^\\p{L}])\\p{Lu}\\.', afterBreak: '\\s' },
    { break: false, beforeBreak: '\\d\\.', afterBreak: '\\d' },
    {
      break: true,
      beforeBreak: `[.!?…]+['"»”’)\\]}›]*`,
      afterBreak: `\\s+[${openers}'"«“‘([]`,
    },
  ];
}

function genericBreakRules(profile: SegmentationProfile): SegmentationRule[] {
  return genericBreakRulesFor(profile.invertedMarks);
}

const sameRule = (a: SegmentationRule, b: SegmentationRule): boolean =>
  a.break === b.break && a.beforeBreak === b.beforeBreak && a.afterBreak === b.afterBreak;

/**
 * Whether a group's rules end with exactly the generic suffix this module
 * emits — the fingerprint of our own export.
 */
function isOwnExport(rules: readonly SegmentationRule[]): boolean {
  for (const inverted of [false, true]) {
    const generic = genericBreakRulesFor(inverted);
    if (rules.length < generic.length) continue;
    const tail = rules.slice(-generic.length);
    if (generic.every((rule, i) => sameRule(rule, tail[i]!))) return true;
  }
  return false;
}

/** All rules for a profile, in evaluation order. */
function rulesInOrder(profile: SegmentationProfile): SegmentationRule[] {
  return [
    ...profile.userRules,
    ...profile.variables.flatMap(variableRules),
    ...profile.abbreviations.map(abbreviationRule),
    ...profile.ordinalFollowers.map(followerRule),
    ...genericBreakRules(profile),
  ];
}

/** Serialises profiles as an SRX 2.0 document. */
export function exportSrx(profiles: readonly SegmentationProfile[]): string {
  const languageRules = profiles
    .map((profile) => {
      const rules = rulesInOrder(profile)
        .map(
          (rule) =>
            `      <rule break="${rule.break ? 'yes' : 'no'}">\n` +
            `        <beforebreak>${escapeXml(rule.beforeBreak)}</beforebreak>\n` +
            `        <afterbreak>${escapeXml(rule.afterBreak)}</afterbreak>\n` +
            `      </rule>`,
        )
        .join('\n');
      return (
        `    <languagerule languagerulename="${escapeXml(profile.lang)}">\n` +
        `${rules}\n` +
        `    </languagerule>`
      );
    })
    .join('\n');

  const maps = profiles
    .map(
      (profile) =>
        `    <languagemap languagepattern="${escapeXml(profile.lang)}.*"` +
        ` languagerulename="${escapeXml(profile.lang)}"/>`,
    )
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<srx xmlns="http://www.lisa.org/srx20" version="2.0">\n` +
    `  <header segmentsubflows="yes" cascade="no">\n` +
    `    <formathandle type="start" include="no"/>\n` +
    `    <formathandle type="end" include="yes"/>\n` +
    `    <formathandle type="isolated" include="no"/>\n` +
    `  </header>\n` +
    `  <body>\n` +
    `  <languagerules>\n${languageRules}\n  </languagerules>\n` +
    `  <maprules>\n${maps}\n  </maprules>\n` +
    `  </body>\n` +
    `</srx>\n`
  );
}

export interface SrxImport {
  /** One delta per language the document mapped onto. */
  readonly deltas: readonly ProfileDelta[];
  /** Everything that could not be honoured, human-readable. */
  readonly problems: readonly string[];
}

function attr(xml: string, el: XmlElement, name: string): string | null {
  const openTag = xml.slice(el.start, el.contentStart);
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(openTag);
  return match ? decodeXmlText(match[1]!) : null;
}

const contains = (outer: XmlElement, inner: XmlElement): boolean =>
  inner.start >= outer.contentStart && inner.end <= outer.contentEnd;

/**
 * Parses SRX 1.0 or 2.0, best-effort.
 *
 * Lifting: a no-break rule matching the shape this module generates is
 * folded back into the corresponding typed list; anything else lands in
 * `userRules` verbatim. A round trip through another tool therefore does
 * not come back structurally identical, and callers should not imply it
 * does.
 */
export function importSrx(xml: string): SrxImport {
  const problems: string[] = [];
  const elements = scanElements(
    xml,
    new Set(['srx', 'languagerule', 'rule', 'beforebreak', 'afterbreak', 'languagemap']),
  );

  const root = elements.find((el) => el.name === 'srx');
  if (!root) return { deltas: [], problems: ['not an SRX document: no <srx> root'] };
  const version = attr(xml, root, 'version');
  if (version !== '1.0' && version !== '2.0') {
    problems.push(`unrecognised SRX version "${version ?? '?'}"; parsed as 2.0`);
  }

  // Rule-group name -> languages, via <languagemap>. Patterns are ICU
  // regexes; ours are compiled where possible, with a literal-prefix
  // fallback for patterns JavaScript cannot take.
  const groupLangs = new Map<string, Set<string>>();
  for (const map of elements.filter((el) => el.name === 'languagemap')) {
    const pattern = attr(xml, map, 'languagepattern');
    const group = attr(xml, map, 'languagerulename');
    if (!pattern || !group) continue;
    let matcher: (lang: string) => boolean;
    try {
      const re = new RegExp(`^(?:${pattern})$`, 'iu');
      matcher = (lang) => re.test(lang);
    } catch {
      const prefix = pattern.replace(/\W.*$/, '').toLowerCase();
      matcher = (lang) => prefix.length > 0 && lang.startsWith(prefix);
    }
    // Patterns in real SRX files target full locale tags ("en-US",
    // "en[-_].*"), which a bare primary subtag never matches. The
    // pattern's own leading literal names the language it is for, so
    // its primary subtag counts as a match too.
    const literalPrimary = pattern
      .replace(/[\\^$.*+?()[\]{}|].*$/, '')
      .toLowerCase()
      .split(/[-_]/)[0]!;
    for (const lang of SUPPORTED_LANGUAGES) {
      if (matcher(lang) || lang === literalPrimary) {
        if (!groupLangs.has(group)) groupLangs.set(group, new Set());
        groupLangs.get(group)!.add(lang);
      }
    }
  }

  const deltas: ProfileDelta[] = [];
  for (const group of elements.filter((el) => el.name === 'languagerule')) {
    const groupName = attr(xml, group, 'languagerulename') ?? '';
    let langs = [...(groupLangs.get(groupName) ?? [])];
    if (langs.length === 0) {
      // No map matched: fall back to the group name itself.
      const named = groupName.toLowerCase().split(/[-_]/)[0]!;
      if ((SUPPORTED_LANGUAGES as readonly string[]).includes(named)) {
        langs = [named];
      } else {
        problems.push(
          `language group "${groupName}" maps to no supported language; skipped`,
        );
        continue;
      }
    }

    // Gather the group's rules in order first; how they are interpreted
    // depends on whether this is our own export.
    const raw: SegmentationRule[] = [];
    for (const rule of elements.filter(
      (el) => el.name === 'rule' && contains(group, el),
    )) {
      const breakHere = (attr(xml, rule, 'break') ?? 'yes') === 'yes';
      const pick = (name: string): string => {
        const el = elements.find((child) => child.name === name && contains(rule, child));
        return el ? decodeXmlText(xml.slice(el.contentStart, el.contentEnd)) : '';
      };
      raw.push({
        break: breakHere,
        beforeBreak: pick('beforebreak'),
        afterBreak: pick('afterbreak'),
      });
    }

    const abbreviations: string[] = [];
    const followers: string[] = [];
    const variables: string[] = [];
    const userRules: SegmentationRule[] = [];

    /**
     * Lifting a no-break rule out of the ordered sequence into a typed
     * list is only sound when the rules that remain cannot outrank it —
     * in this engine, lists are consulted *after* user rules, so a
     * leftover generic break rule would defeat every lifted exception.
     *
     * Our own exports are safe: the generic suffix is recognised and
     * dropped, because the built-in logic already implements it. A
     * foreign document is imported verbatim as ordered rules instead,
     * preserving its first-match-wins semantics exactly.
     */
    const ours = isOwnExport(raw);
    const body = ours ? raw.slice(0, raw.length - 3) : raw;

    for (const candidate of body) {
      const { break: breakHere, beforeBreak, afterBreak } = candidate;
      if (ours && !breakHere && afterBreak === '\\s') {
        const literal = /^\\b(.+)\\\.$/.exec(beforeBreak);
        const word = literal ? unescapeRegex(literal[1]!) : null;
        if (word) {
          abbreviations.push(word);
          continue;
        }
      }
      if (ours && !breakHere && beforeBreak === '\\d+\\.') {
        const literal = /^\\s\*(.+)$/.exec(afterBreak);
        const word = literal ? unescapeRegex(literal[1]!) : null;
        if (word) {
          followers.push(word);
          continue;
        }
      }
      if (ours && !breakHere) {
        const before = unescapeRegex(beforeBreak);
        const after = unescapeRegex(afterBreak);
        if (
          before !== null &&
          after !== null &&
          before.length > 0 &&
          VARIABLE_TERMINATORS.has(before[before.length - 1]!)
        ) {
          variables.push(before + after);
          continue;
        }
      }

      const compiled = compileRule(candidate);
      if ('error' in compiled) {
        problems.push(
          `${groupName}: rule not portable to JavaScript regex — ${compiled.error}`,
        );
        continue;
      }
      userRules.push(candidate);
    }

    for (const lang of langs) {
      // mergeListIntoDelta keeps the stored delta minimal: importing our
      // own export must not re-add every built-in abbreviation.
      let delta: ProfileDelta = {
        version: 1,
        lang,
        ...(userRules.length > 0 ? { userRules } : {}),
      };
      if (abbreviations.length > 0) {
        delta = mergeListIntoDelta(delta, 'abbreviations', abbreviations);
      }
      if (followers.length > 0) {
        delta = mergeListIntoDelta(delta, 'ordinalFollowers', followers);
      }
      if (variables.length > 0) {
        delta = mergeListIntoDelta(delta, 'variables', [...new Set(variables)]);
      }
      deltas.push(delta);
    }
  }

  return { deltas, problems };
}
