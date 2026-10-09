/**
 * The SPA's shell (v1-spec.md §7.1): the login screen until there is a
 * token, then whichever screen the hash names.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AccountRole } from '@cat-tool/core';

import { api, ApiError } from './api.js';
import { Accept } from './Accept.js';
import { Grid } from './Grid.js';
import { JobScreen } from './Job.js';
import { Login } from './Login.js';
import { Memories } from './Memories.js';
import { Payables } from './Payables.js';
import { Payments } from './Payments.js';
import { ProjectFiles, Projects } from './Projects.js';
import { parseProjectKey } from './project-key.js';
import { loadTheme, saveTheme } from './prefs.js';
import { formatRoute, parseRoute, type Route } from './route.js';
import { SessionContext, type SessionValue } from './session-context.js';
import { clearToken, loadToken, saveToken } from './session.js';
import { applyTheme, followSystem, nextThemeChoice, type ThemeChoice } from './theme.js';
import { VendorFeed } from './VendorFeed.js';
import { Vendors } from './Vendors.js';

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  const [token, setToken] = useState(loadToken);
  const route = useRoute();

  const signOut = useCallback(() => {
    clearToken();
    setToken(null);
  }, []);
  const session = useMemo<SessionValue | null>(
    () => (token === null ? null : { token, signOut }),
    [token, signOut],
  );

  // What the account is decides its home and its navigation (backlog #52a): an owner
  // has projects and memories, a vendor has jobs. Unknown until `/api/me` answers.
  const [role, setRole] = useState<AccountRole | null>(null);
  useEffect(() => {
    if (token === null) return;
    let live = true;
    api.me(token).then(
      (account) => live && setRole(account.role),
      (err: unknown) => {
        if (live && err instanceof ApiError && err.status === 401) signOut();
      },
    );
    return () => {
      live = false;
    };
  }, [token, signOut]);

  // An invitation link is the one screen reached without a session (backlog #111).
  // Accepting it signs the new vendor in; whoever was signed in before is replaced,
  // and the role is read again from the new session.
  if (route.screen === 'invite') {
    return (
      <Accept
        token={route.token}
        onToken={(t) => {
          saveToken(t);
          setRole(null);
          setToken(t);
          window.location.hash = formatRoute({ screen: 'projects' });
        }}
      />
    );
  }

  if (session === null) {
    return (
      <Login
        onToken={(t) => {
          saveToken(t);
          setToken(t);
        }}
      />
    );
  }

  const logOut = async () => {
    // An editor still open saves as it loses focus (§7.2), and that save
    // must reach the server before the session it uses is revoked.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await api.settled();
    // Revoke server-side, but never keep someone signed in because the
    // server could not be reached to hear it.
    void api.logout(session.token).catch(() => undefined);
    signOut();
  };

  return (
    <SessionContext.Provider value={session}>
      <div className="app">
        <header className="topbar">
          <a className="brand" href={formatRoute({ screen: 'projects' })}>
            Tessera
          </a>
          <Breadcrumbs route={route} role={role} />
          {role === 'owner' && <a href={formatRoute({ screen: 'tms' })}>Memories</a>}
          {role === 'owner' && <a href={formatRoute({ screen: 'vendors' })}>Vendors</a>}
          {role === 'owner' && <a href={formatRoute({ screen: 'payables' })}>Pay run</a>}
          {role === 'vendor' && (
            <a href={formatRoute({ screen: 'payments' })}>Payments</a>
          )}
          <ThemeToggle />
          <button type="button" className="link" onClick={() => void logOut()}>
            Sign out
          </button>
        </header>
        <main className="screen">
          {role === null && <p className="muted">Loading{'\u2026'}</p>}
          {role !== null &&
            route.screen === 'projects' &&
            (role === 'vendor' ? <VendorFeed /> : <Projects />)}
          {route.screen === 'job' && <JobScreen owner={route.owner} id={route.id} />}
          {route.screen === 'tms' && role === 'owner' && <Memories />}
          {route.screen === 'vendors' && role === 'owner' && <Vendors />}
          {route.screen === 'payables' && role === 'owner' && <Payables />}
          {route.screen === 'payments' && role === 'vendor' && <Payments />}
          {route.screen === 'project' && <ProjectFiles name={route.project} />}
          {route.screen === 'grid' && (
            <Grid
              key={`${route.project}/${route.fileId}`}
              project={route.project}
              fileId={route.fileId}
            />
          )}
        </main>
      </div>
    </SessionContext.Provider>
  );
}

function Breadcrumbs({ route, role }: { route: Route; role: AccountRole | null }) {
  const home = role === 'vendor' ? 'Jobs' : 'Projects';
  if (route.screen === 'projects') return <nav className="crumbs" />;
  if (route.screen === 'job') {
    return (
      <nav className="crumbs">
        <a href={formatRoute({ screen: 'projects' })}>{home}</a>
        <span aria-hidden="true">/</span>
        <span>Job</span>
      </nav>
    );
  }
  if (
    route.screen === 'tms' ||
    route.screen === 'payables' ||
    route.screen === 'payments' ||
    route.screen === 'vendors'
  ) {
    const here = {
      tms: 'Memories',
      payables: 'Pay run',
      payments: 'Payments',
      vendors: 'Vendors',
    }[route.screen];
    return (
      <nav className="crumbs">
        <a href={formatRoute({ screen: 'projects' })}>{home}</a>
        <span aria-hidden="true">/</span>
        <span>{here}</span>
      </nav>
    );
  }
  // The invitation page is shown without the shell, so it has no crumbs.
  if (route.screen === 'invite') return <nav className="crumbs" />;
  // Another account's project (a vendor's job) is a key; the crumb shows its name.
  const shown = parseProjectKey(route.project).name;
  return (
    <nav className="crumbs">
      <a href={formatRoute({ screen: 'projects' })}>{home}</a>
      <span aria-hidden="true">/</span>
      {route.screen === 'grid' ? (
        <a href={formatRoute({ screen: 'project', project: route.project })}>{shown}</a>
      ) : (
        <span>{shown}</span>
      )}
    </nav>
  );
}

const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

/** Cycles system → light → dark; the choice is a per-browser preference. */
function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(loadTheme);
  useEffect(() => followSystem(() => choice), [choice]);
  return (
    <button
      type="button"
      className="link"
      onClick={() => {
        const next = nextThemeChoice(choice);
        saveTheme(next);
        applyTheme(next);
        setChoice(next);
      }}
    >
      {THEME_LABEL[choice]}
    </button>
  );
}
