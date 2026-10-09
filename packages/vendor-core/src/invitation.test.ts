import { describe, expect, it } from 'vitest';

import {
  INVITATION_TTL_MS,
  invitationStatus,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  normalizeInviteEmail,
  passwordProblem,
} from './invitation.js';

const T0 = new Date('2026-10-09T10:00:00.000Z');
const expiresAt = new Date(T0.getTime() + INVITATION_TTL_MS).toISOString();
const open = { acceptedAt: null, revokedAt: null, expiresAt };

describe('invitationStatus', () => {
  it('is pending until the expiry instant, then expired', () => {
    expect(invitationStatus(open, T0)).toBe('pending');
    expect(invitationStatus(open, new Date(T0.getTime() + INVITATION_TTL_MS - 1))).toBe(
      'pending',
    );
    expect(invitationStatus(open, new Date(T0.getTime() + INVITATION_TTL_MS))).toBe(
      'expired',
    );
  });

  it('lets an act outrank the clock: used stays accepted, withdrawn stays revoked', () => {
    const late = new Date(T0.getTime() + 10 * INVITATION_TTL_MS);
    expect(invitationStatus({ ...open, acceptedAt: T0.toISOString() }, late)).toBe(
      'accepted',
    );
    expect(invitationStatus({ ...open, revokedAt: T0.toISOString() }, late)).toBe(
      'revoked',
    );
  });

  it('calls a link that was both used and revoked accepted: the account exists', () => {
    expect(
      invitationStatus(
        { ...open, acceptedAt: T0.toISOString(), revokedAt: T0.toISOString() },
        T0,
      ),
    ).toBe('accepted');
  });
});

describe('normalizeInviteEmail', () => {
  it('trims and lower-cases, so one address is one account', () => {
    expect(normalizeInviteEmail('  Bob.Smith@Example.COM ')).toBe(
      'bob.smith@example.com',
    );
  });

  it('refuses what cannot be an address', () => {
    for (const bad of [
      '',
      'bob',
      'bob@',
      '@example.com',
      'bob@example',
      'a b@c.de',
      'a@b@c.de',
    ]) {
      expect(normalizeInviteEmail(bad), bad).toBeNull();
    }
    expect(normalizeInviteEmail(`${'a'.repeat(250)}@b.de`)).toBeNull();
  });
});

describe('passwordProblem', () => {
  it('accepts the shortest and longest allowed, and says why otherwise', () => {
    expect(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem('x'.repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(/at least/);
    expect(passwordProblem('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toMatch(/at most/);
  });
});
