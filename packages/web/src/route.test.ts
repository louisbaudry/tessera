import { describe, expect, it } from 'vitest';

import { formatRoute, parseRoute, type Route } from './route.js';

describe('parseRoute / formatRoute', () => {
  it('roundtrips every screen', () => {
    const routes: Route[] = [
      { screen: 'projects' },
      { screen: 'tms' },
      { screen: 'payables' },
      { screen: 'payments' },
      { screen: 'vendors' },
      { screen: 'invite', token: 'AbC_-123456789AbC_-123456789AbC_-1234' },
      { screen: 'project', project: 'job-2026' },
      { screen: 'grid', project: 'job-2026', fileId: 12 },
      { screen: 'job', owner: 7, id: 3 },
      // another account's project is a key (project-key.ts), through the same routes
      { screen: 'project', project: 'job@7' },
      { screen: 'grid', project: 'job@7', fileId: 2 },
    ];
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it('lands anything it does not recognise on the project list', () => {
    for (const hash of [
      '',
      '#',
      '#/x',
      '#/tms/x',
      '#/payables/x',
      '#/payments/1',
      '#/vendors/x',
      '#/invite',
      '#/invite/short',
      '#/invite/has%20a%20space-AbC_-123456789AbC',
      '#/invite/AbC_-123456789AbC_-123456789AbC_-1234/extra',
      '#/p',
      '#/p/job/f',
      '#/p/job/f/0',
      '#/p/job/f/01',
      '#/p/job/f/1.5',
      '#/p/job/f/2/extra',
      '#/p/%E0%A4%A',
      '#/jobs',
      '#/jobs/7',
      '#/jobs/7/x',
      '#/jobs/0/3',
      '#/jobs/7/03',
      '#/jobs/7/3/extra',
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
