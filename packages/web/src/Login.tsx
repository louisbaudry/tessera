/**
 * The least login that reaches the grid (v1-spec.md §7.1): the server's
 * `POST /api/login`, nothing else. Accounts are made by the server's
 * `create-account` script, never here.
 */
import { useState, type FormEvent } from 'react';

import { api } from './api.js';

export function Login({ onToken }: { onToken: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      </form>
    </main>
  );
}
