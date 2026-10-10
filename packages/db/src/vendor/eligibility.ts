/**
 * The roster read against a job (backlog #128, vendor-spec.md's #156 note):
 * which vendors fit it and which do not, with the reasons. The rule is
 * `vendor-core`'s `exclusionReasons`; this only loads each vendor's profile
 * and capacity for it. A read, not a write, so there is no event and no
 * actor, and it filters nothing: every vendor is in the answer.
 */

import {
  exclusionReasons,
  type EligibilityJob,
  type ExclusionReason,
} from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { getCapacity } from './capacity.js';
import { getProfile, listVendors } from './vendors.js';

export interface VendorFit {
  readonly vendorId: number;
  readonly accountId: number;
  readonly displayName: string | null;
  /** Empty when the vendor fits. */
  readonly reasons: readonly ExclusionReason[];
}

/** Every vendor on the roster, in roster order, each with the reasons they do not fit `job`. */
export function assessRoster(db: Database.Database, job: EligibilityJob): VendorFit[] {
  return listVendors(db).map((v) => {
    const profile = getProfile(db, v.id)!;
    return {
      vendorId: v.id,
      accountId: v.accountId,
      displayName: v.displayName,
      reasons: exclusionReasons(
        {
          languages: profile.languages,
          specialties: profile.specialties,
          capacity: getCapacity(db, v.id)?.status ?? null,
        },
        job,
      ),
    };
  });
}
