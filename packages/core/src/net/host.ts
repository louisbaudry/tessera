/**
 * Host names, for the two servers that route by them (`planning/tenant-spec.md` D13, D14):
 * one definition, so the CAT server and the portal gateway cannot disagree about which
 * host a request is for. Pure: a header string in, a name or `null` out.
 */

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * The host a request is for: its `Host` header lower-cased, without a port or a trailing dot.
 * `null` for anything that is not a plain host name (empty, a list, a bracketed address), so a
 * strange header is no tenant's.
 */
export function normaliseHost(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const withoutPort = raw.includes(':') ? raw.slice(0, raw.lastIndexOf(':')) : raw;
  const host = withoutPort.toLowerCase().replace(/\.$/, '');
  return HOST.test(host) && !raw.startsWith('[') ? host : null;
}

/**
 * The tenant label of a host under a base domain: `acme` for `acme.tessera.example` under
 * `tessera.example`. `null` for the base domain itself, a host outside it, and a host with more
 * than one label before the base (`a.b.tessera.example`), so a tenant is reached at exactly one
 * address shape and never by a nested name.
 */
export function tenantLabelOfHost(
  hostHeader: string | undefined,
  baseDomain: string,
): string | null {
  const host = normaliseHost(hostHeader);
  const base = normaliseHost(baseDomain);
  if (host === null || base === null || !host.endsWith(`.${base}`)) return null;
  const label = host.slice(0, -(base.length + 1));
  return label.length > 0 && !label.includes('.') ? label : null;
}
