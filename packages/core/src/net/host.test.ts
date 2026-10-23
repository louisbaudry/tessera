import { describe, expect, it } from 'vitest';

import { normaliseHost, tenantLabelOfHost } from './host.js';

describe('normaliseHost', () => {
  it('lowercases, drops a port and a trailing dot, and answers null for nothing usable', () => {
    expect(normaliseHost('One.Portal.Test:3300')).toBe('one.portal.test');
    expect(normaliseHost('one.portal.test.')).toBe('one.portal.test');
    expect(normaliseHost('localhost')).toBe('localhost');
    for (const bad of [
      undefined,
      '',
      ':80',
      'a b.test',
      '[::1]:3300',
      'a.test, b.test',
    ]) {
      expect(normaliseHost(bad), String(bad)).toBeNull();
    }
  });
});

describe('tenantLabelOfHost', () => {
  it('names the one label before the base domain, however the host was written', () => {
    expect(tenantLabelOfHost('acme.tessera.example', 'tessera.example')).toBe('acme');
    expect(tenantLabelOfHost('Acme.Tessera.Example:8443', 'tessera.example')).toBe(
      'acme',
    );
    expect(tenantLabelOfHost('acme.localhost:3400', 'localhost')).toBe('acme');
  });

  it('is null for the base domain itself, another domain, a nested name and a bad header', () => {
    expect(tenantLabelOfHost('tessera.example', 'tessera.example')).toBeNull();
    expect(tenantLabelOfHost('acme.other.example', 'tessera.example')).toBeNull();
    expect(tenantLabelOfHost('evil-tessera.example', 'tessera.example')).toBeNull();
    expect(tenantLabelOfHost('a.b.tessera.example', 'tessera.example')).toBeNull();
    expect(
      tenantLabelOfHost('acme.tessera.example.evil.test', 'tessera.example'),
    ).toBeNull();
    expect(tenantLabelOfHost(undefined, 'tessera.example')).toBeNull();
    expect(tenantLabelOfHost('acme.tessera.example', 'not a domain')).toBeNull();
  });
});
