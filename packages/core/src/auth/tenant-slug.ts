/**
 * A tenant's slug (`planning/tenant-spec.md` D14, backlog #209): the public name its address,
 * links and certificates are built from. It is a DNS label, not a display name: lower case,
 * digits and hyphens, at most 40 characters, not starting or ending with a hyphen, and not a
 * name the platform keeps for itself. One definition for the database's check and the
 * operator's command; the SPA never needs it.
 */

export const TENANT_SLUG_MAX_LENGTH = 40;

const TENANT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Names a tenant may not take: addresses a platform or a mail system expects to own, and words that
 * would make a customer's address look like the operator's. Not an allow-list of customers: any other
 * label is free.
 */
export const RESERVED_TENANT_SLUGS = [
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'dashboard',
  'demo',
  'dev',
  'docs',
  'ftp',
  'help',
  'imap',
  'localhost',
  'login',
  'mail',
  'portal',
  'root',
  'smtp',
  'staging',
  'static',
  'status',
  'support',
  'tessera',
  'test',
  'webmail',
  'www',
] as const;

/** Why `slug` cannot be a tenant's, in a sentence for the operator; `null` when it can. */
export function tenantSlugProblem(slug: string): string | null {
  if (!TENANT_SLUG.test(slug) || slug.length > TENANT_SLUG_MAX_LENGTH) {
    return `a tenant slug is lower-case letters, digits and hyphens, at most ${TENANT_SLUG_MAX_LENGTH} characters, not starting or ending with a hyphen`;
  }
  if ((RESERVED_TENANT_SLUGS as readonly string[]).includes(slug)) {
    return `"${slug}" is kept for the platform`;
  }
  return null;
}

export const isTenantSlug = (slug: string): boolean => tenantSlugProblem(slug) === null;
