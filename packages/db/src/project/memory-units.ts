/**
 * Correcting or retiring a unit in one of the project's memories (`v1-spec.md`
 * §6.1c; issue #151). `tm/edit.ts` writes the `.ctm`; this names the memory the
 * way the project does (`tm_ref.id`, never a path), attaches just that one, and
 * logs the change in the project, because a `.ctm` has no audit log of its own.
 *
 * Two files cannot share a transaction, so the memory is written first and the
 * event after: a failure between loses the log line and never invents one. For an
 * edit, `tuv_history` still names who changed what; for a retirement, the unit's
 * `x-retired-by` does. A change that did nothing (the text was already so, the unit
 * already retired) logs nothing.
 */

import type { AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import {
  editUnitTarget,
  retireUnit,
  type EditUnitResult,
  type RetireUnitResult,
} from '../tm/edit.js';
import { attachTms, detachTms, listTmRefs, tmAlias } from './tm-refs.js';

/** The project holds no enabled memory with that reference. */
export class NoSuchMemoryError extends Error {
  constructor(ref: number) {
    super(`this project has no memory with reference ${ref}`);
    this.name = 'NoSuchMemoryError';
  }
}

export interface EditMemoryUnitParams {
  /** The project's `tm_ref.id`, as a concordance hit carries it. */
  readonly ref: number;
  readonly tuvId: number;
  readonly baseRev: number;
  readonly text: string;
  /** Who made the change: required, as every audited write (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

export interface RetireMemoryUnitParams {
  readonly ref: number;
  readonly tuvId: number;
  readonly baseRev: number;
  readonly actor: AuditActor;
}

/**
 * Runs `write` against the enabled memory the project holds as `ref`, attached
 * for the call alone. Throws {@link NoSuchMemoryError} for any other reference,
 * a switched-off memory included: concordance does not show one, so a write to
 * it would be a write the owner never saw.
 */
function withMemory<T>(
  db: Database.Database,
  ref: number,
  write: (schema: string) => T,
): T {
  const found = listTmRefs(db).find((r) => r.id === ref && r.enabled);
  if (!found) throw new NoSuchMemoryError(ref);
  attachTms(db, [found]);
  try {
    return write(tmAlias(found.id));
  } finally {
    detachTms(db, [found]);
  }
}

/**
 * Replaces one memory variant's text (`editUnitTarget`) and logs
 * `tm.unit_edited`, with the reference, unit, language and revisions and never the
 * text. Throws {@link NoSuchMemoryError} and `UnitEditError`.
 */
export function editMemoryUnit(
  db: Database.Database,
  params: EditMemoryUnitParams,
): EditUnitResult {
  const result = withMemory(db, params.ref, (schema) =>
    editUnitTarget(
      db,
      {
        tuvId: params.tuvId,
        baseRev: params.baseRev,
        text: params.text,
        changedBy: params.actor.label,
      },
      { schema },
    ),
  );
  if (result.changed) {
    appendAuditEvent(db, {
      actor: params.actor,
      action: 'tm.unit_edited',
      subjectType: 'project',
      subjectId: null,
      detail: {
        tm_ref: params.ref,
        tu_uuid: result.tuUuid,
        lang: result.lang,
        from_rev: result.fromRev,
        to_rev: result.toRev,
      },
    });
  }
  return result;
}

/**
 * Tombstones one memory unit (`retireUnit`) and logs `tm.unit_retired`. Throws
 * {@link NoSuchMemoryError} and `UnitEditError`.
 */
export function retireMemoryUnit(
  db: Database.Database,
  params: RetireMemoryUnitParams,
): RetireUnitResult {
  const result = withMemory(db, params.ref, (schema) =>
    retireUnit(
      db,
      { tuvId: params.tuvId, baseRev: params.baseRev, changedBy: params.actor.label },
      { schema },
    ),
  );
  if (result.changed) {
    appendAuditEvent(db, {
      actor: params.actor,
      action: 'tm.unit_retired',
      subjectType: 'project',
      subjectId: null,
      detail: { tm_ref: params.ref, tu_uuid: result.tuUuid },
    });
  }
  return result;
}
