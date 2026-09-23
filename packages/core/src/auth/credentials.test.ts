import { describe, expect, it } from 'vitest';

import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from './credentials.js';

describe('password hashing', () => {
  it('verifies the correct password and rejects a wrong one', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('never stores the password itself', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored).not.toContain('correct horse battery staple');
  });

  it('salts each hash differently, even for the same password', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    expect(verifyPassword('anything', 'not-a-valid-stored-hash')).toBe(false);
  });
});

describe('session tokens', () => {
  it('generates distinct, high-entropy tokens', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(32);
  });

  it('hashes deterministically, so a lookup by hash finds the same session', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it('never stores the raw token in its hash', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).not.toBe(token);
  });
});
