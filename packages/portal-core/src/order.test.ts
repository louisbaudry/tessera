import { describe, expect, it } from 'vitest';

import {
  assertCanApprove,
  assertCanPrice,
  assertValidTransition,
  canTransition,
  InvalidTransitionError,
  OrderPricingError,
} from './order.js';

describe('order lifecycle transitions', () => {
  it('allows the happy path', () => {
    expect(canTransition('submitted', 'approved')).toBe(true);
    expect(canTransition('approved', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'delivered')).toBe(true);
  });

  it('allows cancellation from any non-terminal state', () => {
    expect(canTransition('submitted', 'cancelled')).toBe(true);
    expect(canTransition('approved', 'cancelled')).toBe(true);
    expect(canTransition('in_progress', 'cancelled')).toBe(true);
  });

  it('rejects skipping a state', () => {
    expect(canTransition('submitted', 'in_progress')).toBe(false);
    expect(canTransition('submitted', 'delivered')).toBe(false);
  });

  it('rejects any transition out of a terminal state', () => {
    expect(canTransition('delivered', 'in_progress')).toBe(false);
    expect(canTransition('delivered', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'submitted')).toBe(false);
  });

  it('rejects moving backwards', () => {
    expect(canTransition('approved', 'submitted')).toBe(false);
  });

  it('assertValidTransition throws InvalidTransitionError on an illegal move', () => {
    expect(() => assertValidTransition('submitted', 'delivered')).toThrow(
      InvalidTransitionError,
    );
  });

  it('assertValidTransition is silent on a legal move', () => {
    expect(() => assertValidTransition('submitted', 'approved')).not.toThrow();
  });
});

describe('pricing rules (backlog #63)', () => {
  it('prices a submitted order, priced or not', () => {
    expect(() => assertCanPrice('submitted', null)).not.toThrow();
    expect(() => assertCanPrice('submitted', 120)).not.toThrow();
  });

  it('prices an approved or in-progress order once, only if it has no price', () => {
    expect(() => assertCanPrice('approved', null)).not.toThrow();
    expect(() => assertCanPrice('in_progress', null)).not.toThrow();
    expect(() => assertCanPrice('approved', 120)).toThrow(OrderPricingError);
    expect(() => assertCanPrice('in_progress', 120)).toThrow(OrderPricingError);
  });

  it('never prices a delivered or cancelled order', () => {
    for (const price of [null, 120]) {
      expect(() => assertCanPrice('delivered', price)).toThrow(OrderPricingError);
      expect(() => assertCanPrice('cancelled', price)).toThrow(OrderPricingError);
    }
  });

  it('approves only a priced order, and only at the price seen', () => {
    expect(() => assertCanApprove(null)).toThrow(OrderPricingError);
    expect(() => assertCanApprove(null, 120)).toThrow(OrderPricingError);
    expect(() => assertCanApprove(120)).not.toThrow();
    expect(() => assertCanApprove(120, 120)).not.toThrow();
    expect(() => assertCanApprove(150, 120)).toThrow(/reload/);
  });
});
