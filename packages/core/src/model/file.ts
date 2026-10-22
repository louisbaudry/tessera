/**
 * What a project file is (planning/v1-spec.md §3.8; issue #169).
 *
 * The closed set lives here once; `file.kind`'s CHECK in the project schema is
 * a frozen literal of it (`db/check-lists.test.ts` ties the two), and export
 * dispatches on it. A new file type is a migration that widens the CHECK.
 */
export const FILE_KINDS = ['docx', 'xliff'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** The file kind an uploaded name suggests, or null when it suggests none. */
export function fileKindOfName(name: string): FileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.xlf') || lower.endsWith('.xliff')) return 'xliff';
  return null;
}
