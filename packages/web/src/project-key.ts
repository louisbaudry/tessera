/**
 * How the SPA names a project. Its own is its slug; one that belongs to
 * another account (a vendor's job, backlog #52) carries that account's id:
 * `job@7`. `@` is outside the slug alphabet (`isSlug`), so a key can never
 * be mistaken for a name, and every component that passes a project around
 * as a string keeps doing so: only `api.ts` unpacks it into the path and
 * the `?owner=` the server wants (backlog #45).
 */

export interface ProjectRef {
  readonly name: string;
  /** The owner's account id, or null for the signed-in account's own project. */
  readonly owner: number | null;
}

const KEY = /^([^@]+)@([1-9]\d{0,14})$/;

export function projectKey(name: string, owner: number | null): string {
  return owner === null ? name : `${name}@${owner}`;
}

export function parseProjectKey(key: string): ProjectRef {
  const m = KEY.exec(key);
  return m ? { name: m[1]!, owner: Number(m[2]) } : { name: key, owner: null };
}
