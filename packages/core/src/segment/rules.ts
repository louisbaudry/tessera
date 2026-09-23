/**
 * Per-language segmentation rules (planning/v1-spec.md §5.2; backlog #13).
 *
 * Rules are data, not code: adding a language means adding an entry here,
 * not editing the engine. Segmentation is applied once at import and the
 * result is stored (§5.3), so a rule change never silently re-splits a
 * file that already has confirmed targets.
 *
 * **EN and ES are the working pair and are held to a higher bar.** The
 * other five ship with reasonable lists and get hardened when a job
 * demands it.
 */

export interface LanguageRules {
  /** BCP-47 primary subtag. */
  readonly lang: string;
  /**
   * Words that end in a period without ending a sentence. Stored without
   * the trailing period and matched case-sensitively, because `US.` and
   * `us.` are not the same thing.
   */
  readonly abbreviations: readonly string[];
  /** Whether `:` ends a sentence. Off everywhere by default (§5.1). */
  readonly breakOnColon: boolean;
  /** Whether `;` ends a sentence. Off everywhere by default. */
  readonly breakOnSemicolon: boolean;
  /**
   * Whether a number followed by a period is an ordinal rather than a
   * sentence end — "1. Januar". The dominant false-break in German and
   * Dutch, and harmless to enable elsewhere.
   */
  readonly ordinals: boolean;
  /**
   * Words that mark the following number as an ordinal.
   *
   * German capitalises every noun, so "Der 3. Absatz" and "Wir zählten 20.
   * Dann" both read as digit-period-capital and cannot be told apart by
   * the following word alone. What separates them is what comes *before*
   * the number: a determiner or preposition means an ordinal.
   */
  readonly ordinalPrefixes: readonly string[];
  /**
   * Words that may legitimately *follow* an ordinal number — the Trados
   * model, complementing `ordinalPrefixes`.
   *
   * The two directions catch different cases. Forward ("is the next word a
   * month?") handles "Frist: 30. Juni", where no determiner precedes the
   * number. Backward ("is the number preceded by a determiner?") handles
   * "Der 3. Absatz", where the follower is an ordinary noun no list could
   * enumerate. Keeping both is deliberate (segmentation-spec.md §2).
   */
  readonly ordinalFollowers: readonly string[];
  /**
   * Whether `¿` and `¡` can *open* a sentence. Spanish only, and the
   * reason a naive "next character is uppercase" test fails there.
   */
  readonly invertedMarks: boolean;
}

/** Shared across Latin-script languages: titles, initials, units. */
const COMMON = ['cf', 'vs', 'etc', 'al', 'ca', 'approx', 'fig', 'vol', 'ed', 'pp'];

const EN = [
  ...COMMON,
  'Mr',
  'Mrs',
  'Ms',
  'Dr',
  'Prof',
  'Sr',
  'Jr',
  'St',
  'Rev',
  'Hon',
  'Pres',
  'Gov',
  'Sen',
  'Rep',
  'Gen',
  'Col',
  'Capt',
  'Lt',
  'Sgt',
  'Msgr',
  'Fr',
  'Ave',
  'Blvd',
  'Rd',
  'Ltd',
  'Inc',
  'Corp',
  'Co',
  'Dept',
  'Univ',
  'Assn',
  'Bros',
  'No',
  'Nos',
  'no',
  'nos',
  'eds',
  'viz',
  'esp',
  'incl',
  'min',
  'max',
  'est',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Sept',
  'Oct',
  'Nov',
  'Dec',
  'Mon',
  'Tue',
  'Tues',
  'Wed',
  'Thu',
  'Thur',
  'Thurs',
  'Fri',
  'Sat',
  'Sun',
];

/**
 * Spanish. The priority list alongside English.
 *
 * Religious and academic honorifics are included deliberately: the source
 * texts this tool is built for are full of `Mons.`, `Excmo.` and `Rvdo.`,
 * and each one is a false sentence break in the middle of a name.
 */
