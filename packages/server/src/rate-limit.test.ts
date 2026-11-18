import { describe, expect, it } from 'vitest';

import { clientAddress, FixedWindowLimiter, senderKey } from './rate-limit.js';

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

describe('clientAddress', () => {
  const PEER = '10.0.0.2';

  it('is the connection itself when no proxy is trusted, whatever the header claims', () => {
    expect(clientAddress(PEER, undefined, 0)).toBe(PEER);
    expect(clientAddress(PEER, '203.0.113.9', 0)).toBe(PEER);
  });

  it('reads the entry the nearest trusted proxy wrote, not the sender’s own claim', () => {
    // The sender wrote 198.51.100.1; the proxy appended the address it was really called from.
    expect(clientAddress(PEER, '198.51.100.1, 203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientAddress(PEER, '203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientAddress(PEER, ' 2001:db8::1 ', 1)).toBe('2001:db8::1');
  });

  it('counts from the right with two proxies', () => {
    expect(clientAddress(PEER, '198.51.100.1, 203.0.113.9, 10.0.0.1', 2)).toBe(
      '203.0.113.9',
    );
  });

  it('reads a header that arrived in several lines as one list', () => {
    expect(clientAddress(PEER, ['198.51.100.1', '203.0.113.9'], 1)).toBe('203.0.113.9');
  });

  it('falls back to the connection for a request that did not come through the proxies', () => {
    expect(clientAddress(PEER, undefined, 1)).toBe(PEER);
    expect(clientAddress(PEER, '203.0.113.9', 2)).toBe(PEER);
    expect(clientAddress(PEER, 'not-an-address', 1)).toBe(PEER);
    expect(clientAddress(PEER, '203.0.113.9,', 1)).toBe(PEER);
  });
});

describe('senderKey', () => {
  it('keeps an IPv4 address whole', () => {
    expect(senderKey('203.0.113.9')).toBe('203.0.113.9');
    expect(senderKey('203.0.113.9')).not.toBe(senderKey('203.0.113.10'));
  });

  it('counts an IPv4 address written inside IPv6 as that IPv4 address', () => {
    expect(senderKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(senderKey('::FFFF:203.0.113.9')).toBe('203.0.113.9');
  });

  it('counts every IPv6 address of one /64 as one sender', () => {
    const key = senderKey('2001:db8:1:2::1');
    expect(key).toBe('2001:db8:1:2::/64');
    expect(senderKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe(key);
    expect(senderKey('2001:db8:1:2:3:4:5:6')).toBe(key);
    expect(senderKey('2001:db8:1:3::1')).not.toBe(key);
  });

  it('expands a short form before cutting it', () => {
    expect(senderKey('::1')).toBe('0:0:0:0::/64');
    expect(senderKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(senderKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('returns anything that is not an address as one key', () => {
    expect(senderKey('')).toBe('');
    expect(senderKey('unknown')).toBe('unknown');
  });
});
