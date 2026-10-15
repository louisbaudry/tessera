/**
 * A scripted draft engine for tests (`planning/translation-engine-spec.md` §6:
 * "all offline: no key, no network, a fake `DraftEngine` that returns scripted
 * drafts"; backlog #134).
 *
 * It lives in the package, not in a test file, because slice 3's job and
 * route tests in `db` and `server` drive the same seam. It makes no network
 * call and has no state beyond the requests it recorded.
 */

import type { DraftEngine } from './engine.js';
import type { DraftEngineAdapter, DraftRequest, DraftResult } from './draft.js';

export interface FakeDraftEngine extends DraftEngineAdapter {
  /** Every request received, in order: what a gate test asserts is empty. */
  readonly calls: readonly DraftRequest[];
}

/**
 * An engine answering each request with `reply`: a text, or a function of the
 * request (so a test can echo the marked source, drop a tag, or throw).
 */
export function createFakeEngine(
  reply: string | ((request: DraftRequest) => string | DraftResult),
  options: { engine?: DraftEngine; model?: string } = {},
): FakeDraftEngine {
  const calls: DraftRequest[] = [];
  const model = options.model ?? 'fake-model';
  return {
    engine: options.engine ?? 'tessera',
    calls,
    draft(request) {
      calls.push(request);
      const answer = typeof reply === 'function' ? reply(request) : reply;
      const result: DraftResult =
        typeof answer === 'string'
          ? { text: answer, model, usage: { inputTokens: 100, outputTokens: 20 } }
          : answer;
      return Promise.resolve(result);
    },
  };
}
