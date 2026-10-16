/**
 * The DeepL adapter against a stubbed network (backlog #256): the request it
 * sends, what it reads back, the pairs it refuses, and that nothing it throws can
 * carry the key or a client's text. No key, no network.
 */

import type { DraftRequest } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import {
  createDeeplAdapter,
  DEEPL_MODEL,
  deeplSource,
  deeplTarget,
} from './deepl-engine.js';
import { DraftEngineError } from './engine-http.js';

const KEY = 'deepl-test-KEY-never-in-an-error';
const request: DraftRequest = {
  srcLang: 'en',
  tgtLang: 'es',
  sourceText: 'Hello <t1>big</t1> &amp; world',
  prompt: { version: 'v', system: 'SYSTEM TEXT', user: 'USER TEXT', inputSha256: 'h' },
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const ok = (text = 'Hola <t1>gran</t1> &amp; mundo') =>
  json(200, { translations: [{ detected_source_language: 'EN', text }] });

/** A network stub answering from a script, recording each call. */
function stub(...script: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = script.shift();
    if (next === undefined) throw new Error('the stub ran out of answers');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, calls };
}

const build = (s: ReturnType<typeof stub>, over: Record<string, unknown> = {}) => {
  const sleeps: number[] = [];
  return {
    sleeps,
    adapter: createDeeplAdapter({
      apiKey: KEY,
      fetch: s.fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      ...over,
    }),
  };
};

describe('createDeeplAdapter', () => {
  it('names its engine and model before anything is sent', () => {
    const { adapter } = build(stub());
    expect(adapter.engine).toBe('deepl');
    expect(adapter.model).toBe(DEEPL_MODEL);
  });

  it('sends only the marked source text, the key in one header, to the paid host', async () => {
    const s = stub(ok());
    const result = await build(s).adapter.draft(request);

    expect(s.calls).toHaveLength(1);
    const { url, init } = s.calls[0]!;
    expect(url).toBe('https://api.deepl.com/v2/translate');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`DeepL-Auth-Key ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      text: ['Hello <t1>big</t1> &amp; world'],
      source_lang: 'EN',
      target_lang: 'ES',
      tag_handling: 'xml',
      split_sentences: '0',
      outline_detection: false,
      preserve_formatting: true,
    });
    // The prompt is the Tessera engine's; DeepL never sees it. Nor the key in a body.
    expect(init.body as string).not.toContain('SYSTEM TEXT');
    expect(init.body as string).not.toContain('USER TEXT');
    expect(init.body as string).not.toContain(KEY);
    expect(result).toEqual({
      text: 'Hola <t1>gran</t1> &amp; mundo',
      model: DEEPL_MODEL,
      usage: { inputTokens: [...request.sourceText].length, outputTokens: 0 },
    });
  });

  it('uses the free host for a key that ends in :fx', async () => {
    const s = stub(ok());
    await build(s, { apiKey: `${KEY}:fx` }).adapter.draft(request);
    expect(s.calls[0]!.url).toBe('https://api-free.deepl.com/v2/translate');
  });

  it('decodes quote entities but leaves a source’s own escaped one alone', async () => {
    const s = stub(ok('&quot;Hola&quot; l&apos;a &#39;b&#39; &amp;quot;'));
    const result = await build(s).adapter.draft(request);
    expect(result.text).toBe(`"Hola" l'a 'b' &amp;quot;`);
  });

  it('returns an empty text for a reply with no translation, so it is refused as empty', async () => {
    const s = stub(json(200, { translations: [] }));
    expect((await build(s).adapter.draft(request)).text).toBe('');
  });

  it('retries a 429 after the time DeepL names, then succeeds', async () => {
    const s = stub(
      json(429, { message: 'Too many requests' }, { 'retry-after': '2' }),
      ok(),
    );
    const built = build(s);
    expect((await built.adapter.draft(request)).text).toContain('Hola');
    expect(s.calls).toHaveLength(2);
    expect(built.sleeps).toEqual([2000]);
  });

  it('gives up after the retries and says the status, nothing else', async () => {
    const hostile = { message: `echoing USER TEXT and ${KEY}` };
    const s = stub(json(503, hostile), json(503, hostile), json(503, hostile));
    const built = build(s, { maxRetries: 2 });
    const error = await built.adapter.draft(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DraftEngineError);
    expect((error as DraftEngineError).status).toBe(503);
    expect((error as Error).message).toBe('the draft engine answered 503');
    expect((error as Error).message).not.toContain('USER TEXT');
    expect((error as Error).message).not.toContain(KEY);
    expect(s.calls).toHaveLength(3);
  });

  it('does not retry a refusal that would repeat: a bad key (403) and an exhausted quota (456)', async () => {
    for (const status of [403, 456]) {
      const s = stub(json(status, { message: 'nope' }));
      const built = build(s);
      await expect(built.adapter.draft(request)).rejects.toThrow(
        `the draft engine answered ${status}`,
      );
      expect(s.calls).toHaveLength(1);
      expect(built.sleeps).toEqual([]);
    }
  });

  it('says it could not be reached when no reply ever came, without the cause', async () => {
    const s = stub(new Error(`connect failed to ${KEY}`), new Error('x'));
    const error = await build(s, { maxRetries: 1 })
      .adapter.draft(request)
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe('the draft engine could not be reached');
    expect((error as DraftEngineError).status).toBeNull();
  });

  it('sends nothing for a pair it does not serve', async () => {
    const s = stub();
    const { adapter } = build(s);
    await expect(adapter.draft({ ...request, tgtLang: 'vi' })).rejects.toThrow(
      'does not translate this language pair',
    );
    expect(s.calls).toHaveLength(0);
  });
});

describe('the pairs DeepL is asked for', () => {
  it('serves the first Romance and Germanic pairs, and refuses Vietnamese until it is checked (D14)', () => {
    const { adapter } = build(stub());
    expect(adapter.supports!('en', 'es')).toBe(true);
    expect(adapter.supports!('en-GB', 'de')).toBe(true);
    expect(adapter.supports!('es', 'en')).toBe(true);
    expect(adapter.supports!('en', 'vi')).toBe(false);
    expect(adapter.supports!('vi', 'en')).toBe(false);
    expect(adapter.supports!('en', 'xx')).toBe(false);
    expect(adapter.supports!('', 'es')).toBe(false);
  });

  it('names the variant English and Portuguese targets require', () => {
    expect(deeplTarget('en')).toBe('EN-US');
    expect(deeplTarget('en-US')).toBe('EN-US');
    expect(deeplTarget('en-GB')).toBe('EN-GB');
    expect(deeplTarget('pt')).toBe('PT-PT');
    expect(deeplTarget('pt-BR')).toBe('PT-BR');
    expect(deeplTarget('es-MX')).toBe('ES');
    expect(deeplTarget('no')).toBe('NB');
  });

  it('a source is the bare language, whatever region the tag carries', () => {
    expect(deeplSource('en-GB')).toBe('EN');
    expect(deeplSource('pt_BR')).toBe('PT');
    expect(deeplSource('vi')).toBeNull();
  });
});
