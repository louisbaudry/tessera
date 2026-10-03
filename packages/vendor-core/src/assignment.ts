/**
 * The assignment lifecycle (`planning/vendor-spec.md` §4 and its #47
 * implementation note).
 *
 * The state machine lives here, once, so no route or repository encodes
 * "which moves are legal, and whose" itself — the same discipline as
 * `portal-core`'s `order.ts`. Pure TypeScript: no database, no HTTP, no
 * Electron, no DOM, the headless rule `core` and `portal-core` keep.
 */

/** In the order a job normally travels; also the closed set a `CHECK` will freeze (`#48`). */
export const ASSIGNMENT_STATUSES = [
  'offered',
  'pool_open',
  'claimed',
  'accepted',
  'declined',
  'in_progress',
  'delivered',
  'reviewed',
] as const;

export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** How a job reaches a vendor: pushed to one named vendor, or posted to the pool (decision 6). */
export const ASSIGNMENT_CHANNELS = ['direct', 'pool'] as const;
export type AssignmentChannel = (typeof ASSIGNMENT_CHANNELS)[number];

/**
 * The kind of party making a move. Which vendor, or whose PM, is the
 * repository's check; this is only whether the move is a vendor's or a PM's.
 */
export type AssignmentParty = 'pm' | 'vendor';

/**
 * Every legal edge and who makes it. Terminal states have none. A
 * `Record` over the status union, so a status added to the list fails
 * typecheck until it says where it can go.
 */
const TRANSITIONS: Readonly<
  Record<AssignmentStatus, Readonly<Partial<Record<AssignmentStatus, AssignmentParty>>>>
> = {
  offered: { accepted: 'vendor', declined: 'vendor' },
  pool_open: { claimed: 'vendor' },
  claimed: { accepted: 'vendor', declined: 'vendor' },
  accepted: { in_progress: 'vendor' },
  declined: {},
  in_progress: { delivered: 'vendor' },
  delivered: { reviewed: 'pm' },
  reviewed: {},
};

/** An edge that does not exist: a route answers it 409. */
export class InvalidAssignmentTransitionError extends Error {
  constructor(
    readonly from: AssignmentStatus,
    readonly to: AssignmentStatus,
  ) {
    super(`cannot transition assignment from "${from}" to "${to}"`);
    this.name = 'InvalidAssignmentTransitionError';
  }
}

/** An edge that exists, made by the wrong kind of party: a route answers it 403. */
export class AssignmentPartyError extends Error {
  constructor(
    readonly from: AssignmentStatus,
    readonly to: AssignmentStatus,
    readonly by: AssignmentParty,
    readonly expected: AssignmentParty,
  ) {
    super(
      `a ${by} cannot move an assignment from "${from}" to "${to}": ` +
        `that is the ${expected}'s move`,
    );
    this.name = 'AssignmentPartyError';
  }
}

/** The only way an assignment comes to exist: its first status, by channel. */
export function initialStatus(channel: AssignmentChannel): AssignmentStatus {
  return channel === 'direct' ? 'offered' : 'pool_open';
}

/**
 * Checks `from -> to` by `by` and returns `to`. The one place a
 * transition is enforced: throws `InvalidAssignmentTransitionError` for an
 * edge that does not exist, `AssignmentPartyError` for one that does but is
 * the other party's. A precondition on an edge (the review gate, `#51`)
 * sits beside this call, never inside it.
 */
export function transitionAssignment(
  from: AssignmentStatus,
  to: AssignmentStatus,
  by: AssignmentParty,
): AssignmentStatus {
  const expected = TRANSITIONS[from][to];
  if (expected === undefined) throw new InvalidAssignmentTransitionError(from, to);
  if (expected !== by) throw new AssignmentPartyError(from, to, by, expected);
  return to;
}

/** Whether `by` may move `from -> to`; `by` omitted asks whether anyone may. */
export function canTransition(
  from: AssignmentStatus,
  to: AssignmentStatus,
  by?: AssignmentParty,
): boolean {
  const expected = TRANSITIONS[from][to];
  return expected !== undefined && (by === undefined || expected === by);
}

/** Where an assignment can go next, optionally only by one party, in lifecycle order. */
export function nextStatuses(
  from: AssignmentStatus,
  by?: AssignmentParty,
): AssignmentStatus[] {
  return ASSIGNMENT_STATUSES.filter((to) => canTransition(from, to, by));
}

/** `declined` and `reviewed`: nothing follows. */
export function isTerminal(status: AssignmentStatus): boolean {
  return nextStatuses(status).length === 0;
}
