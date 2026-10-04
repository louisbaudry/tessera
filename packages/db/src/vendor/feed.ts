/**
 * A vendor's job feed (vendor-spec.md §7 and its #50 note): what needs an
 * answer, what they may claim, what is under way and what was recently
 * delivered. A read over `assignment`, never a second place a status is
 * decided.
 */

import type { AssignmentStatus } from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { listAssignmentsFor, listClaimable, type Assignment } from './assignments.js';

export interface VendorFeed {
  /** `offered`, and `claimed` (a pool claim not yet accepted): waiting on the vendor. */
  readonly needsResponse: Assignment[];
  /** Pool jobs the vendor may claim right now. */
  readonly claimable: Assignment[];
  readonly active: Assignment[];
  /** `delivered` and `reviewed`, the latest {@link DELIVERED_LIMIT}. */
  readonly delivered: Assignment[];
}

export const DELIVERED_LIMIT = 20;

const NEEDS_RESPONSE: readonly AssignmentStatus[] = ['offered', 'claimed'];
const ACTIVE: readonly AssignmentStatus[] = ['accepted', 'in_progress'];
const DELIVERED: readonly AssignmentStatus[] = ['delivered', 'reviewed'];

/** Every group newest first. A `declined` job is the vendor's own answer and is in none. */
export function vendorFeed(db: Database.Database, vendorId: number): VendorFeed {
  const own = listAssignmentsFor(db, vendorId);
  const in_ = (statuses: readonly AssignmentStatus[]) =>
    own.filter((a) => statuses.includes(a.status));
  return {
    needsResponse: in_(NEEDS_RESPONSE),
    claimable: listClaimable(db, vendorId),
    active: in_(ACTIVE),
    delivered: in_(DELIVERED).slice(0, DELIVERED_LIMIT),
  };
}
