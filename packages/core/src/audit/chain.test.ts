import { createHash } from 'node:crypto';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PLATFORM_AUDIT_ACTIONS,
  PORTAL_AUDIT_ACTIONS,
  PROJECT_AUDIT_ACTIONS,
  type AuditAction,
  type AuditDetail,
} from './actions.js';
import {
  canonicalAuditRow,
  chainHash,
  genesisHash,
  verifyAuditChain,
  type AuditEventRow,
  type ChainedFields,
} from './chain.js';

const APP_ID = 0x43415450;

/** Appends `fields` to `log` the way a writer does: hash from the previous row. */
function append(
  log: AuditEventRow[],
  fields: ChainedFields,
  actorLabel: string | null = null,
) {
  const prev = log.length > 0 ? log[log.length - 1]!.chainHash : genesisHash(APP_ID);
  log.push({ ...fields, actorLabel, chainHash: chainHash(prev, fields) });
}

function buildLog(): AuditEventRow[] {
  const log: AuditEventRow[] = [];
  append(log, {
    id: 1,
    at: '2026-09-24T09:00:00.000Z',
    actor: 'system:migration',
    action: 'segment.baseline',
    subjectType: 'segment',
    subjectId: '7',
    batchId: null,
    detail: '{"status":"draft","origin":null,"target_tokens":[]}',
  });
  append(
    log,
    {
      id: 2,
      at: '2026-09-24T09:05:00.000Z',
      actor: 'account:3',
      action: 'project.pretranslate',
      subjectType: 'project',
      subjectId: null,
      batchId: null,
      detail: '{"tm_refs":["client.ctm"],"counts":{"exact":1}}',
    },
    'louis@example.com',
  );
  append(
    log,
    {
      id: 3,
      at: '2026-09-24T09:05:00.001Z',
      actor: 'account:3',
      action: 'segment.target_set',
      subjectType: 'segment',
      subjectId: '8',
      batchId: 2,
      detail: '{"status":"draft","origin":"tm_exact","target_tokens":[]}',
    },
    'louis@example.com',
  );
  append(log, {
    id: 5,
    at: '2026-09-24T09:10:00.000Z',
    actor: 'cli:louis',
    action: 'segment.confirmed',
    subjectType: 'segment',
    subjectId: '8',
    batchId: null,
    detail: '{"tm_write":null}',
  });
  return log;
}

describe('the audit hash chain', () => {
  it('fixes the bytes spec §3.1 records', () => {
    expect(genesisHash(APP_ID)).toBe(
      createHash('sha256').update(`CATA:${APP_ID}`, 'utf8').digest('hex'),
    );
    const row = buildLog()[1]!;
    expect(canonicalAuditRow(row)).toBe(
      '[2,"2026-09-24T09:05:00.000Z","account:3","project.pretranslate","project",null,null,' +
        '"{\\"tm_refs\\":[\\"client.ctm\\"],\\"counts\\":{\\"exact\\":1}}"]',
    );
    expect(row.chainHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies an intact chain, and an empty one', () => {
    expect(verifyAuditChain(buildLog(), APP_ID)).toBeNull();
    expect(verifyAuditChain([], APP_ID)).toBeNull();
  });

  it('does not verify against another database kind', () => {
    expect(verifyAuditChain(buildLog(), APP_ID + 1)).toBe(1);
  });

  it('reports an edited row as itself', () => {
    const log = buildLog();
    log[2] = {
      ...log[2]!,
      detail: '{"status":"draft","origin":"tm_exact","target_tokens":[1]}',
    };
    expect(verifyAuditChain(log, APP_ID)).toBe(3);

    const actorSwap = buildLog();
    actorSwap[1] = { ...actorSwap[1]!, actor: 'account:4' };
    expect(verifyAuditChain(actorSwap, APP_ID)).toBe(2);
  });

  it('reports a deleted row as the row after it', () => {
    const log = buildLog();
    log.splice(1, 1);
    expect(verifyAuditChain(log, APP_ID)).toBe(3);
  });

  it('reports an inserted row — as itself, or as its successor if it was hashed correctly', () => {
    const forged: ChainedFields = {
      id: 4,
      at: '2026-09-24T09:06:00.000Z',
      actor: 'account:9',
      action: 'segment.target_set',
      subjectType: 'segment',
      subjectId: '8',
      batchId: null,
      detail: '{"status":"draft","origin":null,"target_tokens":[]}',
    };
    const naive = buildLog();
    naive.splice(3, 0, { ...forged, actorLabel: null, chainHash: naive[3]!.chainHash });
    expect(verifyAuditChain(naive, APP_ID)).toBe(4);

    const careful = buildLog();
    careful.splice(3, 0, {
      ...forged,
      actorLabel: null,
      chainHash: chainHash(careful[2]!.chainHash, forged),
    });
    expect(verifyAuditChain(careful, APP_ID)).toBe(5);
  });

  it('treats ids that do not ascend as a break', () => {
    const log = buildLog();
    const [a, b] = [log[1]!, log[2]!];
    log[1] = b;
    log[2] = a;
    expect(verifyAuditChain(log, APP_ID)).toBe(3);
  });

  it('survives erasing an actor label — the one permitted change (spec §5)', () => {
    const log = buildLog().map((row) =>
      row.actorLabel === null ? row : { ...row, actorLabel: '[erased]' },
    );
    expect(log.some((row) => row.actorLabel === '[erased]')).toBe(true);
    expect(verifyAuditChain(log, APP_ID)).toBeNull();
  });

  it('cannot see rows removed from the end — the gap the deferred anchor closes', () => {
    expect(verifyAuditChain(buildLog().slice(0, 2), APP_ID)).toBeNull();
  });
});

describe('the action vocabulary', () => {
  it('gives every action exactly one detail type', () => {
    expectTypeOf<keyof AuditDetail>().toEqualTypeOf<AuditAction>();
  });

  it('lists each action once per database, in the dotted form a CHECK can hold', () => {
    for (const list of [
      PROJECT_AUDIT_ACTIONS,
      PLATFORM_AUDIT_ACTIONS,
      PORTAL_AUDIT_ACTIONS,
    ]) {
      expect(new Set(list).size).toBe(list.length);
      for (const action of list)
        expect(action).toMatch(/^[a-z]+(_[a-z]+)*\.[a-z]+(_[a-z]+)*$/);
    }
  });
});
