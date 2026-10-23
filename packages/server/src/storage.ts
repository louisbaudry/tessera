/**
 * Where a tenant's files live (v1-spec.md §4.1a, §2.5; `planning/tenant-spec.md` D4).
 *
 * Every path the server ever touches is built here, from two things it
 * generated itself — the tenant's `storage_root` (`u/<hex>`, minted for its
 * founding admin by `createAccount`, D4) and a project name this module validates — so a
 * request can never name a path. That is what "storage root resolved
 * per authenticated session before any file path is touched" means in
 * code: there is no function that takes a path from the outside.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isSlug } from '@cat-tool/core';
import type { Tenant } from '@cat-tool/db';

/** A project or memory slug outside the alphabet. */
export class InvalidNameError extends Error {
  constructor(what: 'project' | 'memory' | 'glossary', name: string) {
    super(
      `invalid ${what} name "${name}": use 1–64 lowercase letters, digits and hyphens, ` +
        'starting and ending with a letter or digit',
    );
    this.name = 'InvalidNameError';
  }
}

// A project or a memory is addressed by a slug, which is also its
// file's basename. `isSlug`'s alphabet (`core/model/slug.ts`) is the
// whole defence against path traversal: nothing matching it can contain
// a separator, a dot, or be empty.

const PROJECT_EXT = '.catdb';
const TM_EXT = '.ctm';
const GLOSSARY_EXT = '.ctg';
const VENDORS_FILE = 'vendors.ctv';

/** The directory a tenant's projects live in, under the server's volume. */
export function projectsDir(storageRoot: string, tenant: Tenant): string {
  return join(storageRoot, tenant.storageRoot, 'projects');
}

/** The `.catdb` path for a project name, after validating the name. */
export function projectPath(storageRoot: string, tenant: Tenant, name: string): string {
  if (!isSlug(name)) throw new InvalidNameError('project', name);
  return join(projectsDir(storageRoot, tenant), `${name}${PROJECT_EXT}`);
}

/**
 * The tenant's vendor roster (backlog #46, #205): one `.ctv` per tenant,
 * beside its other files. Built from the tenant's minted root and a
 * constant, so nothing a request sends is in it.
 */
export function vendorsPath(storageRoot: string, tenant: Tenant): string {
  return join(storageRoot, tenant.storageRoot, VENDORS_FILE);
}

/** Every slug with `ext` in `dir`, sorted; none before the directory exists. */
function listSlugs(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => f.slice(0, -ext.length))
    .filter((slug) => isSlug(slug))
    .sort();
}

/** Every project name under a tenant's root, sorted; none before the first is created. */
export function listProjectNames(storageRoot: string, tenant: Tenant): string[] {
  return listSlugs(projectsDir(storageRoot, tenant), PROJECT_EXT);
}

/**
 * The directory a tenant's memories live in (v1-spec.md §7.5): the
 * tenant's, not a project's, because one memory serves every project
 * it is attached to (§4.2).
 */
export function tmsDir(storageRoot: string, tenant: Tenant): string {
  return join(storageRoot, tenant.storageRoot, 'tms');
}

/** The `.ctm` path for a memory slug, after validating it. */
export function tmPath(storageRoot: string, tenant: Tenant, slug: string): string {
  if (!isSlug(slug)) throw new InvalidNameError('memory', slug);
  return join(tmsDir(storageRoot, tenant), `${slug}${TM_EXT}`);
}

/** Every memory slug under a tenant's root, sorted. */
export function listTmSlugs(storageRoot: string, tenant: Tenant): string[] {
  return listSlugs(tmsDir(storageRoot, tenant), TM_EXT);
}

/**
 * The memory slug a stored `tm_ref.path` names, or null when it is not
 * one of this tenant's memories (a path the CLI attached). The API
 * speaks slugs, never paths: a path would show the storage root.
 */
export function tmSlugOf(
  storageRoot: string,
  tenant: Tenant,
  path: string,
): string | null {
  if (dirname(path) !== tmsDir(storageRoot, tenant) || !path.endsWith(TM_EXT))
    return null;
  const slug = path.slice(dirname(path).length + 1, -TM_EXT.length);
  return isSlug(slug) ? slug : null;
}

/**
 * The directory a tenant's glossaries live in: the tenant's, like its
 * memories, because one glossary serves every project it is attached to
 * (smart-glossary-spec.md §2.1, §5a.1).
 */
export function glossariesDir(storageRoot: string, tenant: Tenant): string {
  return join(storageRoot, tenant.storageRoot, 'glossaries');
}

/** The `.ctg` path for a glossary slug, after validating it. */
export function glossaryPath(storageRoot: string, tenant: Tenant, slug: string): string {
  if (!isSlug(slug)) throw new InvalidNameError('glossary', slug);
  return join(glossariesDir(storageRoot, tenant), `${slug}${GLOSSARY_EXT}`);
}

/** Every glossary slug under a tenant's root, sorted. */
export function listGlossarySlugs(storageRoot: string, tenant: Tenant): string[] {
  return listSlugs(glossariesDir(storageRoot, tenant), GLOSSARY_EXT);
}

/**
 * The glossary slug a stored `glossary_ref.path` names, or null when it
 * is not one of this tenant's glossaries (a path the CLI attached). The
 * API speaks slugs, never paths: a path would show the storage root.
 */
export function glossarySlugOf(
  storageRoot: string,
  tenant: Tenant,
  path: string,
): string | null {
  if (
    dirname(path) !== glossariesDir(storageRoot, tenant) ||
    !path.endsWith(GLOSSARY_EXT)
  )
    return null;
  const slug = path.slice(dirname(path).length + 1, -GLOSSARY_EXT.length);
  return isSlug(slug) ? slug : null;
}

/**
 * A fresh path for an upload on its way into a memory, under the
 * tenant's own root: the name is minted here, never the client's, so
 * an uploaded filename never becomes a path (the portal's rule).
 */
export function uploadTempPath(storageRoot: string, tenant: Tenant): string {
  return join(storageRoot, tenant.storageRoot, 'tmp', randomBytes(12).toString('hex'));
}

/**
 * Removes every tenant's `tmp/`: the uploads and staging memories of
 * imports a crash or `kill -9` never let settle. Only safe at boot, when
 * the job table (in memory) is empty, so nothing running can own a file
 * there. Nothing partial was ever visible as a memory (it is renamed into
 * place only when whole), so this reclaims disk and nothing else.
 */
export function sweepUploadTemp(storageRoot: string): void {
  // A tenant's root is `<root>/u/<id>`, minted for its founding admin (`newStorageRoot`, db/platform/accounts.ts).
  const accounts = join(storageRoot, 'u');
  if (!existsSync(accounts)) return;
  for (const entry of readdirSync(accounts, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      rmSync(join(accounts, entry.name, 'tmp'), { recursive: true, force: true });
    }
  }
}
