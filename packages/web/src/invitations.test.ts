import { describe, expect, it } from 'vitest';

import {
  acceptProblem,
  canWithdraw,
  inviteLink,
  inviteProblem,
  INVITATION_STATUS_LABEL,
  INVITATION_TTL_DAYS,
} from './invitations.js';
import { parseRoute } from './route.js';

const TOKEN = 'AbC_-123456789AbC_-123456789AbC_-1234';

describe('inviteLink', () => {
  it('keeps the token in the fragment, where no server or log ever sees it', () => {
    const link = inviteLink({ origin: 'https://cat.example', pathname: '/' }, TOKEN);
    expect(link).toBe(`https://cat.example/#/invite/${TOKEN}`);
    expect(new URL(link).search).toBe('');
    expect(new URL(link).pathname).toBe('/');
  });

  it('is a link the app routes back to the accept page', () => {
    const link = inviteLink(
      { origin: 'http://localhost:3400', pathname: '/app/' },
      TOKEN,
    );
    expect(parseRoute(new URL(link).hash)).toEqual({ screen: 'invite', token: TOKEN });
  });
});

describe('the forms', () => {
  it('checks an address the way the server will, and says what is wrong', () => {
    expect(inviteProblem('')).toMatch(/Enter/);
    expect(inviteProblem('bob')).toMatch(/not an email/);
    expect(inviteProblem('  Bob@Example.com ')).toBeNull();
  });

  it('wants a long enough password, typed twice the same', () => {
    expect(acceptProblem('short', 'short')).toMatch(/at least/);
    expect(acceptProblem('a long enough one', 'a long enough two')).toMatch(/differ/);
    expect(acceptProblem('a long enough one', 'a long enough one')).toBeNull();
  });
});

describe('the list', () => {
  it('labels every status and lets only a waiting link be withdrawn', () => {
    expect(INVITATION_STATUS_LABEL).toEqual({
      pending: 'Waiting',
      accepted: 'Joined',
      revoked: 'Withdrawn',
      expired: 'Expired',
    });
    expect(canWithdraw('pending')).toBe(true);
    for (const done of ['accepted', 'revoked', 'expired'] as const) {
      expect(canWithdraw(done)).toBe(false);
    }
  });

  it('states the lifetime in whole days', () => {
    expect(INVITATION_TTL_DAYS).toBe(7);
  });
});
