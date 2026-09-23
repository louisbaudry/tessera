import { describe, expect, it } from 'vitest';

import { qualifySchema, SchemaAliasError } from './schema-alias.js';

describe('qualifySchema', () => {
  it('returns the empty string for the main database (schema omitted)', () => {
    expect(qualifySchema(undefined)).toBe('');
  });

  it('returns "alias." for a valid identifier', () => {
    expect(qualifySchema('tm_1')).toBe('tm_1.');
    expect(qualifySchema('glossary_42')).toBe('glossary_42.');
    expect(qualifySchema('_leading_underscore')).toBe('_leading_underscore.');
  });

  it('refuses an alias that is not a bare identifier', () => {
    expect(() => qualifySchema('tm_1; DROP TABLE tu')).toThrow(SchemaAliasError);
    expect(() => qualifySchema('tm 1')).toThrow(SchemaAliasError);
    expect(() => qualifySchema('1tm')).toThrow(SchemaAliasError);
    expect(() => qualifySchema('')).toThrow(SchemaAliasError);
  });
});
