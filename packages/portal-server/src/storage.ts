/**
 * File storage (portal-v0-spec.md §6).
 *
 * Original and delivered files are stored under separate subdirectories
 * of a configurable root; only metadata lives in SQLite (`db/portal/files.ts`).
 *
 * The on-disk name is minted here, never taken from the upload — the
 * same rule `packages/server/src/storage.ts` states for the CAT server
 * ("no function takes a path from a request"). The client's filename is
 * kept in SQLite for display and for the download's `Content-Disposition`,
 * and nothing else is ever built from it.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A fresh, server-minted on-disk name for one stored file. */
export function mintStoredName(): string {
  return randomUUID();
}

export function sourceFilePath(orderId: number, storedName: string): string {
  return join('orders', String(orderId), 'source', storedName);
}

export function deliveredFilePath(orderId: number, storedName: string): string {
  return join('orders', String(orderId), 'delivered', storedName);
}

/**
 * The name an upload is recorded and later served under: its last path
 * segment, whichever separator the uploading OS used, or `file` when
 * nothing usable is left. Display only — never a path component.
 */
export function displayFilename(uploaded: string): string {
  const leaf = uploaded.split(/[\\/]/u).pop() ?? '';
  const trimmed = leaf.trim();
  return trimmed === '' || trimmed === '.' || trimmed === '..' ? 'file' : trimmed;
}

/** Writes `bytes` to `storageRoot/relativePath`, creating directories as needed. */
export function writeStoredFile(
  storageRoot: string,
  relativePath: string,
  bytes: Buffer,
): void {
  const fullPath = join(storageRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, bytes);
}

export function readStoredFilePath(storageRoot: string, relativePath: string): string {
  return join(storageRoot, relativePath);
}

/** One definition, in `@cat-tool/core`, shared with the CAT server's downloads. */
export { attachmentDisposition } from '@cat-tool/portal-core';
