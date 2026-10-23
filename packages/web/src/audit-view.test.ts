import { describe, expect, it } from 'vitest';

import { aboutLabel, ACTION_LABEL, actionLabel, whoLabel } from './audit-view.js';

describe('actionLabel', () => {
  it('words every action, each as a sentence of its own', () => {
    // completeness is the compiler's: ACTION_LABEL is a Record over core's PlatformAuditAction
    const labels = Object.values(ACTION_LABEL);
    expect(labels.every((l) => l.length > 3)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    for (const action of Object.keys(ACTION_LABEL))
      expect(actionLabel(action)).not.toBe(action);
  });

  it('shows an action it does not know as it is, never hiding the event', () => {
    expect(actionLabel('something.new')).toBe('something.new');
  });
});

describe('whoLabel', () => {
  it('prefers the label written at the time, and falls back to the actor', () => {
    expect(whoLabel({ actor: 'account:3', actorLabel: 'pat@example.com' })).toBe(
      'pat@example.com',
    );
    expect(whoLabel({ actor: 'cli:root', actorLabel: null })).toBe('cli:root');
    expect(whoLabel({ actor: 'account:3', actorLabel: '[erased]' })).toBe('[erased]');
    expect(whoLabel({ actor: 'account:3', actorLabel: '' })).toBe('account:3');
  });
});

describe('aboutLabel', () => {
  it('names a project by its name, whichever prefix the log used', () => {
    expect(aboutLabel({ subjectType: 'project', subjectId: 't2/brochure' })).toBe(
      'Project brochure',
    );
    expect(aboutLabel({ subjectType: 'project', subjectId: '3/brochure' })).toBe(
      'Project brochure',
    );
  });

  it('names anything else by kind and id, and a subjectless event by nothing', () => {
    expect(aboutLabel({ subjectType: 'client', subjectId: '7' })).toBe('Client 7');
    expect(aboutLabel({ subjectType: 'account', subjectId: '4' })).toBe('account #4');
    expect(aboutLabel({ subjectType: 'account', subjectId: null })).toBeNull();
  });
});
