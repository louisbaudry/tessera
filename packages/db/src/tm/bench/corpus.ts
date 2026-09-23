/**
 * Synthetic en→fr corpus for the `.ctm` scale benchmark
 * (tm-format-spec.md §11). Deterministic: the same seed produces the
 * same units in the same order, so the chunked build and the
 * single-file import probe see identical text.
 *
 * Deliberately not uniform, because uniform text flatters both FTS and
 * fuzzy matching:
 * - a 6,000-word vocabulary per language drawn with a Zipf(1.07)
 *   frequency, so a handful of function-like words appear in most
 *   sentences and most words are rare;
 * - sentence length 3–40 words, log-normally skewed around 13;
 * - ~25% of units are near-duplicates (1–3 word edits) of a recent
 *   unit and ~2% repeat a recent source verbatim with a different
 *   target, the two shapes a real agency memory is full of;
 * - ~10% carry numbers and ~10% carry inline tags.
 *
 * Still synthetic. Pseudo-words have no morphology, no real phrase
 * structure and no real-world term distribution; see §11 for what that
 * leaves unproven.
 */

import { closeSync, openSync, writeSync } from 'node:fs';

/** mulberry32 — small, fast, seedable. Not for anything but test data. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const VOCAB_SIZE = 6000;
const ZIPF_S = 1.07;

const EN_ONSETS = [
  'b',
  'c',
  'd',
  'f',
  'g',
  'h',
  'l',
  'm',
  'n',
  'p',
  'r',
  's',
  't',
  'v',
  'w',
  'br',
  'cl',
  'st',
  'tr',
  'sh',
  'th',
  'pr',
  'gr',
];
const EN_VOWELS = ['a', 'e', 'i', 'o', 'u', 'ea', 'ou', 'ai', 'y'];
const EN_CODAS = ['', '', 'n', 'r', 's', 't', 'l', 'nd', 'st', 'ng', 'ck', 'rt'];
// French side gets accented vowels so remove_diacritics has something
// to fold (tm-format-spec.md §2.6). Escapes, not glyphs (CLAUDE.md).
const FR_ONSETS = [
  'b',
  'c',
  'd',
  'f',
  'g',
  'j',
  'l',
  'm',
  'n',
  'p',
  'qu',
  'r',
  's',
  't',
  'v',
  'ch',
  'tr',
  'pl',
  'gr',
];
const FR_VOWELS = [
  'a',
  'e',
  'i',
  'o',
  'u',
  'ou',
  'ai',
  'eu',
  '\u00e9',
  '\u00e8',
  '\u00e0',
  '\u00ea',
  'oi',
];
const FR_CODAS = ['', '', '', 'n', 'r', 's', 't', 'l', 'x', 'nt', 'ment', 'tion'];

function buildVocab(
  rand: () => number,
  onsets: readonly string[],
  vowels: readonly string[],
  codas: readonly string[],
): string[] {
  const pick = (xs: readonly string[]): string => xs[Math.floor(rand() * xs.length)]!;
  const seen = new Set<string>();
  const words: string[] = [];
  while (words.length < VOCAB_SIZE) {
    // Frequent words are short, as in any natural language.
    const rankFraction = words.length / VOCAB_SIZE;
    const syllables =
      rankFraction < 0.02 ? 1 : 1 + Math.floor(rand() * (rankFraction < 0.2 ? 2 : 3)) + 1;
    let w = '';
    for (let i = 0; i < syllables; i++) w += pick(onsets) + pick(vowels);
    w += pick(codas);
    if (!seen.has(w)) {
      seen.add(w);
      words.push(w);
    }
  }
  return words;
}

export interface Vocabulary {
  readonly en: readonly string[];
  readonly fr: readonly string[];
  /** Draws a Zipf-distributed rank in `[0, VOCAB_SIZE)`. */
  readonly rank: (rand: () => number) => number;
}

export function vocabulary(seed = 1): Vocabulary {
  const rand = prng(seed);
  const en = buildVocab(rand, EN_ONSETS, EN_VOWELS, EN_CODAS);
  const fr = buildVocab(rand, FR_ONSETS, FR_VOWELS, FR_CODAS);
  const cdf = new Float64Array(VOCAB_SIZE);
  let total = 0;
  for (let r = 0; r < VOCAB_SIZE; r++) {
    total += 1 / Math.pow(r + 1, ZIPF_S);
    cdf[r] = total;
  }
  for (let r = 0; r < VOCAB_SIZE; r++) cdf[r]! /= total;
  const rank = (rnd: () => number): number => {
    const u = rnd();
    let lo = 0;
    let hi = VOCAB_SIZE - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid]! < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return { en, fr, rank };
}

/** One source/target pair, as word ranks plus decorations. */
interface Sentence {
  readonly ranks: number[];
  readonly number: string | null;
  readonly numberAt: number;
  readonly tag: 'none' | 'pair' | 'ph';
  readonly tagAt: number;
  /** Target ranks — the "translation"; mostly aligned, sometimes not. */
  readonly target: number[];
}

export interface SyntheticUnit {
  readonly index: number;
  /** TMX `<seg>` inner XML for each language, already escaped. */
  readonly enSeg: string;
  readonly frSeg: string;
  /** The plain source text (what `plain` normalises from). */
  readonly enPlain: string;
}