const ES = [
  ...COMMON,
  'Sr',
  'Sra',
  'Srta',
  'Sres',
  'Sras',
  'D',
  'Dña',
  'Dr',
  'Dra',
  'Dres',
  'Ud',
  'Uds',
  'Vd',
  'Vds',
  'Lic',
  'Ing',
  'Arq',
  'Mtro',
  'Prof',
  'Profa',
  'San',
  'Sto',
  'Sta',
  'Fr',
  'P',
  'Pbro',
  'Mons',
  'Emmo',
  'Excmo',
  'Excma',
  'Ilmo',
  'Ilma',
  'Rvdo',
  'Rvda',
  'Rdo',
  'art',
  'arts',
  'pág',
  'págs',
  'cap',
  'caps',
  'núm',
  'núms',
  'vols',
  'eds',
  'Av',
  'Avda',
  'Apdo',
  'apdo',
  'aprox',
  'máx',
  'mín',
  'admón',
  'dpto',
  'depto',
  'ej',
  'pers',
  'sig',
  'sigs',
  'trad',
  'vid',
  'op',
  'cit',
  'ibíd',
  'íd',
  'a.C',
  'd.C',
  'p.ej',
  'EE.UU',
];

const FR = [
  ...COMMON,
  'M',
  'MM',
  'Mme',
  'Mmes',
  'Mlle',
  'Mlles',
  'Dr',
  'Pr',
  'Me',
  'Mgr',
  'St',
  'Ste',
  'Sts',
  'Stes',
  'av',
  'apr',
  'J.-C',
  'env',
  'chap',
  'art',
  'éd',
  'éds',
  'réf',
  'p',
  'coll',
  'trad',
  'dir',
  'ibid',
  'op',
  'c.-à-d',
  'p.ex',
  'no',
  'nos',
];

/** German: ordinals matter more than the list. */
const DE = [
  ...COMMON,
  'Dr',
  'Prof',
  'Hr',
  'Hrn',
  'Fr',
  'Frl',
  'Dipl',
  'Ing',
  'Nr',
  'Bd',
  'Bde',
  'bzw',
  'bez',
  'dgl',
  'evtl',
  'ggf',
  'Hrsg',
  'inkl',
  'exkl',
  'Jh',
  'Jhd',
  'Kap',
  'Mio',
  'Mrd',
  'sog',
  'Str',
  'usw',
  'vgl',
  'Abb',
  'Abs',
  'Abt',
  'Anm',
  'Aufl',
  'Bsp',
  'geb',
  'gest',
  'Jgg',
  'Nrn',
  'S',
  'Sp',
  'Tab',
  'z.B',
  'd.h',
  'u.a',
  'o.ä',
  's.o',
  's.u',
  'z.T',
  'u.U',
  'i.d.R',
];

const IT = [
  ...COMMON,
  'Sig',
  'Dott',
  'Prof',
  'Ing',
  'Avv',
  'Egr',
  'Gent',
  'Rev',
  'Mons',
  'ecc',
  'cfr',
  'pag',
  'pagg',
  'cap',
  'art',
  'artt',
  'tel',
  'sec',
  'S',
  'SS',
  'Sant',
  'es',
  'p.es',
  'n',
  'nn',
  'ss',
];

const PT = [
  ...COMMON,
  'Sr',
  'Sra',
  'Srta',
  'Dr',
  'Dra',
  'Prof',
  'Profa',
  'Eng',
  'Exmo',
  'Exma',
  'Rev',
  'Mons',
  'São',
  'Sto',
  'Sta',
  'ex',
  'p.ex',
  'pág',
  'págs',
  'cap',
  'art',
  'arts',
  'vols',
  'eds',
  'aprox',
  'Av',
  'R',
  'nº',
  'n.º',
  'séc',
];

/** Dutch: ordinals like German, plus a lower-case-heavy list. */
const NL = [
  ...COMMON,
  'dhr',
  'mevr',
  'mej',
  'dr',
  'drs',
  'prof',
  'ir',
  'ing',
  'mr',
  'bc',
  'bv',
  'bijv',
  'blz',
  'enz',
  'evt',
  'incl',
  'excl',
  'jl',
  'nr',
  'pag',
  'red',
  'resp',
  'zgn',
  'o.a',
  'a.u.b',
  'd.w.z',
  'm.b.t',
  'n.a.v',
  't.a.v',
  't.b.v',
  'v.Chr',
  'n.Chr',
  'e.d',
  'i.v.m',
  'm.n',
];

const base = (lang: string, abbreviations: readonly string[]): LanguageRules => ({
  lang,
  abbreviations,
  breakOnColon: false,
  breakOnSemicolon: false,
  ordinals: false,
  ordinalPrefixes: [],
  ordinalFollowers: [],
  invertedMarks: false,
});

