/**
 * What every outbound draft-engine adapter shares (backlog #256;
 * `planning/translation-engine-spec.md` D29, D40): the error a failed call
 * throws, and the one retry loop. It lives once so that "no error carries a
 * body, a message or the key" is one rule in one place, not one per engine.
 *
 * **Retries are the adapter's** (`draftSuggestions` stops on the first thrown
 * error): a 429, a 5xx and a connection that fails are retried with backoff,
 * honouring `retry-after`, a few times; anything else, a 401 or 403 above all, is
 * thrown at once, because the same key will fail the same way a thousand times.
 */

/** The call failed in a way the run should stop on; the message is safe to show an owner. */
export class DraftEngineError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or null when no reply came. */
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'DraftEngineError';
  }
}

/** The knobs every adapter exposes, and the two test seams. */
export interface HttpOptions {
  /** Retries after the first attempt. Default 3. */
  readonly maxRetries?: number;
  /** Per attempt. Default 60 s. */
  readonly timeoutMs?: number;
  /** Test seams: a stub for the network, and a sleep that does not wait. */
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

const isRetryable = (status: number): boolean => status === 429 || status >= 500;

/** Seconds from a `retry-after` header, capped, or null. */
function retryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 30) * 1000 : null;
}

/**
 * POSTs `body` to `url` and returns the first successful reply.
 *
 * @param errorType reads a fixed word out of a failed reply (`overloaded_error`),
 *   or null; it must never return the reply's message, which may quote input.
 * @throws {DraftEngineError} on a refusal that would repeat, or once the retries
 *   are spent. The message says the status and the type, nothing else.
 */
export async function postWithRetry(
  url: string,
  init: { readonly headers: Record<string, string>; readonly body: string },
  options: HttpOptions,
  errorType: (reply: Response) => Promise<string | null>,
): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = options.maxRetries ?? 3;

  for (let attempt = 0; ; attempt++) {
    let status: number | null = null;
    let wait: number | null = null;
    let reply: Response | null = null;
    try {
      reply = await doFetch(url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
      status = reply.status;
      wait = retryAfterMs(reply.headers.get('retry-after'));
    } catch {
      // No reply: a refused connection, a reset, the timeout.
    }

    if (reply?.ok) return reply;

    const retryable = reply === null || isRetryable(reply.status);
    if (!retryable || attempt >= maxRetries) {
      const type = reply === null ? null : await errorType(reply);
      throw new DraftEngineError(
        reply === null
          ? 'the draft engine could not be reached'
          : `the draft engine answered ${status}${type ? ` (${type})` : ''}`,
        status,
      );
    }
    await sleep(wait ?? Math.min(500 * 2 ** attempt, 8000));
  }
}
