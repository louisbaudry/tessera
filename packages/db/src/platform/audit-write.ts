/**
 * The one writer of `platform.sqlite`'s `audit_event` (backlog #211,
 * `planning/audit-spec.md` §3.1): `appendAuditEvent` with the tenant made a required
 * argument, the way the actor is. The log holds every tenant's events, and a tenant's
 * admin reads their slice by this column, so a write that forgot it would be an event
 * nobody can see and an operator export that quietly lacks it. It must be named: a
 * tenant's id, or `null` for an event that is about no tenant (a refused login, an
 * operator's account with none, a vendor's own session).
 *
 * An ESLint rule keeps the platform files from importing `appendAuditEvent` directly.
 */

import type { AuditAction } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent, type NewAuditEvent } from '../audit/events.js';

export type NewPlatformEvent<A extends AuditAction> = Omit<
  NewAuditEvent<A>,
  'tenantId'
> & {
  /** The tenant the event is about, or `null` when it is about none. Never defaulted. */
  readonly tenantId: number | null;
};

export function appendPlatformEvent<A extends AuditAction>(
  db: Database.Database,
  event: NewPlatformEvent<A>,
) {
  return appendAuditEvent(db, event);
}
