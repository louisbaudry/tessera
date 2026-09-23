import { describe, expect, it } from 'vitest';

import { assertValidTransition, canTransition, InvalidTransitionError } from './order.js';

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
