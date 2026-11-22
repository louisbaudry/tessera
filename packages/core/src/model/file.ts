/**
 * What a project file is (planning/v1-spec.md §3.8; issue #169).
 *
 * The closed set lives here once, and export dispatches on it
 * (`exportFileBytes`). The `file.kind` column has no CHECK on purpose (§3.8:
 * `file` is referenced, so the migration runner cannot rebuild it), so a new
 * kind is an entry here and a filter, not a migration; a kind nothing knows
 * fails at export.
 */
export const FILE_KINDS = ['docx', 'xliff', 'pptx', 'xlsx'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** The file kind an uploaded name suggests, or null when it suggests none. */
export function fileKindOfName(name: string): FileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.xlf') || lower.endsWith('.xliff')) return 'xliff';
  if (lower.endsWith('.pptx')) return 'pptx';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  return null;
}
