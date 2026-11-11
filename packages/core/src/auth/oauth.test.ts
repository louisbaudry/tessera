import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  isCodeChallenge,
  isLoopbackRedirect,
  pkceMatches,
  redirectMatches,
  redirectUriProblem,
} from './oauth.js';

describe('redirectUriProblem', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'http://localhost/callback',
    'http://127.0.0.1:3118/callback',
    'http://[::1]/cb',
  ])('accepts %s', (uri) => {
    expect(redirectUriProblem(uri)).toBeNull();
  });

  it.each([
    ['http://example.com/cb', 'plain http to another machine'],
    ['https://example.com/cb#frag', 'a fragment'],
    ['https://user:pw@example.com/cb', 'credentials'],
    ['javascript:alert(1)', 'a script'],
    ['custom-app://cb', 'another scheme'],
    ['/relative', 'not absolute'],
    ['', 'empty'],
    [`https://example.com/${'x'.repeat(2000)}`, 'too long'],
    [42, 'not a string'],
    ['http://localhost.evil.example/cb', 'a host that only starts like loopback'],
  ] as [unknown, string][])('refuses %j (%s)', (uri, _why) => {
    expect(redirectUriProblem(uri)).not.toBeNull();
  });
});

describe('redirectMatches', () => {
  const registered = [
    'https://claude.ai/api/mcp/auth_callback',
    'http://localhost/callback',
  ];

  it('matches a registered address exactly', () => {
    expect(redirectMatches(registered, 'https://claude.ai/api/mcp/auth_callback')).toBe(
      true,
    );
    expect(redirectMatches(registered, 'https://claude.ai/api/mcp/auth_callback/')).toBe(
      false,
    );
    expect(
      redirectMatches(registered, 'https://claude.ai/api/mcp/auth_callback?x=1'),
    ).toBe(false);
    expect(
      redirectMatches(registered, 'https://claude.ai.evil.example/api/mcp/auth_callback'),
    ).toBe(false);
  });

  it('matches a loopback address on any port, and nothing else about it', () => {
    expect(redirectMatches(registered, 'http://localhost:3118/callback')).toBe(true);
    expect(redirectMatches(registered, 'http://localhost:3118/other')).toBe(false);
    // Another loopback name was not registered.
    expect(redirectMatches(registered, 'http://127.0.0.1:3118/callback')).toBe(false);
    // The port is never ignored for an address that is not loopback.
    expect(
      redirectMatches(['https://example.com/cb'], 'https://example.com:8443/cb'),
    ).toBe(false);
  });

  it('knows a loopback address', () => {
    expect(isLoopbackRedirect('http://localhost:9/x')).toBe(true);
    expect(isLoopbackRedirect('https://localhost/x')).toBe(false);
    expect(isLoopbackRedirect('http://example.com/x')).toBe(false);
  });
});

describe('pkceMatches', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  it('accepts the verifier behind the challenge, and RFC 7636’s own example', () => {
    expect(pkceMatches(verifier, challenge)).toBe(true);
    // RFC 7636, Appendix B.
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('refuses another verifier, a short one and a non-string', () => {
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false);
    expect(pkceMatches('short', challenge)).toBe(false);
    expect(pkceMatches(undefined, challenge)).toBe(false);
    // The challenge itself is not its own verifier (that would be the "plain" method).
    expect(pkceMatches(challenge, challenge)).toBe(false);
  });

  it('knows the shape of a challenge', () => {
    expect(isCodeChallenge(challenge)).toBe(true);
    expect(isCodeChallenge('too-short')).toBe(false);
    expect(isCodeChallenge(null)).toBe(false);
  });
});
