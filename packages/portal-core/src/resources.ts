/**
 * What a client can take away (backlog #162, portal-v0-spec.md §9): the
 * translation memory and the glossary the admin has linked to them, one of
 * each at most. Pure vocabulary; where a file lives and how it is read is
 * `db`'s (`db/portal/client-resources.ts`).
 */

/** The two things a client's link can name. A frozen literal in the portal schema's v6 migration. */
export const CLIENT_RESOURCE_KINDS = ['tm', 'glossary'] as const;
export type ClientResourceKind = (typeof CLIENT_RESOURCE_KINDS)[number];

/** True for a string that names a kind; narrows a route parameter. */
export function isClientResourceKind(value: string): value is ClientResourceKind {
  return (CLIENT_RESOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * The most units a memory may hold and still be exported in one request.
 * An export is built in memory and sent whole (a TMX of an agency memory can
 * pass V8's string cap, `tm-format-spec.md` §1.1); past this the route says
 * so instead of stalling the portal's only thread. A client memory is one
 * client's, well under it.
 */
export const MAX_CLIENT_EXPORT_UNITS = 100_000;
