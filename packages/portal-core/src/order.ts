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

/**
 * Why an order's price may not be set or approved (portal-v0-spec.md §2,
 * §3; backlog #63). One error type for the pricing rules, the way
 * `InvalidTransitionError` is the one for transitions, so a route maps
 * both to 409 without knowing which rule refused.
 */
export class OrderPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderPricingError';
  }
}

/**
 * An order may be priced while `submitted`. Once approved, the price the
 * client approved is the price. The one exception is an order approved
 * or in progress with no price at all, which only the admin path could
 * produce before #63: it may be priced once, so it can be invoiced.
 */
export function assertCanPrice(status: OrderStatus, currentPrice: number | null): void {
  if (status === 'submitted') return;
  if (currentPrice === null && (status === 'approved' || status === 'in_progress'))
    return;
  throw new OrderPricingError(
    currentPrice === null
      ? `cannot price an order that is ${status}`
      : `cannot re-price an order that is ${status}: its price is settled`,
  );
}

/**
 * Approval needs a price, and, when the approver says which price it saw
 * (the client does), that price. A mismatch means the order was re-priced
 * after the approver's page loaded: approving it would record consent to
 * a price nobody showed them.
 */
export function assertCanApprove(price: number | null, seenPrice?: number): void {
  if (price === null) {
    throw new OrderPricingError('cannot approve an order that has no price yet');
  }
  if (seenPrice !== undefined && seenPrice !== price) {
    throw new OrderPricingError(
      `the order's price is now ${price}, not the ${seenPrice} shown: reload and approve again`,
    );
  }
}
