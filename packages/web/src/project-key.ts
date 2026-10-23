/**
 * How the SPA names a project. Its own is its slug; one that belongs to
 * another tenant (a vendor's job, backlog #52) carries that tenant's id:
 * `job@7`. `@` is outside the slug alphabet (`isSlug`), so a key can never
 * be mistaken for a name, and every component that passes a project around
 * as a string keeps doing so: only `api.ts` unpacks it into the path and
 * the `?tenant=` the server wants (backlog #45, #205).
 */

export interface ProjectRef {
  readonly name: string;
  /** The owning tenant's id, or null for the signed-in account's own tenant's project. */
  readonly tenantId: number | null;
}

const KEY = /^([^@]+)@([1-9]\d{0,14})$/;

export function projectKey(name: string, tenantId: number | null): string {
  return tenantId === null ? name : `${name}@${tenantId}`;
}

export function parseProjectKey(key: string): ProjectRef {
  const m = KEY.exec(key);
  return m ? { name: m[1]!, tenantId: Number(m[2]) } : { name: key, tenantId: null };
}
