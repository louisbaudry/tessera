/**
 * The SPA's screens are a hash, not a router (v1-spec.md §7.1):
 * `#/` lists projects, `#/p/<name>` one project's files and memories,
 * `#/p/<name>/f/<id>` a file's grid, and `#/tms` the account's memories
 * (§7.5). Anything else is the project list — a stale or hand-typed
 * link lands somewhere, never on a blank page. A vendor's job (backlog
 * #52) is `#/jobs/<owner account>/<assignment>`: the owner is part of the
 * address because a job lives on that owner's roster. The money screens (backlog
 * #113) are `#/payables`, the owner's pay run, and `#/payments`, a vendor's own
 * record; each account sees only its own, whatever a hand-typed link says.
 * `#/vendors` is the owner's roster and invitations, and `#/invite/<token>` the
 * page a vendor's invitation link opens (backlog #111): the one screen reached
 * without a session.
 */

export type Route =
  | { readonly screen: 'projects' }
  | { readonly screen: 'tms' }
  | { readonly screen: 'payables' }
  | { readonly screen: 'payments' }
  | { readonly screen: 'vendors' }
  | { readonly screen: 'invite'; readonly token: string }
  | { readonly screen: 'job'; readonly owner: number; readonly id: number }
  | { readonly screen: 'project'; readonly project: string }
  | { readonly screen: 'grid'; readonly project: string; readonly fileId: number };

const HOME: Route = { screen: 'projects' };

/** What `generateSessionToken` makes: base64url, 43 characters; the bounds are loose. */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts.length === 1 && parts[0] === 'tms') return { screen: 'tms' };
  if (parts.length === 1 && parts[0] === 'payables') return { screen: 'payables' };
  if (parts.length === 1 && parts[0] === 'payments') return { screen: 'payments' };
  if (parts.length === 1 && parts[0] === 'vendors') return { screen: 'vendors' };
  if (parts.length === 2 && parts[0] === 'invite') {
    // The token lives in the fragment, which a browser never sends to a server.
    return INVITE_TOKEN.test(parts[1]!) ? { screen: 'invite', token: parts[1]! } : HOME;
  }
  if (parts.length === 3 && parts[0] === 'jobs') {
    const [, owner, id] = parts;
    if (/^[1-9]\d{0,14}$/.test(owner!) && /^[1-9]\d{0,14}$/.test(id!)) {
      return { screen: 'job', owner: Number(owner), id: Number(id) };
    }
    return HOME;
  }
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
    case 'tms':
      return '#/tms';
    case 'payables':
      return '#/payables';
    case 'payments':
      return '#/payments';
    case 'vendors':
      return '#/vendors';
    case 'invite':
      return `#/invite/${route.token}`;
    case 'job':
      return `#/jobs/${route.owner}/${route.id}`;
    case 'project':
      return `#/p/${encodeURIComponent(route.project)}`;
    case 'grid':
      return `#/p/${encodeURIComponent(route.project)}/f/${route.fileId}`;
  }
}
