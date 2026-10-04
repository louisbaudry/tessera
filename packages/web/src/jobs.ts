/**
 * What the vendor's screens decide, kept out of the components (backlog
 * #52; vendor-spec.md §7): which answers a job offers, how a tier's words and
 * rate read side by side, how money and a deadline are written. Pure, so it is
 * proved in node. The lifecycle is `vendor-core`'s: which button a job shows is
 * asked of `transitionAssignment`, never re-encoded here.
 */
import {
  RATE_TIERS,
  transitionAssignment,
  type AssignmentStatus,
  type RateTier,
} from '@cat-tool/vendor-core';

export type VendorVerb = 'claim' | 'accept' | 'decline' | 'start' | 'deliver';

/** The status each vendor verb moves a job to (the routes' own table, `server/src/assignments.ts`). */
const TARGET: Record<VendorVerb, AssignmentStatus> = {
  claim: 'claimed',
  accept: 'accepted',
  decline: 'declined',
  start: 'in_progress',
  deliver: 'delivered',
};

/** In the order they are offered: the forward move first, declining last. */
const VERB_ORDER: readonly VendorVerb[] = [
  'claim',
  'accept',
  'start',
  'deliver',
  'decline',
];

export const VERB_LABEL: Record<VendorVerb, string> = {
  claim: 'Claim this job',
  accept: 'Accept',
  decline: 'Decline',
  start: 'Start work',
  deliver: 'Deliver',
};

/** The answers a vendor may give a job in this status: exactly the edges the machine has for them. */
export function availableVerbs(status: AssignmentStatus): VendorVerb[] {
  return VERB_ORDER.filter((verb) => {
    try {
      transitionAssignment(status, TARGET[verb], 'vendor');
      return true;
    } catch {
      return false;
    }
  });
}

/** Whether the vendor works in the editor on a job in this status. */
export const isWorkable = (status: AssignmentStatus): boolean =>
  status === 'accepted' || status === 'in_progress' || status === 'delivered';

export const STATUS_LABEL: Record<AssignmentStatus, string> = {
  offered: 'Offered to you',
  pool_open: 'Open to claim',
  claimed: 'Claimed, not yet accepted',
  accepted: 'Accepted',
  declined: 'Declined',
  in_progress: 'In progress',
  delivered: 'Delivered',
  reviewed: 'Reviewed',
};

export const TIER_LABEL: Record<RateTier, string> = {
  no_match: 'No match',
  fuzzy_50_74: 'Fuzzy 50–74%',
  fuzzy_75_84: 'Fuzzy 75–84%',
  fuzzy_85_94: 'Fuzzy 85–94%',
  fuzzy_95_99: 'Fuzzy 95–99%',
  exact: '100% and repetitions',
  ice: 'In-context (101%)',
};

/** The feed's groups, in the order §7 puts them: what needs an answer first. */
export const FEED_GROUPS = [
  { key: 'needsResponse', title: 'Needs your answer' },
  { key: 'claimable', title: 'Open to claim' },
  { key: 'active', title: 'Under way' },
  { key: 'delivered', title: 'Delivered' },
] as const;
export type FeedGroupKey = (typeof FEED_GROUPS)[number]['key'];

export interface RateEntry {
  readonly src: string;
  readonly tgt: string;
  readonly tier: RateTier;
  readonly rateMicros: number;
  readonly currency: string;
}

export interface TierRow {
  readonly tier: RateTier;
  readonly label: string;
  readonly words: number;
  /** Null when the vendor's card has no rate for this tier at the offer's date. */
  readonly rate: RateEntry | null;
}

/**
 * The job's words by tier beside the vendor's own rate for each: the offer
 * screen's table (vendor-spec decision 11). A row per tier that has words, in
 * tier order. **No amount and no total**: decision 10 leaves the sum to the
 * vendor on the offer, and it is a fact only once the job is delivered.
 */
export function tierRows(
  words: Readonly<Partial<Record<RateTier, number>>>,
  rateCard: readonly RateEntry[],
): TierRow[] {
  return RATE_TIERS.flatMap((tier) => {
    const n = words[tier] ?? 0;
    if (n <= 0) return [];
    return [
      {
        tier,
        label: TIER_LABEL[tier],
        words: n,
        rate: rateCard.find((r) => r.tier === tier) ?? null,
      },
    ];
  });
}

/** An amount in micros of a currency unit, as money: `80000` micros of EUR is "€0.08". */
export function formatMicros(micros: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(micros / 1_000_000);
}

/** A deadline as a date and time, or "No deadline". */
export function formatDeadline(
  iso: string | null,
  locale?: string,
  timeZone?: string,
): string {
  if (iso === null) return 'No deadline';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
}
