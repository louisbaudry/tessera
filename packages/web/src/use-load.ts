/**
 * One screen's data, loaded with the session's token and abandoned if the
 * screen goes away first. A 401 from any call means the session is gone
 * (expired, or revoked elsewhere): the token is forgotten and the login
 * screen returns (v1-spec.md §7.1).
 */
import { useEffect, useState } from 'react';

import { ApiError } from './api.js';
import { useSession } from './session-context.js';

export type Load<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'done'; readonly data: T };

/** `load` must be stable (`useCallback`); a new one reloads. */
export function useLoad<T>(
  load: (token: string, signal: AbortSignal) => Promise<T>,
): Load<T> {
  const { token, signOut } = useSession();
  // Tagged with the load it answers, so a result from a previous `load`
  // reads as loading without resetting state inside the effect.
  const [result, setResult] = useState<{ for: unknown; value: Load<T> } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const settle = (value: Load<T>) => {
      if (!controller.signal.aborted) setResult({ for: load, value });
    };
    load(token, controller.signal).then(
      (data) => settle({ state: 'done', data }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          signOut();
          return;
        }
        settle({
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return () => controller.abort();
  }, [load, token, signOut]);

  return result?.for === load ? result.value : { state: 'loading' };
}
