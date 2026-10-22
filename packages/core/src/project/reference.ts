/**
 * Reference files attached to a project (issue #203, `planning/v1-spec.md` §7.9).
 *
 * The pure rules: what a file may be (read from its bytes, never from the
 * upload's claim), how big, how many, and what a name or label is allowed to
 * look like. Storage is `db/project/reference-files.ts`; the HTTP is the
 * server's. Headless like the rest of `core`.
 */

/** The most one reference file may hold: a style guide, not a manuscript. */
export const REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
/** The most a project may hold. */
export const REFERENCE_MAX_FILES = 20;
/** The longest a stored name is; a longer one is cut, keeping its end (the extension). */
export const REFERENCE_NAME_MAX = 120;
/** The longest an owner-chosen label is: it is what a translator reads. */
export const REFERENCE_LABEL_MAX = 80;

/**
 * The closed set of media types a reference file is stored and served as. No
 * HTML or SVG: the file is served from the application's own origin, and a
 * type that can run script there is a stored XSS.
 */
export const REFERENCE_MEDIA_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export type ReferenceMediaType = (typeof REFERENCE_MEDIA_TYPES)[number];

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b);

/**
 * The media type `bytes` really are, from their signature, or null when they
 * are not a PDF, PNG, JPEG, GIF or WebP. The upload's own name and declared
 * type are never consulted: they are what an attacker chooses.
 */
export function sniffReferenceType(bytes: Uint8Array): ReferenceMediaType | null {
  // `%PDF-`: a PDF may be preceded by a little junk, but not by a megabyte of it.
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 5 <= head.length; i++) {
    if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d], i)) return 'application/pdf';
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'image/gif';
  }
  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * A name fit to keep and show the owner: the last path segment (an uploaded
 * name is never a path), control characters removed, trimmed, and at most
 * {@link REFERENCE_NAME_MAX} characters, cutting from the front so the
 * extension survives. Empty becomes `reference`.
 */
export function referenceDisplayName(uploaded: string): string {
  const segment = uploaded.split(/[\\/]/).pop() ?? '';
  const clean = segment.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (clean === '') return 'reference';
  return clean.length > REFERENCE_NAME_MAX
    ? clean.slice(clean.length - REFERENCE_NAME_MAX)
    : clean;
}

/**
 * The label an owner chose for the people working on the project: control
 * characters removed, trimmed; null for none. A label past
 * {@link REFERENCE_LABEL_MAX} is refused, not cut, so what is saved is what
 * the owner typed.
 *
 * @throws RangeError when the label is too long.
 */
export function referenceLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (clean === '') return null;
  if (clean.length > REFERENCE_LABEL_MAX) {
    throw new RangeError(`a label is at most ${REFERENCE_LABEL_MAX} characters`);
  }
  return clean;
}
