/**
 * Who on the roster fits a job, and why the others do not (backlog #128,
 * `planning/vendor-spec.md`'s #156 note). Pure: a vendor's declared profile
 * and capacity in, a verdict with reasons out.
 *
 * The verdict is **advisory** (decided 2026-10-10): it never stops an
 * owner offering a job to anyone. A stale toggle or a missing tag can
 * wrongly exclude the right vendor, so what leaves is always the full list,
 * with every exclusion named, for the owner to overrule by simply offering.
 */

import { primarySubtag } from '@cat-tool/core/model';

import { normalizeSpecialty, type CapacityStatus } from './profile.js';

/** Why a vendor does not fit a job. A vendor can have several. */
export const EXCLUSION_REASONS = ['language_pair', 'specialty', 'busy', 'away'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** What the job asks of a vendor. `specialty` is optional: no tag, no specialty test. */
export interface EligibilityJob {
  readonly src: string;
  readonly tgt: string;
  readonly specialty?: string | null;
}

/** What a vendor has declared: their pairs (primary subtags), tags and capacity. */
export interface EligibilityProfile {
  readonly languages: readonly { readonly src: string; readonly tgt: string }[];
  readonly specialties: readonly string[];
  /** `null` when they have never set one: unknown is not busy. */
  readonly capacity: CapacityStatus | null;
}

/**
 * The reasons a vendor does not fit, empty when they do, in
 * {@link EXCLUSION_REASONS} order. Language is matched by primary subtag
 * (`en-GB` is `en`), the direction mattering; a vendor with no declared
 * pair fits no job. A specialty is asked only when the job names one.
 * `available` and a never-set capacity both pass; `busy` and `away` are
 * reasons of their own, since "at full capacity" and "away" are different
 * things to tell an owner.
 */
export function exclusionReasons(
  profile: EligibilityProfile,
  job: EligibilityJob,
): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  const src = primarySubtag(job.src);
  const tgt = primarySubtag(job.tgt);
  if (!profile.languages.some((p) => p.src === src && p.tgt === tgt)) {
    reasons.push('language_pair');
  }
  const wanted = normalizeSpecialty(job.specialty ?? '');
  if (
    wanted !== '' &&
    !profile.specialties.some((t) => normalizeSpecialty(t) === wanted)
  ) {
    reasons.push('specialty');
  }
  if (profile.capacity === 'busy') reasons.push('busy');
  if (profile.capacity === 'away') reasons.push('away');
  return reasons;
}
