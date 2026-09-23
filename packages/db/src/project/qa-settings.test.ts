import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QA_RULES } from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { openProjectDb } from './index.js';
import { isRuleEnabled, listEnabledRules, setRuleEnabled } from './qa-settings.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-project-qa-settings-'));
  return join(dir, 'project.catdb');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('isRuleEnabled / setRuleEnabled', () => {
  it('every rule is enabled by default, with no row written for it', () => {
    const db = openProjectDb(dbPath());
    expect(isRuleEnabled(db, 'tag.missing')).toBe(true);
    expect(db.prepare('SELECT count(*) as n FROM qa_rule_setting').get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it('turning a rule off is reflected immediately', () => {
    const db = openProjectDb(dbPath());
    setRuleEnabled(db, 'tag.extra', false);
    expect(isRuleEnabled(db, 'tag.extra')).toBe(false);
    expect(isRuleEnabled(db, 'tag.missing')).toBe(true);
    db.close();
  });

  it('turning a rule back on removes the disabled state', () => {
    const db = openProjectDb(dbPath());
    setRuleEnabled(db, 'tag.extra', false);
    setRuleEnabled(db, 'tag.extra', true);
    expect(isRuleEnabled(db, 'tag.extra')).toBe(true);
    db.close();
  });

  it('setting the same rule twice does not insert a second row', () => {
    const db = openProjectDb(dbPath());
    setRuleEnabled(db, 'tag.extra', false);
    setRuleEnabled(db, 'tag.extra', false);
    expect(db.prepare('SELECT count(*) as n FROM qa_rule_setting').get()).toEqual({
      n: 1,
    });
    db.close();
  });
});

describe('listEnabledRules', () => {
  it('returns every QA_RULES entry when nothing has been switched off', () => {
    const db = openProjectDb(dbPath());
    expect(listEnabledRules(db)).toEqual(new Set(QA_RULES));
    db.close();
  });

  it('excludes exactly the rules turned off', () => {
    const db = openProjectDb(dbPath());
    setRuleEnabled(db, 'tag.extra', false);
    setRuleEnabled(db, 'punct.spacing', false);
    const enabled = listEnabledRules(db);
    expect(enabled.has('tag.extra')).toBe(false);
    expect(enabled.has('punct.spacing')).toBe(false);
    expect(enabled.has('tag.missing')).toBe(true);
    expect(enabled.size).toBe(QA_RULES.length - 2);
    db.close();
  });
});
