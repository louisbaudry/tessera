/**
 * The least login that reaches the grid (v1-spec.md §7.1): the server's
 * `POST /api/login`, plus "Continue with Microsoft or Google" when the operator has set
 * those up (backlog #214, `planning/sso-spec.md` D4). Accounts are made by the server's
 * `create-account` script or an invitation, never here, and signing in with a provider
 * creates no one: it opens an account that already exists.
 *
 * A sign-in at a provider comes back here with a one-time code in the address
 * (`#sso=<code>`). It is read once, taken out of the address before anything else happens,
 * and redeemed together with the secret this browser kept while it was away.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { SsoProvider } from '@cat-tool/core';

import { api } from './api.js';
import {
  clearBinding,
  loadBinding,
  makeBinding,
  parseSsoFragment,
  PROVIDER_LABEL,
  saveBinding,
  type SsoFragment,
} from './sso.js';

/** The one thing a person is told when a sign-in with a provider does not work, whatever the reason. */
const SSO_FAILED =
  'That sign-in did not work. Use your password, or ask for an invitation.';

/**
 * What the address held when the page was opened, taken out of it the first time anyone asks.
 * Once, at module level, because the code is single use: it must not stay in the history, and a
 * second render of the component (React runs effects twice in development) must find the same
 * answer and not a cleared address.
 */
let landing: SsoFragment | null | undefined;
function takeLanding(): SsoFragment | null {
  if (landing === undefined) {
    landing = parseSsoFragment(window.location.hash);
    if (landing !== null) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      );
    }
  }
  return landing;
}

/** The redemption of a returning code, started once whatever the number of renders. */
let redeeming: Promise<string> | undefined;
function redeemLanding(code: string): Promise<string> {
  redeeming ??= (async () => {
    const binding = loadBinding();
    clearBinding();
    if (binding === null) throw new Error('no browser secret');
    return (await api.ssoRedeem(code, binding)).token;
  })();
  return redeeming;
}

export function Login({ onToken }: { onToken: (token: string) => void }) {
  const landed = takeLanding();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(
    landed?.kind === 'refused' ? SSO_FAILED : null,
  );
  const [busy, setBusy] = useState(landed?.kind === 'code');
  const [providers, setProviders] = useState<SsoProvider[]>([]);

  useEffect(() => {
    if (landed?.kind === 'code') {
      redeemLanding(landed.code).then(onToken, () => {
        setError(SSO_FAILED);
        setBusy(false);
      });
      return;
    }
    let live = true;
    api.ssoProviders().then(
      (found) => {
        if (live) setProviders(found.providers);
      },
      // The buttons are an extra: a server that cannot say leaves the password form as it was.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [landed, onToken]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.login(email, password);
      onToken(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const continueWith = async (provider: SsoProvider) => {
    setBusy(true);
    setError(null);
    const binding = makeBinding((n) => crypto.getRandomValues(new Uint8Array(n)));
    if (!saveBinding(binding)) {
      setError('This browser will not keep what a sign-in needs. Use your password.');
      setBusy(false);
      return;
    }
    try {
      const { url } = await api.ssoStart(provider, binding);
      window.location.assign(url);
    } catch {
      clearBinding();
      setError(SSO_FAILED);
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form onSubmit={(e) => void submit(e)}>
        <h1>Tessera</h1>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in\u2026' : 'Sign in'}
        </button>
        {providers.length > 0 && (
          <div className="sso">
            <span>or</span>
            {providers.map((provider) => (
              <button
                key={provider}
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void continueWith(provider)}
              >
                Continue with {PROVIDER_LABEL[provider]}
              </button>
            ))}
          </div>
        )}
      </form>
    </main>
  );
}
