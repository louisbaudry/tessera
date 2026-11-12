import { describe, expect, it } from 'vitest';

import { consentBody, destinationLine, parseConnectRequest } from './connect.js';
import { formatRoute, parseRoute } from './route.js';

const REQUEST = {
  clientId: 'abc_DEF-123',
  redirectUri: 'https://chat.example/callback?x=1&y=/z',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  state: 'a b/c?d=e&f',
};

describe('the connect request', () => {
  it('survives the address: slashes, question marks and ampersands in its parts', () => {
    const hash = formatRoute({ screen: 'connect', request: REQUEST });
    expect(hash.startsWith('#/connect?')).toBe(true);
    expect(parseRoute(hash)).toEqual({ screen: 'connect', request: REQUEST });
  });

  it('reads what the server\u2019s redirect writes', () => {
    const query = new URLSearchParams({
      client_id: 'c',
      redirect_uri: 'http://localhost:5000/callback',
      code_challenge: 'x',
    }).toString();
    expect(parseRoute(`#/connect?${query}`)).toEqual({
      screen: 'connect',
      request: {
        clientId: 'c',
        redirectUri: 'http://localhost:5000/callback',
        codeChallenge: 'x',
        state: null,
      },
    });
  });

  it('is the project list when a part is missing', () => {
    expect(parseConnectRequest('client_id=c&redirect_uri=u')).toBeNull();
    expect(parseRoute('#/connect?client_id=c')).toEqual({ screen: 'projects' });
    expect(parseRoute('#/connect')).toEqual({ screen: 'projects' });
  });

  it('answers with exactly what was asked, and state only when there was one', () => {
    expect(consentBody(REQUEST, true)).toEqual({
      client_id: REQUEST.clientId,
      redirect_uri: REQUEST.redirectUri,
      code_challenge: REQUEST.codeChallenge,
      state: REQUEST.state,
      allow: true,
    });
    expect(consentBody({ ...REQUEST, state: null }, false)).not.toHaveProperty('state');
    expect(consentBody(REQUEST, false).allow).toBe(false);
  });
});

describe('destinationLine', () => {
  const client = {
    clientName: 'X',
    redirectHost: 'chat.example',
    loopback: false,
    staff: true,
  };

  it('names the checked host, or says it is this computer', () => {
    expect(destinationLine(client)).toBe('The answer goes to chat.example.');
    expect(
      destinationLine({ ...client, redirectHost: 'localhost:5000', loopback: true }),
    ).toBe('The answer goes to a program on this computer.');
  });
});
