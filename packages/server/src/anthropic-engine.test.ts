/**
 * The Anthropic adapter against a stubbed network (backlog #136): the request
 * it sends, what it reads back, what it retries, and that nothing it throws
 * can carry the key or a client's text. No key, no network.
 */

import type { DraftRequest } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import { createAnthropicAdapter, DraftEngineError } from './anthropic-engine.js';

const KEY = 'sk-test-KEY-never-in-an-error';
const request: DraftRequest = {
  srcLang: 'en',
  tgtLang: 'es',
  sourceText: 'Hello',
  prompt: { version: 'v', system: 'SYSTEM TEXT', user: 'USER TEXT', inputSha256: 'h' },
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const ok = (text = 'Hola') =>
  json(200, {
    model: 'claude-served-1',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 120, output_tokens: 7 },
  });

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

const adapter = (s: ReturnType<typeof stub>, over: Record<string, unknown> = {}) => {
  const sleeps: number[] = [];
  return {
    sleeps,
    adapter: createAnthropicAdapter({
      apiKey: KEY,
      model: 'claude-wanted-1',
      fetch: s.fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      ...over,
    }),
  };
};

describe('createAnthropicAdapter', () => {
  it('names its engine and model before anything is sent', () => {
    const { adapter: a } = adapter(stub());
    expect(a.engine).toBe('tessera');
    expect(a.model).toBe('claude-wanted-1');
  });

  it('sends one Messages call with the key in a header and the prompt in the body', async () => {
    const s = stub(ok());
    const { adapter: a } = adapter(s);
    const result = await a.draft(request);

    expect(s.calls).toHaveLength(1);
    const { url, init } = s.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'claude-wanted-1',
      max_tokens: 4096,
      system: 'SYSTEM TEXT',
      messages: [{ role: 'user', content: 'USER TEXT' }],
    });
    // The key travels in one header and is nowhere else.
    expect(init.body as string).not.toContain(KEY);
    expect(result).toEqual({
      text: 'Hola',
      model: 'claude-served-1',
      usage: { inputTokens: 120, outputTokens: 7 },
    });
  });

  it('joins text blocks, ignores others, and falls back to the requested model', async () => {
    const s = stub(
      json(200, {
        content: [
          { type: 'text', text: 'Hola ' },
          { type: 'thinking', text: 'ignored' },
          { type: 'text', text: 'mundo' },
        ],
      }),
    );
    const result = await adapter(s).adapter.draft(request);
    expect(result).toEqual({
      text: 'Hola mundo',
      model: 'claude-wanted-1',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it('returns nothing for a reply cut off at the output limit, so it is refused and not offered', async () => {
    const s = stub(
      json(200, {
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'Hola mun' }],
      }),
    );
    expect((await adapter(s).adapter.draft(request)).text).toBe('');
  });

  it('retries a 429 after the time Anthropic names, then succeeds', async () => {
    const s = stub(
      json(429, { error: { type: 'rate_limit_error' } }, { 'retry-after': '2' }),
      ok(),
    );
    const built = adapter(s);
    expect((await built.adapter.draft(request)).text).toBe('Hola');
    expect(s.calls).toHaveLength(2);
    expect(built.sleeps).toEqual([2000]);
  });

  it('retries a 5xx and a dropped connection with growing waits', async () => {
    const s = stub(
      json(529, { error: { type: 'overloaded_error' } }),
      new Error('ECONNRESET'),
      ok(),
    );
    const built = adapter(s);
    expect((await built.adapter.draft(request)).text).toBe('Hola');
    expect(built.sleeps).toEqual([500, 1000]);
  });

  it('gives up after the retries and says the status and type, nothing else', async () => {
    const hostile = {
      error: { type: 'overloaded_error', message: `echoing USER TEXT and ${KEY}` },
    };
    const s = stub(json(529, hostile), json(529, hostile), json(529, hostile));
    const built = adapter(s, { maxRetries: 2 });
    const error = await built.adapter.draft(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DraftEngineError);
    expect((error as DraftEngineError).status).toBe(529);
    expect((error as Error).message).toBe(
      'the draft engine answered 529 (overloaded_error)',
    );
    expect((error as Error).message).not.toContain('USER TEXT');
    expect((error as Error).message).not.toContain(KEY);
    expect(s.calls).toHaveLength(3);
  });

  it('does not retry a refusal that would repeat: a bad key is thrown at once', async () => {
    const s = stub(json(401, { error: { type: 'authentication_error' } }));
    const built = adapter(s);
    await expect(built.adapter.draft(request)).rejects.toThrow(
      'the draft engine answered 401 (authentication_error)',
    );
    expect(s.calls).toHaveLength(1);
    expect(built.sleeps).toEqual([]);
  });

  it('says it could not be reached when no reply ever came, without the cause', async () => {
    const s = stub(new Error(`connect failed to ${KEY}`), new Error('x'));
    const error = await adapter(s, { maxRetries: 1 })
      .adapter.draft(request)
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe('the draft engine could not be reached');
    expect((error as DraftEngineError).status).toBeNull();
  });

  it('ignores an error type that is not a plain word', async () => {
    const s = stub(json(400, { error: { type: 'x'.repeat(200) } }));
    await expect(adapter(s).adapter.draft(request)).rejects.toThrow(
      /^the draft engine answered 400$/,
    );
  });
});
