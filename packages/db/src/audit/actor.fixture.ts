import type { AuditActor } from '@cat-tool/core';

/** The actor every test write that isn't *about* the actor passes. */
export const TEST_ACTOR: AuditActor = {
  actor: { kind: 'cli', name: 'test' },
  label: 'test',
};
