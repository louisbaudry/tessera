/**
 * The SPA's three screens are a hash, not a router (v1-spec.md §7.1):
 * `#/` lists projects, `#/p/<name>` one project's files, and
 * `#/p/<name>/f/<id>` a file's grid. Anything else is the project list —
 * a stale or hand-typed link lands somewhere, never on a blank page.
 */

export type Route =
  | { readonly screen: 'projects' }
  | { readonly screen: 'project'; readonly project: string }
  | { readonly screen: 'grid'; readonly project: string; readonly fileId: number };

const HOME: Route = { screen: 'projects' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] !== 'p' || parts[1] === undefined) return HOME;
  let project: string;
  try {
    project = decodeURIComponent(parts[1]);
  } catch {
    return HOME;
  }
  if (parts.length === 2) return { screen: 'project', project };
  if (parts.length === 4 && parts[2] === 'f' && /^[1-9]\d*$/.test(parts[3]!)) {
    return { screen: 'grid', project, fileId: Number(parts[3]) };
  }
  return HOME;
}

export function formatRoute(route: Route): string {
  switch (route.screen) {
    case 'projects':
      return '#/';
    case 'project':
      return `#/p/${encodeURIComponent(route.project)}`;
    case 'grid':
      return `#/p/${encodeURIComponent(route.project)}/f/${route.fileId}`;
  }
}
