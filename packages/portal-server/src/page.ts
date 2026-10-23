/**
 * The portal's two HTML pages with the tenant's name filled in (issue #310,
 * `planning/portal-v0-spec.md` §9a). The shipped pages carry a `{{portalName}}` placeholder
 * and name no one, because this repository is public and a tenant's name is data
 * (`tenant-spec.md` D12); the portal app serves the filled copy for `/client.html` and
 * `/admin.html`.
 */

/** Shown when neither the tenant nor `PORTAL_DISPLAY_NAME` names the portal. */
export const DEFAULT_PORTAL_NAME = 'Translation Portal';

const PLACEHOLDER = '{{portalName}}';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text safe in HTML element content and attribute values alike. */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/**
 * `template` with every `{{portalName}}` replaced by `name`, escaped. The name is an operator's
 * setting rather than a request's, but it reaches a page that holds sessions, so it is escaped anyway.
 * Split and join, not `replace`, so a `$` in a name is never read as a substitution pattern.
 */
export function renderPortalPage(template: string, name: string): string {
  const safe = escapeHtml(name);
  return template.split(PLACEHOLDER).join(safe);
}
