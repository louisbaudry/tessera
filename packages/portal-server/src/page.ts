/**
 * The portal's two HTML pages with the tenant's name and currency filled in (issues #310 and
 * #327, `planning/portal-v0-spec.md` §9a, §9c). The shipped pages carry a `{{portalName}}` placeholder
 * and name no one, because this repository is public and a tenant's name is data
 * (`tenant-spec.md` D12); the portal app serves the filled copy for `/client.html` and
 * `/admin.html`.
 */

/** Shown when neither the tenant nor `PORTAL_DISPLAY_NAME` names the portal. */
export const DEFAULT_PORTAL_NAME = 'Translation Portal';

/** What a page is filled with: the name it shows and the ISO 4217 code its prices are in. */
export interface PortalPageFill {
  readonly name: string;
  readonly currency: string;
}

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
 * `template` with every `{{portalName}}` replaced by the name and every `{{portalCurrency}}` by the
 * currency code, both escaped. They are an operator's settings rather than a request's, but they
 * reach a page that holds sessions, so they are escaped anyway. Split and join, not `replace`, so a
 * `$` in a name is never read as a substitution pattern.
 *
 * @param template - A shipped page with its placeholders.
 * @param fill - The tenant's name and currency.
 * @returns The page to serve.
 */
export function renderPortalPage(template: string, fill: PortalPageFill): string {
  return template
    .split('{{portalName}}')
    .join(escapeHtml(fill.name))
    .split('{{portalCurrency}}')
    .join(escapeHtml(fill.currency));
}
