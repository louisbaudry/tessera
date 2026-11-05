/**
 * S0 probes of the software-localisation scenario (planning/software-localisation-spec.md
 * sections 5 and 6, Epic 16): what the QA rules and the glossary match do today over
 * English to Ukrainian, Russian and Simplified Chinese. Each case is **a recorded observation,
 * not a claim that the behaviour is right**: a line that says "misfires" documents a false
 * finding or a false mismatch that H3 and slice S5 are about. If a later slice changes one on
 * purpose, its test changes with it and `research/software-localisation/journal.md` says why.
 *
 * Every sentence is invented for this repository.
 */

import { describe, expect, it } from 'vitest';

import { mismatchFinder, type GlossaryTermEntry } from '../glossary/mismatch.js';
import { termKey } from '../glossary/key.js';
import type { Token } from '../model/token.js';
import { QA_CHECKS, runQaChecks } from './rules.js';

const text = (v: string): Token => ({ t: 'text', v });
const ALL = new Set(Object.keys(QA_CHECKS) as (keyof typeof QA_CHECKS)[]);

/** The rules that fire on one invented pair, by name. */
function qa(tgtLang: string, source: string, target: string): string[] {
  return runQaChecks(
    {
      source: [text(source)],
      target: [text(target)],
      status: 'translated',
      srcLang: 'en',
      tgtLang,
    },
    ALL,
  ).map((f) => f.rule);
}

describe('QA over a Ukrainian, Russian or Simplified Chinese target (S0 probe)', () => {
  it('stays quiet on plain sentences, a question, brackets and a colon', () => {
    expect(qa('uk', 'Saved 3 items.', 'Збережено 3 елементи.')).toEqual([]);
    expect(qa('uk', 'Delete this plant?', 'Видалити цю рослину?')).toEqual([]);
    expect(qa('uk', 'Items (3)', 'Елементи (3)')).toEqual([]);
    expect(qa('ru', 'Delete this plant?', 'Удалить это растение?')).toEqual([]);
    expect(qa('zh-Hans', 'Total: 12', '总计：12')).toEqual([]);
    expect(qa('zh-Hans', 'Items (3)', '项目（3）')).toEqual([]);
  });

  it('misfires: num.altered on a correct Ukrainian or Russian number format (no table entry for either language)', () => {
    expect(qa('uk', 'Price: 1,234.50', 'Ціна: 1 234,50')).toEqual(['num.altered']);
    expect(qa('uk', 'Rows: 1.5 hours', 'Рядків: 1,5 години')).toEqual(['num.altered']);
    expect(qa('ru', 'Price: 1,234.50', 'Цена: 1 234,50')).toEqual(['num.altered']);
    // The same pair into a language the table does hold is silent: the table is the cause.
    expect(qa('fr', 'Price 1,234.50', 'Prix 1 234,50')).toEqual([]);
  });

  it('misfires: punct.terminal on a correct full-width full stop or question mark in Chinese', () => {
    expect(qa('zh-Hans', 'Saved.', '已保存。')).toEqual(['punct.terminal']);
    expect(qa('zh-Hans', 'Delete this plant?', '要删除这株植物吗？')).toEqual([
      'punct.terminal',
    ]);
  });

  it('fires correctly: punct.terminal when the Chinese target has no terminal at all', () => {
    expect(qa('zh-Hans', 'Open the page and wait.', '打开页面并等待')).toEqual([
      'punct.terminal',
    ]);
  });
});

const form = (value: string) => ({ text: value, plain: termKey(value) });
const entry = (source: string, preferred: string): GlossaryTermEntry => ({
  termId: 1,
  source: [form(source)],
  preferred: form(preferred),
  alternatives: [],
  forbidden: [],
});

/** The mismatch kinds on one invented pair, for a one-term glossary. */
function glossary(
  tgtLang: string,
  preferred: string,
  source: string,
  target: string,
): string[] {
  const find = mismatchFinder([entry('plant', preferred)], { srcLang: 'en', tgtLang });
  return find([text(source)], [text(target)]).map((m) => m.kind);
}

describe('glossary matching on an inflected or Chinese rendering (S0 probe)', () => {
  it('passes the dictionary form as the sentence subject', () => {
    expect(glossary('uk', 'рослина', 'The plant is dry.', 'Рослина суха.')).toEqual([]);
    expect(glossary('zh-Hans', '植物', 'Plant', '植物')).toEqual([]);
  });

  it('misfires: an inflected Ukrainian or Russian rendering is a missing_preferred (no ending list for either)', () => {
    expect(
      glossary('uk', 'рослина', 'Water the plant daily.', 'Поливайте рослину щодня.'),
    ).toEqual(['missing_preferred']);
    expect(glossary('uk', 'рослина', 'Two plants.', 'Дві рослини.')).toEqual([
      'missing_preferred',
    ]);
    expect(glossary('ru', 'растение', 'Two plants.', 'Два растения.')).toEqual([
      'missing_preferred',
    ]);
    // A form that happens to equal the dictionary form passes, so the cause is inflection.
    expect(
      glossary(
        'ru',
        'растение',
        'Water the plant daily.',
        'Поливайте растение ежедневно.',
      ),
    ).toEqual([]);
  });

  it('misfires: a Chinese rendering inside a sentence is a missing_preferred (no word boundary to match on)', () => {
    expect(
      glossary('zh-Hans', '植物', 'Water the plant daily.', '每天给植物浇水。'),
    ).toEqual(['missing_preferred']);
    expect(
      glossary('zh-Hans', '植物', 'Delete this plant?', '要删除这株植物吗？'),
    ).toEqual(['missing_preferred']);
  });
});
