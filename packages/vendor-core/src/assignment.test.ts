import { describe, expect, it } from 'vitest';

import {
  ASSIGNMENT_CHANNELS,
  ASSIGNMENT_STATUSES,
  AssignmentPartyError,
  canTransition,
  initialStatus,
  InvalidAssignmentTransitionError,
  isTerminal,
  nextStatuses,
  transitionAssignment,
  type AssignmentParty,
  type AssignmentStatus,
} from './assignment.js';

/**
 * The edges of vendor-spec.md §4 and its #47 note, written out here
 * independently of the implementation's table: the sweep below proves the
 * two agree on every one of the 8 × 8 pairs, so a typo in either shows.
 */
const EDGES: ReadonlyArray<
  readonly [AssignmentStatus, AssignmentStatus, AssignmentParty]
> = [
  ['offered', 'accepted', 'vendor'],
  ['offered', 'declined', 'vendor'],
  ['pool_open', 'claimed', 'vendor'],
  ['claimed', 'accepted', 'vendor'],
  ['claimed', 'declined', 'vendor'],
  ['accepted', 'in_progress', 'vendor'],
  ['in_progress', 'delivered', 'vendor'],
  ['delivered', 'reviewed', 'pm'],
];

const partyOf = (from: AssignmentStatus, to: AssignmentStatus) =>
  EDGES.find(([f, t]) => f === from && t === to)?.[2];

/** Walks a path, each step by the party its edge names, and returns where it ends. */
function walk(start: AssignmentStatus, ...path: AssignmentStatus[]): AssignmentStatus {
  let at = start;
  for (const to of path) at = transitionAssignment(at, to, partyOf(at, to) ?? 'vendor');
  return at;
}

describe('the two happy paths', () => {
  it('a direct offer: offered → accepted → in_progress → delivered → reviewed', () => {
    expect(
      walk(initialStatus('direct'), 'accepted', 'in_progress', 'delivered', 'reviewed'),
    ).toBe('reviewed');
  });

  it('a pool job: pool_open → claimed → accepted → in_progress → delivered → reviewed', () => {
    expect(
      walk(
        initialStatus('pool'),
        'claimed',
        'accepted',
        'in_progress',
        'delivered',
        'reviewed',
      ),
    ).toBe('reviewed');
  });

  it('either kind can be declined, and a claim can be declined after it is made', () => {
    expect(walk('offered', 'declined')).toBe('declined');
    expect(walk('pool_open', 'claimed', 'declined')).toBe('declined');
  });
});

describe('initialStatus', () => {
  it('is offered for a direct channel and pool_open for the pool', () => {
    expect(initialStatus('direct')).toBe('offered');
    expect(initialStatus('pool')).toBe('pool_open');
    for (const channel of ASSIGNMENT_CHANNELS) {
      expect(ASSIGNMENT_STATUSES).toContain(initialStatus(channel));
    }
  });

  it('is never the target of a transition: nothing moves into offered or pool_open', () => {
    for (const from of ASSIGNMENT_STATUSES) {
      expect(nextStatuses(from)).not.toContain('offered');
      expect(nextStatuses(from)).not.toContain('pool_open');
    }
  });
});

describe('an illegal transition', () => {
  it('throws: offered cannot go straight to delivered', () => {
    expect(() => transitionAssignment('offered', 'delivered', 'vendor')).toThrow(
      InvalidAssignmentTransitionError,
    );
    expect(() => transitionAssignment('offered', 'delivered', 'vendor')).toThrow(
      'cannot transition assignment from "offered" to "delivered"',
    );
  });

  it('throws for a move back, a skipped step and a move out of a terminal state', () => {
    for (const [from, to] of [
      ['accepted', 'offered'],
      ['claimed', 'pool_open'],
      ['accepted', 'delivered'],
      ['pool_open', 'accepted'],
      ['declined', 'accepted'],
      ['reviewed', 'delivered'],
      ['delivered', 'in_progress'],
    ] as const) {
      expect(() => transitionAssignment(from, to, 'vendor'), `${from} → ${to}`).toThrow(
        InvalidAssignmentTransitionError,
      );
    }
  });

  it('is not a transition to oneself', () => {
    for (const status of ASSIGNMENT_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});

describe('the party', () => {
  it('a PM cannot accept, claim or deliver on a vendor’s behalf, and says whose move it is', () => {
    expect(() => transitionAssignment('offered', 'accepted', 'pm')).toThrow(
      AssignmentPartyError,
    );
    expect(() => transitionAssignment('in_progress', 'delivered', 'pm')).toThrow(
      "that is the vendor's move",
    );
  });

  it('a vendor cannot review their own work', () => {
    expect(() => transitionAssignment('delivered', 'reviewed', 'vendor')).toThrow(
      "that is the pm's move",
    );
  });

  it('an illegal edge is an illegal edge whoever asks, never a party error', () => {
    expect(() => transitionAssignment('offered', 'delivered', 'pm')).toThrow(
      InvalidAssignmentTransitionError,
    );
  });
});

describe('the whole table', () => {
  it('agrees with the spec on every one of the 8 × 8 pairs, for each party', () => {
    for (const from of ASSIGNMENT_STATUSES) {
      for (const to of ASSIGNMENT_STATUSES) {
        const owner = partyOf(from, to);
        for (const by of ['pm', 'vendor'] as const) {
          const label = `${from} → ${to} by ${by}`;
          expect(canTransition(from, to, by), label).toBe(owner === by);
          if (owner === undefined) {
            expect(() => transitionAssignment(from, to, by), label).toThrow(
              InvalidAssignmentTransitionError,
            );
          } else if (owner !== by) {
            expect(() => transitionAssignment(from, to, by), label).toThrow(
              AssignmentPartyError,
            );
          } else {
            expect(transitionAssignment(from, to, by), label).toBe(to);
          }
        }
        expect(canTransition(from, to), `${from} → ${to}`).toBe(owner !== undefined);
      }
    }
  });

  it('lists what can come next in lifecycle order, per party', () => {
    expect(nextStatuses('offered')).toEqual(['accepted', 'declined']);
    expect(nextStatuses('offered', 'pm')).toEqual([]);
    expect(nextStatuses('delivered', 'pm')).toEqual(['reviewed']);
    expect(nextStatuses('delivered', 'vendor')).toEqual([]);
  });

  it('has exactly two terminal states: declined and reviewed', () => {
    expect(ASSIGNMENT_STATUSES.filter(isTerminal)).toEqual(['declined', 'reviewed']);
  });

  it('lets every non-terminal state reach reviewed', () => {
    const reaches = (
      from: AssignmentStatus,
      seen = new Set<AssignmentStatus>(),
    ): boolean => {
      if (from === 'reviewed') return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return nextStatuses(from).some((to) => reaches(to, seen));
    };
    for (const status of ASSIGNMENT_STATUSES.filter((s) => !isTerminal(s))) {
      expect(reaches(status), status).toBe(true);
    }
  });
});
