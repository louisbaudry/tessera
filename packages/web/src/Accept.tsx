/**
 * The page an invitation link opens (backlog #111): one of the two screens reached
 * without a session. With `kind="staff"` (backlog #210) it is the page a staff link
 * opens: the same form, a different endpoint and wording, and no "already has an
 * account" path, because a person is staff of one tenant and joining as an existing
 * account is not offered. The invitee sees the address the link was made for, chooses a password,
 * and is signed in as a vendor with the owner's roster entry already in place. A link
 * that cannot be used, for any reason, is one plain message. If the address already
 * has an account the server says so (a 409) and the page asks them to sign in with
 * it instead, which joins that owner's roster as themselves in one step (backlog #187).
 *
 * Each step can be taken with Microsoft or Google instead of a password (issue #317,
 * `planning/sso-spec.md` §2a): the page leaves for the provider keeping the link's token, and
 * comes back here (`returning`) with the code, which accepts or joins with the link again.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SsoProvider } from '@cat-tool/core';

import { api, ApiError } from './api.js';
import { acceptProblem } from './invitations.js';
import {
  clearBinding,
  leaveForProvider,
  loadBinding,
  PROVIDER_LABEL,
  type SsoFragment,
} from './sso.js';

type InvitePurpose = 'staff_invite' | 'vendor_invite' | 'join';

/** The one thing said when a sign-in with a provider does not work, whatever the reason. */
const SSO_FAILED = 'That sign-in did not work. Try again, or use a password.';

type Opened =
  | { readonly state: 'loading' }
  | { readonly state: 'invalid' }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'open'; readonly email: string }
  /** The address already has an account: sign in with its password to join. */
  | { readonly state: 'existing'; readonly email: string };

export function Accept({
  token,
  onToken,
  kind = 'vendor',
  returning,
}: {
  token: string;
  /** Whose link this is: a vendor's roster link or a colleague's staff link. */
  kind?: 'vendor' | 'staff';
  /** Called with the new vendor's session; the shell stores it and goes home. */
  onToken: (session: string) => void;
  /** Back from a provider: what the sign-in was for, and what it brought back. */
  returning?: { readonly purpose: InvitePurpose; readonly fragment: SsoFragment };
}) {
  const staff = kind === 'staff';
  const [opened, setOpened] = useState<Opened>({ state: 'loading' });
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(
    returning?.fragment.kind === 'refused' ? SSO_FAILED : null,
  );
  const [busy, setBusy] = useState(returning?.fragment.kind === 'code');
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  // The code is single use: a second run of the effect (React's development double run) must not spend it again.
  const finishing = useRef(false);

  useEffect(() => {
    let live = true;
    api.ssoProviders().then(
      (found) => {
        if (live) setProviders(found.providers);
      },
      // The buttons are an extra: without them the password form is as it was.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (returning?.fragment.kind !== 'code' || finishing.current) return;
    finishing.current = true;
    const binding = loadBinding();
    clearBinding();
    const { purpose } = returning;
    const code = returning.fragment.code;
    (binding === null
      ? Promise.reject(new Error('no browser secret'))
      : api.inviteSsoFinish(purpose, token, code, binding)
    ).then(
      (done) => onToken(done.token),
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 404)
          setOpened({ state: 'invalid' });
        else if (err instanceof ApiError && (err.status === 403 || err.status === 409))
          setError(err.message);
        else setError(SSO_FAILED);
      },
    );
  }, [returning, token, onToken]);

  const continueWith = async (provider: SsoProvider, purpose: InvitePurpose) => {
    setBusy(true);
    setError(null);
    const problem = await leaveForProvider(
      (binding) => api.inviteSsoStart(purpose, token, provider, binding),
      { purpose, token },
    );
    if (problem !== '') {
      setError(problem);
      setBusy(false);
    }
  };

  const providerButtons = (purpose: InvitePurpose, verb: string) =>
    providers.length > 0 && (
      <div className="sso">
        <span>or</span>
        {providers.map((provider) => (
          <button
            key={provider}
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void continueWith(provider, purpose)}
          >
            {verb} {PROVIDER_LABEL[provider]}
          </button>
        ))}
      </div>
    );

  useEffect(() => {
    const controller = new AbortController();
    (staff
      ? api.openStaffInvitation(token, controller.signal)
      : api.openInvitation(token, controller.signal)
    ).then(
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
  }, [token, staff]);

  const problem = acceptProblem(password, repeat);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setBusy(true);
    setError(null);
    try {
      const done = await (staff
        ? api.acceptStaffInvitation(token, password)
        : api.acceptInvitation(token, password));
      onToken(done.token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setOpened({ state: 'invalid' });
      else if (
        err instanceof ApiError &&
        err.status === 409 &&
        opened.state === 'open' &&
        !staff
      ) {
        setOpened({ state: 'existing', email: opened.email });
        setPassword('');
        setRepeat('');
      } else setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // The address has an account: its own password signs in and joins in one step, because
  // on a tenant's host the account has no session there until it is on the roster (D14).
  const signInAndJoin = async (event: FormEvent) => {
    event.preventDefault();
    if (opened.state !== 'existing') return;
    setBusy(true);
    setError(null);
    try {
      onToken((await api.joinSignin(token, opened.email, password)).token);
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
      {opened.state === 'existing' && (
        <form onSubmit={(e) => void signInAndJoin(e)}>
          <h1>Tessera</h1>
          <p>
            <strong>{opened.email}</strong> already has an account. Sign in with its
            password to join this roster.
          </p>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || password === ''}>
            {busy ? 'Joining\u2026' : 'Sign in and join'}
          </button>
          {providerButtons('join', 'Join with')}
        </form>
      )}
      {opened.state === 'open' && (
        <form onSubmit={(e) => void submit(e)}>
          <h1>Tessera</h1>
          <p>
            You are joining {staff ? 'the staff as' : 'as'}{' '}
            <strong>{opened.email}</strong>. Choose a password.
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
          {providerButtons(staff ? 'staff_invite' : 'vendor_invite', 'Join with')}
        </form>
      )}
    </main>
  );
}
