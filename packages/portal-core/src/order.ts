/**
 * Order lifecycle (portal-v0-spec.md §2).
 *
 * The state machine lives here, once, so a route handler never encodes
 * "which transitions are legal" itself — the same discipline
 * `CLAUDE.md` requires for other frozen, cross-cutting facts.
 */

export const ORDER_STATUSES = [
  'submitted',
  'approved',
  'in_progress',
  'delivered',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Terminal states have no outgoing transitions. */
const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  submitted: ['approved', 'cancelled'],
  approved: ['in_progress', 'cancelled'],
  in_progress: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`cannot transition order from "${from}" to "${to}"`);
    this.name = 'InvalidTransitionError';
  }
}

/** Throws `InvalidTransitionError` if `from -> to` is not a legal move. */
export function assertValidTransition(from: OrderStatus, to: OrderStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
