import { describe, expect, it } from 'vitest';

import { formatRoute, parseRoute, type Route } from './route.js';

describe('parseRoute / formatRoute', () => {
  it('roundtrips every screen', () => {
    const routes: Route[] = [
      { screen: 'projects' },
      { screen: 'project', project: 'job-2026' },
      { screen: 'grid', project: 'job-2026', fileId: 12 },
    ];
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it('lands anything it does not recognise on the project list', () => {
    for (const hash of [
      '',
      '#',
      '#/x',
      '#/p',
      '#/p/job/f',
      '#/p/job/f/0',
      '#/p/job/f/01',
      '#/p/job/f/1.5',
      '#/p/job/f/2/extra',
      '#/p/%E0%A4%A',
    ]) {
      expect(parseRoute(hash), hash).toEqual({ screen: 'projects' });
    }
  });

  it('decodes a name the way it was encoded', () => {
    expect(parseRoute(formatRoute({ screen: 'project', project: 'a b/c' }))).toEqual({
      screen: 'project',
      project: 'a b/c',
    });
  });
});
