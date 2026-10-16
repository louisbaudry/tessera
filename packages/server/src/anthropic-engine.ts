/**
 * The Anthropic adapter behind the draft seam (backlog #136;
 * `planning/translation-engine-spec.md` §5): one `DraftEngineAdapter` whose
 * `draft` is one Messages API call. It is the only code that sends a client's
 * text to Anthropic, and it is reached only through `startDraftRun`, whose gate
 * (`engineFor`) is asked before every segment: a new outbound call goes through
 * that gate, never around it.
 *
 * **What it will not do.** The host is fixed in code: no environment value
 * points it elsewhere, so no setting can redirect a client's text. The key goes
 * in one header and nowhere else, and no error carries a request body, a reply
 * body or the key — a failure says the status and Anthropic's error `type`,
 * which is a fixed word (`overloaded_error`), not the message, which may quote
 * input. Nothing here logs.
 *
 * Retries and the error type live in `engine-http.ts`, shared with the DeepL adapter.
 */

import type { DraftEngineAdapter, DraftRequest, DraftResult } from '@cat-tool/core';

import { postWithRetry, type HttpOptions } from './engine-http.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

export interface AnthropicAdapterOptions extends HttpOptions {
  readonly apiKey: string;
  /** The model id to ask for; recorded by the caller before the send. */
  readonly model: string;
  /** Output ceiling for one segment's translation; far above a sentence. */
  readonly maxTokens?: number;
  /** A test server's origin; never set from the environment. */
  readonly baseUrl?: string;
}

interface MessagesReply {
  readonly model?: unknown;
  readonly stop_reason?: unknown;
  readonly content?: unknown;
  readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown };
}

const count = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;

/** Builds the adapter. Nothing is sent until `draft` is called. */
export function createAnthropicAdapter(
  options: AnthropicAdapterOptions,
): DraftEngineAdapter {
  const url = `${options.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`;

  return {
    engine: 'tessera',
    model: options.model,
    async draft(request: DraftRequest): Promise<DraftResult> {
      const body = JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens ?? 4096,
        system: request.prompt.system,
        messages: [{ role: 'user', content: request.prompt.user }],
      });

      const reply = await postWithRetry(
        url,
        {
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': API_VERSION,
          },
          body,
        },
        options,
        errorType,
      );
      return readReply(await reply.json(), options.model);
    },
  };
}

/** Anthropic's `error.type`, a fixed word; never its `message`. */
async function errorType(reply: Response): Promise<string | null> {
  try {
    const parsed = (await reply.json()) as { error?: { type?: unknown } };
    const type = parsed.error?.type;
    return typeof type === 'string' && /^[a-z_]{1,40}$/.test(type) ? type : null;
  } catch {
    return null;
  }
}

/**
 * The reply's text and usage. A reply cut off at the output limit comes back
 * empty, which validation refuses and counts as `empty`: a truncated
 * translation is never offered, and one long segment does not stop a run.
 */
function readReply(raw: unknown, requestedModel: string): DraftResult {
  const reply = (raw ?? {}) as MessagesReply;
  const blocks = Array.isArray(reply.content) ? (reply.content as unknown[]) : [];
  const text = blocks
    .map((b) => {
      const block = b as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
  return {
    text: reply.stop_reason === 'max_tokens' ? '' : text,
    model:
      typeof reply.model === 'string' && reply.model !== ''
        ? reply.model
        : requestedModel,
    usage: {
      inputTokens: count(reply.usage?.input_tokens),
      outputTokens: count(reply.usage?.output_tokens),
    },
  };
}
