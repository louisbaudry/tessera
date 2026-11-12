/**
 * The signed-in account's own settings (issue #317, `planning/sso-spec.md` D3, D7, §2a):
 * the Microsoft and Google sign-ins linked to it, a button to link another and one to unlink each
 * (refused for the last way in), for a tenant's admin the single sign-on policy, for staff the
 * chat assistants connected by signing in (backlog #381), and the editor's keys (issue #193),
 * kept in this browser only.
 *
 * Linking leaves for the provider and comes back here with a code (`returning`), which the
 * server redeems for this session's own account only.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { SsoProvider, TenantRole } from '@cat-tool/core';

import {
  canUnlink,
  draftOf,
  policyOf,
  policyProblem,
  type PolicyDraft,
} from './account-settings.js';
import { api, ApiError, type ConnectionView, type LinkedIdentity } from './api.js';
import { formatDeadline } from './jobs.js';
import { useSession } from './session-context.js';
import {
  clearBinding,
  leaveForProvider,
  loadBinding,
  PROVIDER_LABEL,
  type SsoFragment,
} from './sso.js';
import { ShortcutSettings } from './ShortcutSettings.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

const LINK_FAILED = 'That sign-in could not be linked. Try again.';

export function Account({
  staffRole,
  returning,
}: {
  staffRole: TenantRole | null;
  /** Back from a provider after starting a link: what it brought back. */
  returning?: SsoFragment;
}) {
  return (
    <div className="page account">
      <h2>Account</h2>
      <LinkedSignIns returning={returning} />
      {staffRole === 'admin' && <Policy />}
      {staffRole !== null && <Connections />}
      <ShortcutSettings />
    </div>
  );
}

function LinkedSignIns({ returning }: { returning?: SsoFragment }) {
  const { token, signOut } = useSession();
  // Bumped after a write: the list is read again from the server instead of patched.
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<string | null>(
    returning?.kind === 'refused' ? LINK_FAILED : null,
  );
  // The code is single use: React's development double run must not spend it twice.
  const finishing = useRef(false);

  useEffect(() => {
    if (returning?.kind !== 'code' || finishing.current) return;
    finishing.current = true;
    const binding = loadBinding();
    clearBinding();
    (binding === null
      ? Promise.reject(new Error('no browser secret'))
      : api.identityRedeem(token, returning.code, binding)
    ).then(
      () => {
        setNote('Linked.');
        setVersion((v) => v + 1);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) signOut();
        else if (err instanceof ApiError && err.status === 409) setNote(err.message);
        else setNote(LINK_FAILED);
      },
    );
  }, [returning, token, signOut]);

  const link = async (provider: SsoProvider) => {
    setNote(null);
    const problem = await leaveForProvider(
      (binding) => api.identityStart(token, provider, binding),
      { purpose: 'link' },
    );
    if (problem !== '') setNote(problem);
  };

  return (
    <section>
      <h3>Microsoft and Google sign-ins</h3>
      <IdentityList
        key={version}
        onChanged={() => setVersion((v) => v + 1)}
        onLink={(p) => void link(p)}
      />
      {note && <p role="status">{note}</p>}
    </section>
  );
}

