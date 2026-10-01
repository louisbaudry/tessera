/**
 * A write a screen sends on a click: one at a time, its failure shown
 * where it was asked for, and a 401 the end of the session as for a
 * load (`use-load.ts`).
 */
import { useCallback, useState } from 'react';

import { ApiError } from './api.js';
import { useSession } from './session-context.js';

export interface Action {
  readonly busy: boolean;
  readonly error: string | null;
  /** Runs `write` with the session's token; resolves to its result, or null if it failed. */
  readonly run: <T>(write: (token: string) => Promise<T>) => Promise<T | null>;
}

export function useAction(): Action {
  const { token, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(write: (token: string) => Promise<T>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        return await write(token);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) signOut();
        else setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [token, signOut],
  );

  return { busy, error, run };
}