function logNormalLength(rand: () => number): number {
  // Box–Muller; median e^2.55 ≈ 13 words.
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(40, Math.max(3, Math.round(Math.exp(2.55 + 0.55 * z))));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(
  words: readonly string[],
  ranks: readonly number[],
  s: Sentence,
  xml: boolean,
): string {
  const out: string[] = ranks.map((r) => words[r]!);
  if (s.number !== null) out.splice(Math.min(s.numberAt, out.length), 0, s.number);
  if (out.length > 0) out[0] = out[0]!.charAt(0).toUpperCase() + out[0]!.slice(1);
  if (!xml) return out.join(' ') + '.';
  const at = Math.min(s.tagAt, out.length - 1);
  if (s.tag === 'pair' && out.length > 1) {
    out[at] =
      `<bpt i="1">${escapeXml('<b>')}</bpt>${out[at]!}<ept i="1">${escapeXml('</b>')}</ept>`;
  } else if (s.tag === 'ph') {
    out[at] = `${out[at]!} <ph x="1"/>`;
  }
  return out.join(' ') + '.';
}

/**
 * Yields `count` units. `recent` is a ring buffer of the last few
 * thousand sentences, which is where near-duplicates come from — in a
 * real memory they cluster by document, not uniformly across the file.
 */
export function* syntheticUnits(count: number, seed = 42): Generator<SyntheticUnit> {
  const vocab = vocabulary(1);
  const rand = prng(seed);
  const RING = 5000;
  const recent: Sentence[] = [];

  const fresh = (): Sentence => {
    const len = logNormalLength(rand);
    const ranks: number[] = [];
    for (let i = 0; i < len; i++) ranks.push(vocab.rank(rand));
    const target: number[] = [];
    for (const r of ranks) {
      // 10% loose translations, 15% an extra function word.
      target.push(rand() < 0.1 ? vocab.rank(rand) : r);
      if (rand() < 0.15) target.push(Math.floor(rand() * 30));
    }
    const hasNumber = rand() < 0.1;
    const tagRoll = rand();
    return {
      ranks,
      target,
      number: hasNumber
        ? String(Math.floor(rand() * 100000) / (rand() < 0.3 ? 100 : 1))
        : null,
      numberAt: Math.floor(rand() * len),
      tag: tagRoll < 0.07 ? 'pair' : tagRoll < 0.1 ? 'ph' : 'none',
      tagAt: Math.floor(rand() * len),
    };
  };

  const nearDuplicate = (base: Sentence): Sentence => {
    const ranks = [...base.ranks];
    const target = [...base.target];
    const edits = 1 + Math.floor(rand() * 3);
    for (let e = 0; e < edits; e++) {
      const op = rand();
      const at = Math.floor(rand() * ranks.length);
      const tAt = Math.min(
        target.length - 1,
        Math.round((at / ranks.length) * target.length),
      );
      const w = vocab.rank(rand);
      if (op < 0.5 || ranks.length <= 3) {
        ranks[at] = w;
        target[tAt] = w;
      } else if (op < 0.75 && ranks.length < 40) {
        ranks.splice(at, 0, w);
        target.splice(tAt, 0, w);
      } else {
        ranks.splice(at, 1);
        target.splice(tAt, 1);
      }
    }
    const number =
      base.number !== null && rand() < 0.5
        ? String(Math.floor(rand() * 100000))
        : base.number;
    return { ...base, ranks, target, number };
  };

  for (let index = 0; index < count; index++) {
    const roll = rand();
    let s: Sentence;
    if (recent.length > 100 && roll < 0.25) {
      s = nearDuplicate(recent[Math.floor(rand() * recent.length)]!);
    } else if (recent.length > 100 && roll < 0.27) {
      // Same source, different translation.
      const base = recent[Math.floor(rand() * recent.length)]!;
      s = {
        ...base,
        target: base.target.map((r) => (rand() < 0.3 ? vocab.rank(rand) : r)),
      };
    } else {
      s = fresh();
    }
    if (recent.length < RING) recent.push(s);
    else recent[index % RING] = s;

    yield {
      index,
      enSeg: render(vocab.en, s.ranks, s, true),
      frSeg: render(vocab.fr, s.target, s, true),
      enPlain: render(vocab.en, s.ranks, s, false),
    };
  }
}

const TMX_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n<tmx version="1.4">\n' +
  '<header creationtool="cat-tool-bench" creationtoolversion="1" srclang="en-US" ' +
  'adminlang="en-US" datatype="plaintext" o-tmf="bench" segtype="sentence"/>\n<body>\n';
const TMX_TAIL = '</body>\n</tmx>\n';

/** One `<tu>`, Trados-export-shaped: dates, a creator, one client prop. */
export function tuXml(u: SyntheticUnit): string {
  const day = String(1 + (u.index % 28)).padStart(2, '0');
  const month = String(1 + (Math.floor(u.index / 28) % 12)).padStart(2, '0');
  const date = `2024${month}${day}T120000Z`;
  return (
    `<tu creationdate="${date}" creationid="user${u.index % 17}" changedate="${date}">` +
    `<prop type="x-Client">Client ${u.index % 40}</prop>` +
    `<tuv xml:lang="en-US"><seg>${u.enSeg}</seg></tuv>` +
    `<tuv xml:lang="fr-FR"><seg>${u.frSeg}</seg></tuv></tu>\n`
  );
}

/** A whole TMX document from a slice of units — used for chunked builds. */
export function tmxDocument(units: readonly SyntheticUnit[]): string {
  return TMX_HEAD + units.map(tuXml).join('') + TMX_TAIL;
}

/**
 * Streams `count` units into a TMX file on disk without ever holding
 * the document in memory — the generator must not be what fails at
 * 5M units, so that whatever does fail is the importer.
 */
export function writeTmxFile(path: string, count: number): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, TMX_HEAD);
    let buf = '';
    for (const u of syntheticUnits(count)) {
      buf += tuXml(u);
      if (buf.length > 1 << 20) {
        writeSync(fd, buf);
        buf = '';
      }
    }
    writeSync(fd, buf + TMX_TAIL);
  } finally {
    closeSync(fd);
  }
}
