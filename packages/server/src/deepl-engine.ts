/**
 * The DeepL adapter behind the draft seam (backlog #256;
 * `planning/translation-engine-spec.md` D21, D40): a `DraftEngineAdapter` whose
 * `draft` is one `/v2/translate` call. Like the Anthropic adapter it is the only
 * code that sends a client's text to its company, and it is reached only through
 * `startDraftRun`, whose gate (`engineFor`) is asked before every segment — and a
 * client that consented to the Tessera engine has not consented to this one (D19).
 *
 * **What it sends.** Only `request.sourceText`: the segment with its visible
 * inline tags as `<tN>` markers (D22). DeepL gets no prompt, no memory unit and no
 * glossary term, which is what makes it the cheap arm of the D7 comparison and
 * not a second Tessera engine. `tag_handling: xml` keeps the markers and lets
 * DeepL move them with the words they wrap; whether they arrive intact is for
 * `validateDraft` to decide, as for any engine — a reply that drops or invents
 * one is refused, never repaired.
 *
 * **What it will not do.** The host is fixed in code (the free tier's, picked by
 * the key's `:fx` suffix, or the paid tier's): no environment value points it
 * elsewhere. The key goes in one header and nowhere else, and no error carries a
 * request body, a reply body or the key — DeepL's errors have a free-text
 * `message` and no fixed type, so a failure says the status and nothing more.
 * Retries and that rule live in `engine-http.ts`. Nothing here logs.
 *
 * **A pair it does not serve is refused before anything is sent or logged**
 * (`supports`, asked once per run). The list below is deliberately short and
 * fails closed: a language not in it is refused, and adding one is one line once
 * it has been checked against DeepL's own languages list.
 */

import type { DraftEngineAdapter, DraftRequest, DraftResult } from '@cat-tool/core';

import { postWithRetry, type HttpOptions } from './engine-http.js';

const PAID_BASE_URL = 'https://api.deepl.com';
const FREE_BASE_URL = 'https://api-free.deepl.com';

/** What provenance records as the model: DeepL names no version, and the endpoint is `v2`. */
export const DEEPL_MODEL = 'deepl-v2';

/**
 * The languages checked against DeepL's list (source codes; most are also
 * targets). Vietnamese is **not** here: whether DeepL serves it is an open point
 * of D14 that slice 5's setup closes, and a pair absent from this list is
 * refused rather than guessed at. CJK stays out of the first pairs (D14).
 */
const SOURCES: ReadonlySet<string> = new Set([
  'BG',
  'CS',
  'DA',
  'DE',
  'EL',
  'EN',
  'ES',
  'ET',
  'FI',
  'FR',
  'HU',
  'ID',
  'IT',
  'LT',
  'LV',
  'NB',
  'NL',
  'PL',
  'PT',
  'RO',
  'RU',
  'SK',
  'SL',
  'SV',
  'TR',
  'UK',
]);

/** A BCP 47 tag's language and, if present, its region, both upper-cased. */
function parts(tag: string): { language: string; region: string | null } {
  const [language = '', ...rest] = tag.split(/[-_]/);
  const region = rest.find((p) => /^[A-Za-z]{2}$/.test(p));
  return {
    language: language === 'no' ? 'NB' : language.toUpperCase(),
    region: region ? region.toUpperCase() : null,
  };
}

/** DeepL's source code for `tag`, or null when it does not serve it. */
export function deeplSource(tag: string): string | null {
  const { language } = parts(tag);
  return SOURCES.has(language) ? language : null;
}

/**
 * DeepL's target code for `tag`, or null. English and Portuguese must name a
 * variant: British and Brazilian when the tag says so, American and European
 * otherwise (the same default a reader of an unmarked tag would assume).
 */
export function deeplTarget(tag: string): string | null {
  const { language, region } = parts(tag);
  if (!SOURCES.has(language)) return null;
  if (language === 'EN') return region === 'GB' ? 'EN-GB' : 'EN-US';
  if (language === 'PT') return region === 'BR' ? 'PT-BR' : 'PT-PT';
  return language;
}

export interface DeeplAdapterOptions extends HttpOptions {
  readonly apiKey: string;
  /** A test server's origin; never set from the environment. */
  readonly baseUrl?: string;
}

interface TranslateReply {
  readonly translations?: ReadonlyArray<{ readonly text?: unknown }>;
}

/**
 * DeepL may write these five as entities in XML mode; the markup reader knows
 * only `&amp; &lt; &gt;`. One pass, so a source's own `&amp;quot;` is untouched.
 */
const QUOTE_ENTITIES = /&(quot|apos|#39|#x27);/g;
const decodeQuotes = (s: string): string =>
  s.replace(QUOTE_ENTITIES, (_, name: string) => (name === 'quot' ? '"' : "'"));

/** Builds the adapter. Nothing is sent until `draft` is called. */
export function createDeeplAdapter(options: DeeplAdapterOptions): DraftEngineAdapter {
  const url = `${
    options.baseUrl ?? (options.apiKey.endsWith(':fx') ? FREE_BASE_URL : PAID_BASE_URL)
  }/v2/translate`;

  return {
    engine: 'deepl',
    model: DEEPL_MODEL,
    supports: (srcLang, tgtLang) =>
      deeplSource(srcLang) !== null && deeplTarget(tgtLang) !== null,
    async draft(request: DraftRequest): Promise<DraftResult> {
      const source = deeplSource(request.srcLang);
      const target = deeplTarget(request.tgtLang);
      if (source === null || target === null) {
        // `supports` is asked first; this guards a caller that skipped it.
        throw new Error('the draft engine does not translate this language pair');
      }
      const body = JSON.stringify({
        text: [request.sourceText],
        source_lang: source,
        target_lang: target,
        tag_handling: 'xml',
        // A segment is one unit: no splitting, and no guessing at an outline
        // from tags the document never meant as structure.
        split_sentences: '0',
        outline_detection: false,
        preserve_formatting: true,
      });

      const reply = await postWithRetry(
        url,
        {
          headers: {
            'content-type': 'application/json',
            authorization: `DeepL-Auth-Key ${options.apiKey}`,
          },
          body,
        },
        options,
        () => Promise.resolve(null),
      );
      const parsed = (await reply.json()) as TranslateReply;
      const text = parsed.translations?.[0]?.text;
      return {
        text: typeof text === 'string' ? decodeQuotes(text) : '',
        model: DEEPL_MODEL,
        // DeepL bills by source character and reports no tokens. The characters
        // go in `inputTokens` so the run's ceiling bounds spend (D12) in the
        // only unit this engine has (D40).
        usage: { inputTokens: [...request.sourceText].length, outputTokens: 0 },
      };
    },
  };
}
