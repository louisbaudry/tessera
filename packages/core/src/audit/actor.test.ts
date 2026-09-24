import { describe, expect, it } from 'vitest';

import { formatActor, parseActor, type Actor } from './actor.js';

describe('parseActor / formatActor', () => {
  const valid: Array<[string, Actor]> = [
    ['account:3', { kind: 'account', id: 3 }],
    ['admin:1', { kind: 'admin', id: 1 }],
    ['client:42', { kind: 'client', id: 42 }],
    ['cli:louis', { kind: 'cli', name: 'louis' }],
    // Windows user names contain spaces; the first colon splits, so a name may hold one.
    ['cli:Jane Doe', { kind: 'cli', name: 'Jane Doe' }],
    ['cli:DOMAIN:jdoe', { kind: 'cli', name: 'DOMAIN:jdoe' }],
    ['system:migration', { kind: 'system', name: 'migration' }],
    ['system:tm.import-v2', { kind: 'system', name: 'tm.import-v2' }],
  ];

  it.each(valid)('round-trips %s', (text, actor) => {
    expect(parseActor(text)).toEqual(actor);
    expect(formatActor(actor)).toBe(text);
  });

  it.each([
    '',
    'account',
    'account:',
    'account:0',
    // One spelling per principal: these would be second names for account:3.
    'account:03',
    'account:+3',
    'account: 3',
    'account:3.0',
    'account:-1',
    'account:99999999999999999999',
    'user:3',
    'Account:3',
    'cli:',
    'cli: louis',
    'cli:louis ',
    'cli:lou\nis',
    'system:',
    'system:Migration',
    'system:1job',
    'system:my job',
  ])('rejects %j', (text) => {
    expect(() => parseActor(text)).toThrow(/malformed actor/);
  });

  it('refuses to format an actor the grammar would not parse', () => {
    expect(() => formatActor({ kind: 'account', id: 0 })).toThrow(/malformed actor/);
    expect(() => formatActor({ kind: 'account', id: 1.5 })).toThrow(/malformed actor/);
    expect(() => formatActor({ kind: 'system', name: 'Nightly Job' })).toThrow(
      /malformed actor/,
    );
  });
});
