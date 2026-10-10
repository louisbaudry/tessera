/**
 * A client's own translation memory and glossary (backlog #162,
 * portal-v0-spec.md §9): `client_resource` links, and the export a client
 * downloads from them.
 *
 * A link names a whole file, set by the operator from the command line
 * (`link-client-resource`), never by a request and never by a filter over a
 * shared memory. That is what keeps the base memory out of a client's
 * export: there is no query that could miss a unit, only a file that either
 * is the client's or is not linked to them. The file belongs to the CAT
 * server's owner and may be open there, so it is read through
 * `openReadOnly` and never migrated, backed up or written.
 */

import { createHash } from 'node:crypto';

import { glossaryCsv, type AuditActor } from '@cat-tool/core';
import {
  CLIENT_RESOURCE_KINDS,
  MAX_CLIENT_EXPORT_UNITS,
  type ClientResourceKind,
} from '@cat-tool/portal-core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { exportGlossaryRows } from '../glossary/export.js';
import { GLOSSARY_APPLICATION_ID, GLOSSARY_MIGRATIONS } from '../glossary/schema.js';
import { openReadOnly, ReadOnlyOpenError } from '../read-only.js';
import { describeTm } from '../tm/describe.js';
import { exportTmx } from '../tm/export-tmx.js';
import { TM_APPLICATION_ID, TM_MIGRATIONS } from '../tm/schema.js';

export interface ClientResource {
  readonly id: number;
  readonly clientId: number;
  readonly kind: ClientResourceKind;
  /** Where the operator linked it. Never sent to a client. */
  readonly path: string;
  /** The file's own name, read when linked; what the client is shown. */
  readonly name: string;
  readonly linkedAt: string;
}

interface ResourceRow {
  id: number;
  client_id: number;
  kind: ClientResourceKind;
  path: string;
  name: string;
  linked_at: string;
}

const fromRow = (row: ResourceRow): ClientResource => ({
  id: row.id,
  clientId: row.client_id,
  kind: row.kind,
  path: row.path,
  name: row.name,
  linkedAt: row.linked_at,
});

/** Why a link or an export was refused; `reason` is for the route to map to a status. */
export class ClientResourceError extends Error {
  constructor(
    message: string,
    readonly reason: 'unreadable' | 'too_large' | 'already_linked' | 'not_linked',
  ) {
    super(message);
    this.name = 'ClientResourceError';
  }
}

const OPEN = {
  tm: { applicationId: TM_APPLICATION_ID, migrations: TM_MIGRATIONS, what: 'memory' },
  glossary: {
    applicationId: GLOSSARY_APPLICATION_ID,
    migrations: GLOSSARY_MIGRATIONS,
    what: 'glossary',
  },
} as const satisfies Record<ClientResourceKind, unknown>;

/** The file's display name, read through a read-only connection; refuses a file that is not that kind. */
function readName(path: string, kind: ClientResourceKind): string {
  let file: Database.Database;
  try {
    file = openReadOnly(path, OPEN[kind]);
  } catch (err) {
    if (err instanceof ReadOnlyOpenError) {
      throw new ClientResourceError(err.message, 'unreadable');
    }
    throw err;
  }
  try {
    const table = kind === 'tm' ? 'tm' : 'glossary';
    return (
      file.prepare(`SELECT name FROM ${table} WHERE id = 1`).get() as { name: string }
    ).name;
  } finally {
    file.close();
  }
}

export interface LinkClientResourceOptions {
  readonly actor: AuditActor;
  readonly clientId: number;
  readonly kind: ClientResourceKind;
  /** An absolute path the operator typed; checked to be a readable file of `kind`. */
  readonly path: string;
}

/**
 * Links a file to a client. One per kind: a second link is refused until
 * the first is removed, so a client's export never changes by accident.
 * Logged as `resource.linked` in the same transaction.
 */
export function linkClientResource(
  db: Database.Database,
  options: LinkClientResourceOptions,
): ClientResource {
  const name = readName(options.path, options.kind);
  return db.transaction((): ClientResource => {
    if (getClientResource(db, options.clientId, options.kind)) {
      throw new ClientResourceError(
        `client #${options.clientId} already has a ${options.kind} linked; unlink it first`,
        'already_linked',
      );
    }
    const linkedAt = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO client_resource (client_id, kind, path, name, linked_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(options.clientId, options.kind, options.path, name, linkedAt);
    const id = info.lastInsertRowid as number;
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'resource.linked',
      subjectType: 'client_resource',
      subjectId: String(id),
      detail: { client_id: options.clientId, kind: options.kind },
    });
    return {
      id,
      clientId: options.clientId,
      kind: options.kind,
      path: options.path,
      name,
      linkedAt,
    };
  })();
}

