/**
 * Schema-alias qualification, shared by every repository that can query
 * either its own database or an `ATTACH`ed one under a stable alias
 * (`db/project/attached-refs.ts` — TM refs, glossary refs, and now the
 * exact matcher's cross-TM query, backlog #19, all attach this way).
 *
 * An alias is always one of this codebase's own generated names
 * (`tmAlias`/`glossaryAlias`, `tm_<id>`/`glossary_<id>`), never user
 * input — but it is interpolated directly into SQL (table names can't
 * be bound parameters), so it is checked here rather than trusted.
 */

export class SchemaAliasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaAliasError';
  }
}

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `"alias."` or `""` (the main database) — never a bare, unchecked string. */
export function qualifySchema(schema: string | undefined): string {
  if (schema === undefined) return '';
  if (!ALIAS.test(schema)) {
    throw new SchemaAliasError(`invalid schema alias "${schema}"`);
  }
  return `${schema}.`;
}
