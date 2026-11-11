import { describe, expect, it } from 'vitest';

import { FixedWindowLimiter } from './rate-limit.js';

const MINUTE = 60_000;

describe('FixedWindowLimiter', () => {
  it('allows up to the limit in a window and refuses the next request', () => {
    const limiter = new FixedWindowLimiter(3, MINUTE);
    const t = 1_000_000;
    expect(limiter.take('a', t)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.take('a', t + 1)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.take('a', t + 2)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.take('a', t + 3)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('tells a refused client how many whole seconds remain in the window', () => {
    const limiter = new FixedWindowLimiter(1, MINUTE);
    const t = 5_000_000;
    limiter.take('a', t);
    // 20.5 s into the window: 39.5 s remain, rounded up to 40.
    expect(limiter.take('a', t + 20_500)).toEqual({
      allowed: false,
      retryAfterSeconds: 40,
    });
  });

  it('never tells a client to retry in zero seconds', () => {
    const limiter = new FixedWindowLimiter(1, MINUTE);
    const t = 5_000_000;
    limiter.take('a', t);
    // The last millisecond of the window still leaves one second to wait, not zero.
    expect(limiter.take('a', t + MINUTE - 1).retryAfterSeconds).toBe(1);
  });

  it('starts a fresh count once the window has ended', () => {
    const limiter = new FixedWindowLimiter(1, MINUTE);
    const t = 9_000_000;
    expect(limiter.take('a', t).allowed).toBe(true);
    expect(limiter.take('a', t + MINUTE - 1).allowed).toBe(false);
    expect(limiter.take('a', t + MINUTE)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it('counts each key on its own', () => {
    const limiter = new FixedWindowLimiter(1, MINUTE);
    const t = 1_000;
    expect(limiter.take('a', t).allowed).toBe(true);
    expect(limiter.take('a', t).allowed).toBe(false);
    expect(limiter.take('b', t).allowed).toBe(true);
  });

  it('does not count a refused request, so the client is not penalised for retrying', () => {
    const limiter = new FixedWindowLimiter(2, MINUTE);
    const t = 1_000;
    limiter.take('a', t);
    limiter.take('a', t);
    for (let i = 0; i < 50; i++) limiter.take('a', t + i);
    // Still refused at the end of the window, and allowed exactly when the window resets.
    expect(limiter.take('a', t + MINUTE - 1).allowed).toBe(false);
    expect(limiter.take('a', t + MINUTE).allowed).toBe(true);
  });

  it('sweeps ended windows once the table is large, so memory follows the active keys', () => {
    const limiter = new FixedWindowLimiter(1, MINUTE);
    const t = 1_000;
    for (let i = 0; i < 10_000; i++) limiter.take(`old-${i}`, t);
    // Every old window has ended by now; the next new key triggers the sweep.
    const later = t + MINUTE;
    expect(limiter.take('fresh', later).allowed).toBe(true);
    // Its own state survived the sweep, and an old key starts over rather than being refused.
    expect(limiter.take('fresh', later).allowed).toBe(false);
    expect(limiter.take('old-0', later).allowed).toBe(true);
  });

  it('rejects a limit or window that cannot mean anything', () => {
    expect(() => new FixedWindowLimiter(0, MINUTE)).toThrow(RangeError);
    expect(() => new FixedWindowLimiter(1.5, MINUTE)).toThrow(RangeError);
    expect(() => new FixedWindowLimiter(1, 0)).toThrow(RangeError);
  });
});