/** Removes a client's link of `kind` (the file is untouched). Logged as `resource.unlinked`. */
export function unlinkClientResource(
  db: Database.Database,
  options: { actor: AuditActor; clientId: number; kind: ClientResourceKind },
): void {
  db.transaction(() => {
    const existing = getClientResource(db, options.clientId, options.kind);
    if (!existing) {
      throw new ClientResourceError(
        `client #${options.clientId} has no ${options.kind} linked`,
        'not_linked',
      );
    }
    db.prepare('DELETE FROM client_resource WHERE id = ?').run(existing.id);
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'resource.unlinked',
      subjectType: 'client_resource',
      subjectId: String(existing.id),
      detail: { client_id: options.clientId, kind: options.kind },
    });
  })();
}

/** The client's link of `kind`, or null. Scoped by client: the only way to read a link. */
export function getClientResource(
  db: Database.Database,
  clientId: number,
  kind: ClientResourceKind,
): ClientResource | null {
  const row = db
    .prepare('SELECT * FROM client_resource WHERE client_id = ? AND kind = ?')
    .get(clientId, kind) as ResourceRow | undefined;
  return row ? fromRow(row) : null;
}

/** Every link a client has, in kind order. */
export function listClientResources(
  db: Database.Database,
  clientId: number,
): ClientResource[] {
  const rows = db
    .prepare('SELECT * FROM client_resource WHERE client_id = ?')
    .all(clientId) as ResourceRow[];
  return rows
    .map(fromRow)
    .sort(
      (a, b) =>
        CLIENT_RESOURCE_KINDS.indexOf(a.kind) - CLIENT_RESOURCE_KINDS.indexOf(b.kind),
    );
}

export interface ClientExport {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Buffer;
  /** Units in a memory, renderings in a glossary. */
  readonly count: number;
  readonly sha256: string;
}

/** The name a client's download is saved under: the file's own name and its format's extension. */
export function clientExportFilename(
  resource: Pick<ClientResource, 'kind' | 'name'>,
): string {
  return `${resource.name}.${resource.kind === 'tm' ? 'tmx' : 'csv'}`;
}

/** Excel opens a CSV as the local code page unless it starts with a byte-order mark. */
const BOM = '﻿';

/**
 * The file a client downloads: the linked memory as TMX (without who made it
 * or how, `forClient`), or the linked glossary as CSV (`glossaryCsv`). Read
 * through a `query_only` connection to the current file, so it is always the
 * latest, and refused above {@link MAX_CLIENT_EXPORT_UNITS} units (`maxUnits`, for a test). The
 * connection is closed before the bytes are returned.
 */
export function exportClientResource(
  resource: ClientResource,
  options: { readonly maxUnits?: number } = {},
): ClientExport {
  const maxUnits = options.maxUnits ?? MAX_CLIENT_EXPORT_UNITS;
  let file: Database.Database;
  try {
    file = openReadOnly(resource.path, OPEN[resource.kind]);
  } catch (err) {
    if (err instanceof ReadOnlyOpenError) {
      throw new ClientResourceError(err.message, 'unreadable');
    }
    throw err;
  }
  try {
    let text: string;
    let count: number;
    let contentType: string;
    if (resource.kind === 'tm') {
      const { units } = describeTm(file);
      if (units > maxUnits) {
        throw new ClientResourceError(
          `the memory holds ${units} units; more than ${maxUnits} cannot be exported here`,
          'too_large',
        );
      }
      const result = exportTmx(file, { forClient: true });
      text = result.xml;
      count = result.tuCount;
      contentType = 'application/xml; charset=utf-8';
    } else {
      const rows = exportGlossaryRows(file);
      text = BOM + glossaryCsv(rows);
      count = rows.length;
      contentType = 'text/csv; charset=utf-8';
    }
    const bytes = Buffer.from(text, 'utf8');
    return {
      filename: clientExportFilename(resource),
      contentType,
      bytes,
      count,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    file.close();
  }
}

/**
 * Records a client taking their file (`resource.exported`): who, which link,
 * how many, and the SHA-256 of exactly the bytes sent. Written before the
 * first byte goes out, like `recordFileDownload`, so a failed write means
 * nothing left. The text itself is never in the log.
 */
export function recordClientExport(
  db: Database.Database,
  options: { actor: AuditActor; resource: ClientResource; exported: ClientExport },
): void {
  appendAuditEvent(db, {
    actor: options.actor,
    action: 'resource.exported',
    subjectType: 'client_resource',
    subjectId: String(options.resource.id),
    detail: {
      client_id: options.resource.clientId,
      kind: options.resource.kind,
      count: options.exported.count,
      sha256: options.exported.sha256,
    },
  });
}
