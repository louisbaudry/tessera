/**
 * Function words for the seven v1 languages, as data
 * (smart-glossary-spec.md §4.1, backlog #40): articles, prepositions,
 * conjunctions, pronouns, the commonest auxiliaries and negations. An
 * n-gram that begins or ends with one of these is not a term ("of the
 * invoice", "the"), so candidate extraction drops it.
 *
 * Small on purpose. A word belongs here only if a term never starts or
 * ends with it; one that merely tends to be filler ("new", "first") does
 * not, because a glossary that cannot hold "new customer" is worse than
 * a panel with one extra row. Elided forms are here as the bare stems an
 * apostrophe leaves behind (`l'accord` is the words `l` and `accord`;
 * `customer's` is `customer` and `s`). Same discipline as `segment/rules.ts`'s
 * abbreviation lists — a list earns a word one failing case at a time —
 * and not a linguistics project (spec §10.2). Entries are lowercase, as
 * `termKey` leaves them.
 */

import { primarySubtag } from '../model/lang.js';

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const STOPWORDS = {
  en: words(`
    a an the and or but nor so yet of in on at by for with without from to into onto
    over under about above below between among through during before after as than
    is are was were be been being am do does did done have has had having will would
    shall should can could may might must not no this that these those it its he she
    they them their his her we us our you your i me my who whom whose which what
    there here if then also s t ll re ve d m
  `),
  es: words(`
    el la los las un una unos unas y e o u ni pero sino que de del al a en por para
    con sin sobre entre hacia hasta desde durante tras ante bajo contra segun como
    cuando donde es son era eran fue fueron ser estar esta estan estaba ha han he
    hemos habia hay no se su sus mi mis tu tus nos lo le les me te este esta estos
    estas ese esa esos esas aquel aquella aquellos aquellas
  `),
  fr: words(`
    le la les l un une des du de d et ou mais ni car donc or que qu qui quoi dont
    où au aux à en dans par pour avec sans sur sous entre vers chez depuis pendant
    avant après contre comme est sont était étaient fut être a ont avait avoir ne n
    pas plus se s sa son ses mon ma mes ton ta tes notre nos votre vos leur leurs
    ce c cet cette ces il elle ils elles on nous vous je j tu me m te t lui y
  `),
  de: words(`
    der die das den dem des ein eine einen einem einer eines und oder aber sondern
    denn weil dass daß wenn als wie von vom zu zum zur mit ohne aus bei nach vor
    über unter auf an in im am um für gegen durch bis seit zwischen während ist sind
    war waren wird werden wurde wurden sein hat haben hatte nicht kein keine keinen
    sich sein seine seinen seiner ihr ihre ihren ihrer es er sie wir ihr ich du
    dieser diese dieses diesen auch noch nur
  `),
  it: words(`
    il lo la i gli le l un uno una e ed o ma però anche che chi cui di del dello
    della dei degli delle d a al allo alla ai agli alle da dal dallo dalla dai dagli
    dalle in nel nello nella nei negli nelle con su sul sullo sulla sui sugli sulle
    per tra fra senza sotto sopra è sono era erano fu essere ha hanno ho abbiamo
    non si suo sua suoi sue mio mia miei mie questo questa questi queste quello
    quella quelli quelle dell all nell sull dall quest quell c
  `),
  pt: words(`
    o a os as um uma uns umas e ou mas nem que de do da dos das em no na nos nas
    por pelo pela pelos pelas para pra com sem sobre entre até desde durante após
    perante contra como quando onde é são era eram foi foram ser estar está estão
    há tem têm tinha ter não se seu sua seus suas meu minha meus minhas nosso
    nossa nossos nossas este esta estes estas esse essa esses essas aquele aquela
    aqueles aquelas ao aos à às
  `),
  nl: words(`
    de het een en of maar want dat die dit deze van in op aan bij met zonder voor
    na naar uit over onder tussen door tot om tegen tijdens is zijn was waren wordt
    worden werd werden ben bent heeft hebben had hadden niet geen er hier daar zich
    zijn haar hun ons onze uw mijn jouw je ik jij hij zij ze wij we jullie u men
    als dan ook nog wel t s
  `),
} as const satisfies Record<string, ReadonlySet<string>>;

export type GlossaryLanguage = keyof typeof STOPWORDS;

/** The languages candidate extraction supports: the seven v1 ones. */
export const GLOSSARY_LANGUAGES = Object.keys(STOPWORDS) as GlossaryLanguage[];

export class UnsupportedGlossaryLanguage extends Error {
  constructor(lang: string) {
    super(
      `No stopword list for source language "${lang}". Supported: ${GLOSSARY_LANGUAGES.join(', ')}.`,
    );
    this.name = 'UnsupportedGlossaryLanguage';
  }
}

/**
 * The stopwords for a BCP-47 tag, by its primary subtag (`primarySubtag`,
 * the one definition of that split). Throws for a language with no list —
 * as `rulesFor` does — rather than extracting with none and flagging every
 * article: for a script with no spaces between words (zh, ja, th) an n-gram
 * of whitespace-separated words is meaningless anyway.
 */
export function stopwordsFor(lang: string): ReadonlySet<string> {
  const primary = primarySubtag(lang) as GlossaryLanguage;
  const list = STOPWORDS[primary];
  if (!list) throw new UnsupportedGlossaryLanguage(lang);
  return list;
}
