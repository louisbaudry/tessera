/**
 * The page an invitation link opens (backlog #111): the one screen reached without a
 * session. The invitee sees the address the link was made for, chooses a password,
 * and is signed in as a vendor with the owner's roster entry already in place. A link
 * that cannot be used, for any reason, is one plain message.
 */
import { useEffect, useState, type FormEvent } from 'react';

import { api, ApiError } from './api.js';
import { acceptProblem } from './invitations.js';

type Opened =
  | { readonly state: 'loading' }
  | { readonly state: 'invalid' }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'open'; readonly email: string };

export function Accept({
  token,
  onToken,
}: {
  token: string;
  /** Called with the new vendor's session; the shell stores it and goes home. */
  onToken: (session: string) => void;
}) {
  const [opened, setOpened] = useState<Opened>({ state: 'loading' });
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api.openInvitation(token, controller.signal).then(
      ({ email }) => setOpened({ state: 'open', email }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setOpened(
          err instanceof ApiError && err.status === 404
            ? { state: 'invalid' }
            : {
                state: 'error',
                message: err instanceof Error ? err.message : String(err),
              },
        );
      },
    );
    return () => controller.abort();
  }, [token]);

  const problem = acceptProblem(password, repeat);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api.acceptInvitation(token, password);
      onToken(done.token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setOpened({ state: 'invalid' });
      else setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <main className="login">
      {opened.state === 'loading' && <p className="muted">Loading{'…'}</p>}
      {opened.state === 'error' && <p className="error">{opened.message}</p>}
      {opened.state === 'invalid' && (
        <div className="invite-invalid">
          <h1>Tessera</h1>
          <p role="alert">
            This invitation link is not valid. It may have been used, withdrawn or have
            expired: ask the person who invited you for a new one.
          </p>
          <a href="#/">Sign in</a>
        </div>
      )}
      {opened.state === 'open' && (
        <form onSubmit={(e) => void submit(e)}>
          <h1>Tessera</h1>
          <p>
            You are joining as <strong>{opened.email}</strong>. Choose a password.
          </p>
          <label>
            Password
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            Repeat the password
            <input
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              required
            />
          </label>
          {password !== '' && repeat !== '' && problem && (
            <p className="muted">{problem}</p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || problem !== null}>
            {busy ? 'Joining…' : 'Set password and join'}
          </button>
        </form>
      )}
    </main>
  );
}