function IdentityList({
  onChanged,
  onLink,
}: {
  onChanged: () => void;
  onLink: (provider: SsoProvider) => void;
}) {
  const load = useCallback(
    (t: string, signal: AbortSignal) => api.identities(t, signal),
    [],
  );
  const loaded = useLoad(load);
  const action = useAction();

  const unlink = async (identity: LinkedIdentity) => {
    if (await action.run((t) => api.unlinkIdentity(t, identity.id))) onChanged();
  };

  if (loaded.state === 'loading') return <p className="muted">Loading{'\u2026'}</p>;
  if (loaded.state === 'error') return <p className="error">{loaded.message}</p>;
  const { identities, providers, hasPassword } = loaded.data;
  const removable = canUnlink(identities.length, hasPassword);
  return (
    <>
      {identities.length === 0 ? (
        <p className="muted">No Microsoft or Google account is linked.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Linked</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {identities.map((identity) => (
              <tr key={identity.id}>
                <td>{PROVIDER_LABEL[identity.provider]}</td>
                <td>{formatDeadline(identity.linkedAt)}</td>
                <td>
                  {identity.lastLoginAt ? formatDeadline(identity.lastLoginAt) : 'never'}
                </td>
                <td>
                  <button
                    type="button"
                    className="secondary"
                    disabled={action.busy || !removable}
                    title={
                      removable ? undefined : 'This is the only way into the account'
                    }
                    onClick={() => void unlink(identity)}
                  >
                    Unlink
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {providers.length > 0 && (
        <div className="sso">
          {providers.map((provider) => (
            <button
              key={provider}
              type="button"
              className="secondary"
              onClick={() => onLink(provider)}
            >
              Link a {PROVIDER_LABEL[provider]} account
            </button>
          ))}
        </div>
      )}
      {action.error && (
        <p className="error" role="alert">
          {action.error}
        </p>
      )}
    </>
  );
}

/** The chat assistants this account let in by signing in, each with a way to end it. */
function Connections() {
  const [version, setVersion] = useState(0);
  return (
    <section>
      <h3>Chat assistants</h3>
      <ConnectionList key={version} onChanged={() => setVersion((v) => v + 1)} />
    </section>
  );
}

function ConnectionList({ onChanged }: { onChanged: () => void }) {
  const load = useCallback(
    (t: string, signal: AbortSignal) => api.connections(t, signal),
    [],
  );
  const loaded = useLoad(load);
  const action = useAction();

  const end = async (connection: ConnectionView) => {
    if (await action.run((t) => api.endConnection(t, connection.id))) onChanged();
  };

  if (loaded.state === 'loading') return <p className="muted">Loading{'\u2026'}</p>;
  if (loaded.state === 'error') return <p className="error">{loaded.message}</p>;
  const { connections } = loaded.data;
  if (connections.length === 0) {
    return (
      <p className="muted">
        No chat assistant is connected. One connects from its own settings, by this
        application&apos;s address; you are asked here before it gets in.
      </p>
    );
  }
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Calls itself</th>
            <th>Connected</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {connections.map((connection) => (
            <tr key={connection.id}>
              <td>{connection.name}</td>
              <td>{formatDeadline(connection.createdAt)}</td>
              <td>{formatDeadline(connection.lastUsedAt)}</td>
              <td>
                <button
                  type="button"
                  className="secondary"
                  disabled={action.busy}
                  onClick={() => void end(connection)}
                >
                  Disconnect
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {action.error && (
        <p className="error" role="alert">
          {action.error}
        </p>
      )}
    </>
  );
}

function Policy() {
  const load = useCallback(
    (t: string, signal: AbortSignal) => api.ssoPolicy(t, signal),
    [],
  );
  const loaded = useLoad(load);
  return (
    <section>
      <h3>Single sign-on for staff</h3>
      {loaded.state === 'loading' && <p className="muted">Loading{'…'}</p>}
      {loaded.state === 'error' && <p className="error">{loaded.message}</p>}
      {loaded.state === 'done' && <PolicyForm initial={draftOf(loaded.data)} />}
    </section>
  );
}

function PolicyForm({ initial }: { initial: PolicyDraft }) {
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const problem = policyProblem(draft);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem !== null) return;
    setSaved(false);
    const stored = await action.run((t) => api.setSsoPolicy(t, policyOf(draft)));
    if (stored) {
      setDraft(draftOf(stored));
      setSaved(true);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="policy">
      <p className="muted">
        Applies to staff only, never to vendors. Requiring single sign-on refuses a staff
        member&apos;s password once they have linked an account that these settings let
        in; you must have linked one yourself first.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.requireSso}
          onChange={(e) => setDraft({ ...draft, requireSso: e.target.checked })}
        />
        Require staff to sign in with Microsoft or Google
      </label>
      <label>
        Accept Microsoft accounts only from this directory (optional)
        <input
          value={draft.microsoftTid}
          placeholder="Directory (tenant) id"
          onChange={(e) => setDraft({ ...draft, microsoftTid: e.target.value })}
        />
      </label>
      <label>
        Accept Google accounts only from this Workspace domain (optional)
        <input
          value={draft.googleHd}
          placeholder="example.org"
          onChange={(e) => setDraft({ ...draft, googleHd: e.target.value })}
        />
      </label>
      {problem && <p className="muted">{problem}</p>}
      {action.error && (
        <p className="error" role="alert">
          {action.error}
        </p>
      )}
      {saved && <p role="status">Saved.</p>}
      <button type="submit" disabled={action.busy || problem !== null}>
        Save
      </button>
    </form>
  );
}
