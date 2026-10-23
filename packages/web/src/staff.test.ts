import { describe, expect, it } from 'vitest';

import { parseRoute } from './route.js';
import {
  LAST_ADMIN_WHY,
  memberControls,
  otherRoles,
  staffInviteLink,
  staffInviteProblem,
  STAFF_ROLES,
  STAFF_ROLE_LABEL,
} from './staff.js';

const TOKEN = 'AbC_-123456789AbC_-123456789AbC_-1234';

describe('staffInviteLink', () => {
  it('keeps the token in the fragment, where no server or log ever sees it', () => {
    const link = staffInviteLink({ origin: 'https://cat.example', pathname: '/' }, TOKEN);
    expect(link).toBe(`https://cat.example/#/join/${TOKEN}`);
    expect(new URL(link).search).toBe('');
  });

  it('is routed to the staff accept page, and not to the vendor one', () => {
    const link = staffInviteLink(
      { origin: 'http://localhost:3400', pathname: '/app/' },
      TOKEN,
    );
    expect(parseRoute(new URL(link).hash)).toEqual({ screen: 'join', token: TOKEN });
    expect(parseRoute(`#/invite/${TOKEN}`)).toEqual({ screen: 'invite', token: TOKEN });
  });
});

describe('the form', () => {
  it('checks an address the way the vendor form does', () => {
    expect(staffInviteProblem('')).toMatch(/Enter/);
    expect(staffInviteProblem('not an address')).toMatch(/not an email/);
    expect(staffInviteProblem('Pat@Example.com')).toBeNull();
  });

  it('offers exactly the roles core declares, each named', () => {
    expect(STAFF_ROLES).toEqual(['admin', 'pm']);
    for (const role of STAFF_ROLES) expect(STAFF_ROLE_LABEL[role]).not.toBe('');
    expect(otherRoles('admin')).toEqual(['pm']);
    expect(otherRoles('pm')).toEqual(['admin']);
  });
});

describe('memberControls', () => {
  it('turns off both controls for the only admin, and says why', () => {
    const staff = [
      { accountId: 1, role: 'admin' as const },
      { accountId: 2, role: 'pm' as const },
    ];
    expect(memberControls(staff, staff[0]!)).toEqual({
      canDemote: false,
      canRemove: false,
      why: LAST_ADMIN_WHY,
    });
  });

  it('leaves a pm free to be changed or removed, and an admin once there are two', () => {
    const staff = [
      { accountId: 1, role: 'admin' as const },
      { accountId: 2, role: 'admin' as const },
      { accountId: 3, role: 'pm' as const },
    ];
    expect(memberControls(staff, staff[2]!)).toEqual({
      canDemote: true,
      canRemove: true,
      why: null,
    });
    expect(memberControls(staff, staff[0]!).canRemove).toBe(true);
    expect(memberControls(staff, staff[1]!).why).toBeNull();
  });
});
