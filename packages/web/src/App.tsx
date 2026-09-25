/**
 * The SPA's shell (v1-spec.md §7.1): the login screen until there is a
 * token, then whichever screen the hash names.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from './api.js';
import { Grid } from './Grid.js';
import { Login } from './Login.js';
import { ProjectFiles, Projects } from './Projects.js';
import { formatRoute, parseRoute, type Route } from './route.js';
import { SessionContext, type SessionValue } from './session-context.js';
import { clearToken, loadToken, saveToken } from './session.js';

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

  const logOut = () => {
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
          <Breadcrumbs route={route} />
          <button type="button" className="link" onClick={logOut}>
            Sign out
          </button>
        </header>
        <main className="screen">
          {route.screen === 'projects' && <Projects />}
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

function Breadcrumbs({ route }: { route: Route }) {
  if (route.screen === 'projects') return <nav className="crumbs" />;
  return (
    <nav className="crumbs">
      <a href={formatRoute({ screen: 'projects' })}>Projects</a>
      <span aria-hidden="true">/</span>
      {route.screen === 'grid' ? (
        <a href={formatRoute({ screen: 'project', project: route.project })}>
          {route.project}
        </a>
      ) : (
        <span>{route.project}</span>
      )}
    </nav>
  );
}
