import { describe, expect, it } from 'vitest';

import { screenAllowed, type Viewer } from './screen-access.js';

const admin: Viewer = { role: 'owner', staffRole: 'admin' };
const pm: Viewer = { role: 'owner', staffRole: 'pm' };
const vendor: Viewer = { role: 'vendor', staffRole: null };

describe('screenAllowed', () => {
  it('gives staff the tenant screens and a vendor none of them', () => {
    for (const screen of ['tms', 'vendors', 'payables'] as const) {
      expect(screenAllowed(screen, admin), screen).toBe(true);
      expect(screenAllowed(screen, pm), screen).toBe(true);
      expect(screenAllowed(screen, vendor), screen).toBe(false);
    }
  });

  it('keeps the staff list, the activity log and the AI spend to an admin', () => {
    for (const screen of ['staff', 'audit', 'ai-spend'] as const) {
      expect(screenAllowed(screen, admin), screen).toBe(true);
      expect(screenAllowed(screen, pm), screen).toBe(false);
      expect(screenAllowed(screen, vendor), screen).toBe(false);
    }
  });

  it('keeps the payments record to a vendor', () => {
    expect(screenAllowed('payments', vendor)).toBe(true);
    expect(screenAllowed('payments', admin)).toBe(false);
    expect(screenAllowed('payments', pm)).toBe(false);
  });

  it('lets everyone reach the screens every account has', () => {
    for (const screen of ['projects', 'project', 'grid', 'job', 'account'] as const) {
      for (const viewer of [admin, pm, vendor]) {
        expect(screenAllowed(screen, viewer), screen).toBe(true);
      }
    }
  });
});
