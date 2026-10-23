/**
 * A client's consent to draft engines, and its default engine (backlog #133,
 * `planning/translation-engine-spec.md` D4, D9, D19).
 *
 * The consent that must exist before any client content can be sent to an
 * engine. A client is the number an owner types on a project
 * (`portal_client_setting`), never checked against `portal.sqlite`; here it is
 * scoped by the tenant (backlog #205), so two tenants' client #7 are two clients.
 *
 * **Absence-based.** No consent row is "not consented"; no default row is
 * `off`. A new client, and every client that exists today, sends nothing.
 * Consent is per engine (D19): agreeing to one says nothing about another.
 *
 * Every change is one `client_engine.changed` in `platform.sqlite`'s log, in
 * the transaction that writes it, with a required actor (`audit-spec.md`
 * §2.5). Withdrawing consent takes the default engine with it in the same
 * transaction and logs both. What a withdrawal does to stored suggestions
 * (purge the unaccepted ones, D15) belongs to the suggestion store, which does
 * not exist yet; the logged withdrawal is the event it will act on.
 */

import {
  isDraftEngine,
  isEngineChoice,
  type AuditActor,
  type ClientEngineSettings,
  type DraftEngine,
  type EngineChoice,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendPlatformEvent } from './audit-write.js';

export class ClientEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientEngineError';
  }
}

/** What a client has set, `off` and no consent when nothing is stored. */
export function getClientEngine(
  db: Database.Database,
  tenantId: number,
  clientId: number,
): ClientEngineSettings {
  const consented = (
    db
      .prepare(
        `SELECT engine FROM client_engine_consent
         WHERE tenant_id = ? AND client_id = ? ORDER BY engine`,
      )
      .all(tenantId, clientId) as Array<{ engine: DraftEngine }>
  ).map((r) => r.engine);
  const row = db
    .prepare(
      'SELECT engine FROM client_engine_default WHERE tenant_id = ? AND client_id = ?',
    )
    .get(tenantId, clientId) as { engine: DraftEngine } | undefined;
  return { default: row?.engine ?? 'off', consented };
}

function checkTarget(db: Database.Database, tenantId: number, clientId: number): void {
  if (!Number.isSafeInteger(clientId) || clientId < 1) {
    throw new ClientEngineError('a client is a positive whole number');
  }
  if (!db.prepare('SELECT 1 FROM tenant WHERE id = ?').get(tenantId)) {
    throw new ClientEngineError(`no tenant #${tenantId}`);
  }
}

function logChange(
  db: Database.Database,
  actor: AuditActor,
  tenantId: number,
  clientId: number,
  key: string,
  from: boolean | string,
  to: boolean | string,
): void {
  appendPlatformEvent(db, {
    actor,
    action: 'client_engine.changed',
    tenantId,
    subjectType: 'client',
    subjectId: String(clientId),
    detail: { client_id: clientId, key, from, to },
  });
}

export interface ConsentOptions {
  readonly tenantId: number;
  readonly clientId: number;
  /** An engine that sends client content out; `off` has nothing to consent to. */
  readonly engine: DraftEngine;
  readonly consent: boolean;
  /** Who changed it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

/**
 * Records, or withdraws, a client's consent to one engine. Changing nothing
 * writes and logs nothing. Withdrawing consent to the engine that is the
 * client's default also clears the default, and both changes are logged.
 * Throws {@link ClientEngineError} for a client that is not a positive whole
 * number, an owner that does not exist, or an engine that is not a draft engine.
 */
export function setClientEngineConsent(
  db: Database.Database,
  options: ConsentOptions,
): void {
  const { tenantId, clientId, engine, actor } = options;
  if (!isDraftEngine(engine)) {
    throw new ClientEngineError(
      `"${String(engine)}" is not an engine a client consents to`,
    );
  }
  checkTarget(db, tenantId, clientId);
  db.transaction(() => {
    const has = db
      .prepare(
        'SELECT 1 FROM client_engine_consent WHERE tenant_id = ? AND client_id = ? AND engine = ?',
      )
      .get(tenantId, clientId, engine);
    if (options.consent && !has) {
      db.prepare(
        `INSERT INTO client_engine_consent (tenant_id, client_id, engine, consented_at)
         VALUES (?, ?, ?, ?)`,
      ).run(tenantId, clientId, engine, new Date().toISOString());
      logChange(db, actor, tenantId, clientId, `consent:${engine}`, false, true);
    } else if (!options.consent && has) {
      db.prepare(
        'DELETE FROM client_engine_consent WHERE tenant_id = ? AND client_id = ? AND engine = ?',
      ).run(tenantId, clientId, engine);
      logChange(db, actor, tenantId, clientId, `consent:${engine}`, true, false);
      const wasDefault = db
        .prepare(
          'DELETE FROM client_engine_default WHERE tenant_id = ? AND client_id = ? AND engine = ?',
        )
        .run(tenantId, clientId, engine);
      if (wasDefault.changes > 0) {
        logChange(db, actor, tenantId, clientId, 'default', engine, 'off');
      }
    }
  })();
}

export interface DefaultOptions {
  readonly tenantId: number;
  readonly clientId: number;
  readonly engine: EngineChoice;
  readonly actor: AuditActor;
}

/**
 * Sets the engine a client's projects inherit, or `off`. An engine the client
 * has not consented to is refused, so a default can never name one. Changing
 * nothing writes and logs nothing.
 */
export function setClientEngineDefault(
  db: Database.Database,
  options: DefaultOptions,
): void {
  const { tenantId, clientId, engine, actor } = options;
  if (!isEngineChoice(engine)) {
    throw new ClientEngineError(`"${String(engine)}" is not an engine`);
  }
  checkTarget(db, tenantId, clientId);
  db.transaction(() => {
    const from = getClientEngine(db, tenantId, clientId);
    if (engine !== 'off' && !from.consented.includes(engine)) {
      throw new ClientEngineError(
        `the client has not consented to "${engine}", so it cannot be the default`,
      );
    }
    if (from.default === engine) return;
    if (engine === 'off') {
      db.prepare(
        'DELETE FROM client_engine_default WHERE tenant_id = ? AND client_id = ?',
      ).run(tenantId, clientId);
    } else {
      db.prepare(
        `INSERT INTO client_engine_default (tenant_id, client_id, engine) VALUES (?, ?, ?)
         ON CONFLICT (tenant_id, client_id) DO UPDATE SET engine = excluded.engine`,
      ).run(tenantId, clientId, engine);
    }
    logChange(db, actor, tenantId, clientId, 'default', from.default, engine);
  })();
}