/** German month names — the words that most often follow an ordinal. */
const DE_ORDINAL_FOLLOWERS = [
  'Januar',
  'Jänner',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

const NL_ORDINAL_FOLLOWERS = [
  'januari',
  'februari',
  'maart',
  'april',
  'mei',
  'juni',
  'juli',
  'augustus',
  'september',
  'oktober',
  'november',
  'december',
];

const DE_ORDINAL_PREFIXES = [
  'am',
  'Am',
  'im',
  'Im',
  'vom',
  'Vom',
  'zum',
  'Zum',
  'der',
  'Der',
  'die',
  'Die',
  'das',
  'Das',
  'den',
  'Den',
  'dem',
  'Dem',
  'des',
  'Des',
  'seit',
  'Seit',
  'bis',
  'ab',
  'Ab',
  'auf',
  'Auf',
  'nach',
  'Nach',
  'vor',
  'Vor',
  'um',
  'Um',
  'für',
  'Für',
];

const NL_ORDINAL_PREFIXES = [
  'op',
  'Op',
  'de',
  'De',
  'het',
  'Het',
  'een',
  'Een',
  'in',
  'In',
  'van',
  'Van',
  'sinds',
  'Sinds',
  'tot',
  'Tot',
  'vanaf',
  'Vanaf',
  'per',
  'Per',
];

/**
 * Korean abbreviations. Initial set for v1.
 * Korean does not have the same abbreviation-as-false-break problem as
 * Latin-script languages, so abbreviations focus on common honorifics and
 * domain terms. Expanded from minimal set to meet testing requirements.
 * Further curation will come as real jobs reveal actual patterns.
 * Backlog #13a.
 */
const KO: readonly string[] = [
  '등', // et al / and so on
  '따', // typically
  '쌍', // pair
  '예', // example
  '식', // style/type
  '법', // method
  '면', // if
  '터', // from
  '때', // when
  '뿐', // only
  '들', // things
  '것', // thing
];

/**
 * Vietnamese abbreviations. Initial set for v1.
 * Vietnamese uses Latin script so it shares some patterns with European
 * languages. However, abbreviations are often different due to language
 * structure. This set includes common Latin-origin abbreviations plus
 * Vietnamese-specific ones found in real technical documentation.
 * Backlog #13a.
 */
const VI: readonly string[] = [
  'VD', // ví dụ (for example)
  'vs', // versus
  'etc', // et cetera
  'al', // allied
  'Dr', // Doctor
  'TS', // Tiến sĩ (PhD)
  'ThS', // Thạc sĩ (Master)
  'PGS', // Phó Giáo Sư (Associate Professor)
  'GS', // Giáo Sư (Professor)
  'TT', // Thư ký / Secretary
  'KH', // Khoa học / Science
];

export const LANGUAGE_RULES: Readonly<Record<string, LanguageRules>> = {
  en: base('en', EN),
  es: { ...base('es', ES), invertedMarks: true },
  fr: base('fr', FR),
  de: {
    ...base('de', DE),
    ordinals: true,
    ordinalPrefixes: DE_ORDINAL_PREFIXES,
    ordinalFollowers: DE_ORDINAL_FOLLOWERS,
  },
  it: base('it', IT),
  pt: base('pt', PT),
  nl: {
    ...base('nl', NL),
    ordinals: true,
    ordinalPrefixes: NL_ORDINAL_PREFIXES,
    ordinalFollowers: NL_ORDINAL_FOLLOWERS,
  },
  ko: base('ko', KO),
  vi: base('vi', VI),
};

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_RULES);

/**
 * The primary subtag of a BCP-47 language tag, lowercased — `es-ES` and
 * `es-419` both give `es`. The one place this split happens; segmentation
 * rule lookup (below) and TM pair retrieval (`@cat-tool/db`,
 * tm-format-spec.md §12.2) both key off it, and both want the same
 * answer for the same tag.
 */
export function primarySubtag(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0]!;
}

/**
 * Rules for a BCP-47 tag, falling back to the primary subtag.
 *
 * `es-ES` and `es-419` share rules: region affects vocabulary and number
 * formatting, not where sentences end.
 */
export function rulesFor(lang: string): LanguageRules {
  const primary = primarySubtag(lang);
  const rules = LANGUAGE_RULES[primary];
  if (!rules) {
    throw new Error(
      `no segmentation rules for "${lang}"; supported: ${SUPPORTED_LANGUAGES.join(', ')}`,
    );
  }
  return rules;
}
