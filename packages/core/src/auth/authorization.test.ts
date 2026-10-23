import { describe, expect, it } from 'vitest';

import {
  isProjectScope,
  isTenantRole,
  PROJECT_ACTIONS,
  PROJECT_SCOPES,
  scopeAllows,
  TENANT_ROLES,
} from './authorization.js';

describe('scopeAllows', () => {
  it('lets an assigned translator read and edit, and never manage', () => {
    expect(scopeAllows('assigned_translator', 'read')).toBe(true);
    expect(scopeAllows('assigned_translator', 'edit')).toBe(true);
    expect(scopeAllows('assigned_translator', 'manage')).toBe(false);
  });

  it('answers for every scope and every action', () => {
    for (const scope of PROJECT_SCOPES) {
      for (const action of PROJECT_ACTIONS) {
        expect(typeof scopeAllows(scope, action)).toBe('boolean');
      }
    }
  });
});

describe('isProjectScope', () => {
  it('admits only the closed set', () => {
    expect(isProjectScope('assigned_translator')).toBe(true);
    expect(isProjectScope('owner')).toBe(false);
    expect(isProjectScope(undefined)).toBe(false);
  });
});

describe('TENANT_ROLES', () => {
  it('names the two staff roles of planning/tenant-spec.md D5, and no vendor role', () => {
    expect(TENANT_ROLES).toEqual(['admin', 'pm']);
    // a vendor is never tenant staff (spec D3), so it is not a role here
    expect(isTenantRole('vendor')).toBe(false);
  });

  it('recognises only members of the closed set', () => {
    expect(isTenantRole('admin')).toBe(true);
    expect(isTenantRole('pm')).toBe(true);
    expect(isTenantRole('owner')).toBe(false);
    expect(isTenantRole(undefined)).toBe(false);
  });
});
