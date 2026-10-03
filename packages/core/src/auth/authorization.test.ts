import { describe, expect, it } from 'vitest';

import {
  isProjectScope,
  PROJECT_ACTIONS,
  PROJECT_SCOPES,
  scopeAllows,
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
