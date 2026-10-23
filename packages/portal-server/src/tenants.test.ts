/**
 * The portal's tenant registry (backlog #208, `planning/tenant-spec.md` D13): one entry per
 * tenant, each its own file and folder, found by host. Parsing refuses whatever would let two
 * tenants share a file, a folder or a host, because isolation here is by construction and a
 * registry that overlaps would quietly undo it.
 */

import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PortalConfig } from './config.js';
import {
  addTenant,
  configForTenant,
  defaultTenantPaths,
  legacyTenant,
  parseTenantRegistry,
  selectTenant,
  serializeTenantRegistry,
  takeTenantOption,
  TenantRegistryError,
  type PortalTenant,
} from './tenants.js';

const BASE = '/srv/portal';
const entry = (over: Record<string, unknown> = {}) => ({
  tenantId: 1,
  host: 'one.portal.test',
  dbPath: 't1/portal.sqlite',
  storageRoot: 't1/storage',
  ...over,
});
const parse = (...entries: Array<Record<string, unknown>>) =>
  parseTenantRegistry(JSON.stringify({ tenants: entries }), BASE);

describe('parseTenantRegistry', () => {
  it('reads each tenant, with its paths resolved against the registry’s own folder', () => {
    const [a, b] = parse(
      entry(),
      entry({
        tenantId: 2,
        host: 'Two.Portal.Test',
        dbPath: '/abs/two.sqlite',
        storageRoot: '/abs/two',
      }),
    );
    expect(a).toEqual({
      tenantId: 1,
      host: 'one.portal.test',
      dbPath: resolve(BASE, 't1/portal.sqlite'),
      storageRoot: resolve(BASE, 't1/storage'),
    });
    expect(b).toMatchObject({
      tenantId: 2,
      host: 'two.portal.test',
      dbPath: '/abs/two.sqlite',
      storageRoot: '/abs/two',
    });
  });

  it('carries a tenant’s own sender and admin address when it names them', () => {
    const [a] = parse(
      entry({ from: 'Portal <p@example.com>', adminEmail: 'admin@example.com' }),
    );
    expect(a).toMatchObject({
      from: 'Portal <p@example.com>',
      adminEmail: 'admin@example.com',
    });
  });

  it('refuses two tenants that would share a number, a host, a database file or a folder', () => {
    const other = {
      dbPath: 't2/portal.sqlite',
      storageRoot: 't2/storage',
      host: 'two.portal.test',
    };
    expect(() => parse(entry(), entry({ ...other, tenantId: 1 }))).toThrow(
      /tenant #1 twice/,
    );
    expect(() =>
      parse(entry(), entry({ ...other, tenantId: 2, host: 'one.portal.test' })),
    ).toThrow(/host/);
    expect(() =>
      parse(entry(), entry({ ...other, tenantId: 2, dbPath: 't1/portal.sqlite' })),
    ).toThrow(/database/);
    expect(() =>
      parse(entry(), entry({ ...other, tenantId: 2, storageRoot: 't1/storage' })),
    ).toThrow(/folder/);
  });

  it('refuses a folder inside another tenant’s, and a database inside any folder', () => {
    const other = { tenantId: 2, host: 'two.portal.test', dbPath: 't2/portal.sqlite' };
    expect(() =>
      parse(entry(), entry({ ...other, storageRoot: 't1/storage/inner' })),
    ).toThrow(/inside/);
    expect(() =>
      parse(
        entry(),
        entry({ ...other, storageRoot: 't2/storage', dbPath: 't1/storage/two.sqlite' }),
      ),
    ).toThrow(/inside/);
  });

  it('refuses a bad number, a bad host, an empty path, an unknown key and a registry with no tenant', () => {
    expect(() => parse(entry({ tenantId: 0 }))).toThrow(/tenantId/);
    expect(() => parse(entry({ tenantId: 1.5 }))).toThrow(/tenantId/);
    expect(() => parse(entry({ host: 'has a space' }))).toThrow(/host/);
    expect(() => parse(entry({ host: 'a.test:8080' }))).toThrow(/host/);
    expect(() => parse(entry({ host: '' }))).toThrow(/host/);
    expect(() => parse(entry({ dbPath: '' }))).toThrow(/dbPath/);
    expect(() => parse(entry({ hosts: 'typo.test' }))).toThrow(/unknown/);
    expect(() => parseTenantRegistry('{"tenants":[]}', BASE)).toThrow(/at least one/);
    expect(() => parseTenantRegistry('not json', BASE)).toThrow(TenantRegistryError);
    expect(() => parseTenantRegistry('[]', BASE)).toThrow(TenantRegistryError);
  });

  it('round-trips through its own serialisation', () => {
    const tenants = parse(
      entry(),
      entry({
        tenantId: 2,
        host: 'two.portal.test',
        dbPath: 't2/portal.sqlite',
        storageRoot: 't2/storage',
        from: 'x <x@example.com>',
      }),
    );
    expect(parseTenantRegistry(serializeTenantRegistry(tenants), BASE)).toEqual(tenants);
  });
});

describe('the legacy single portal', () => {
  const config: PortalConfig = {
    port: 0,
    dbPath: '/data/portal.sqlite',
    storageRoot: '/data/storage',
    smtp: undefined,
  };

  it('is one tenant on any host, from the paths the portal always used', () => {
    expect(legacyTenant(config)).toEqual({
      tenantId: null,
      host: null,
      dbPath: '/data/portal.sqlite',
      storageRoot: '/data/storage',
    });
  });

  it('gives a tenant its own sender and admin address over the shared transport', () => {
    const smtp = {
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: undefined,
      pass: undefined,
      from: 'Shared <s@example.com>',
      adminEmail: 'ops@example.com',
    };
    const t: PortalTenant = {
      tenantId: 2,
      host: 'two.portal.test',
      dbPath: '/d/2.sqlite',
      storageRoot: '/d/2',
      from: 'Two <two@example.com>',
    };
    const scoped = configForTenant({ ...config, smtp }, t);
    expect(scoped.dbPath).toBe('/d/2.sqlite');
    expect(scoped.storageRoot).toBe('/d/2');
    expect(scoped.smtp).toEqual({ ...smtp, from: 'Two <two@example.com>' });
    expect(configForTenant(config, t).smtp).toBeUndefined();
  });

  it('refuses a tenant with no sender when SMTP is configured, naming where to set one (issue #306)', () => {
    const { from: _from, ...transport } = {
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: undefined,
      pass: undefined,
      from: undefined,
      adminEmail: 'ops@example.com',
    };
    const bare: PortalTenant = {
      tenantId: 2,
      host: 'two.portal.test',
      dbPath: '/d/2.sqlite',
      storageRoot: '/d/2',
    };
    const shared = { ...config, smtp: transport };
    expect(() => configForTenant(shared, bare)).toThrow(
      /tenant 2 has no sender.*PORTAL_SMTP_FROM/,
    );
    expect(() =>
      configForTenant(shared, { ...bare, tenantId: null, host: null }),
    ).toThrow(/the portal has no sender: set PORTAL_SMTP_FROM/);
    // either source is enough, and the tenant's own wins over the shared one
    expect(
      configForTenant(shared, { ...bare, from: 'Two <two@example.com>' }).smtp?.from,
    ).toBe('Two <two@example.com>');
    expect(
      configForTenant(
        { ...config, smtp: { ...transport, from: 'S <s@example.com>' } },
        bare,
      ).smtp?.from,
    ).toBe('S <s@example.com>');
    // no SMTP, no sender needed: console notifications
    expect(configForTenant(config, bare).smtp).toBeUndefined();
  });
});

describe('choosing a tenant on the command line', () => {
  const tenants: PortalTenant[] = [
    { tenantId: 1, host: 'one.test', dbPath: '/d/1.sqlite', storageRoot: '/d/1' },
    { tenantId: 2, host: 'two.test', dbPath: '/d/2.sqlite', storageRoot: '/d/2' },
  ];

  it('takes --tenant from anywhere in the arguments, and leaves the rest in order', () => {
    expect(takeTenantOption(['--tenant', '2', 'a@example.com', 'pw'])).toEqual({
      tenantId: 2,
      rest: ['a@example.com', 'pw'],
    });
    expect(takeTenantOption(['link', '3', '--tenant=1', 'tm'])).toEqual({
      tenantId: 1,
      rest: ['link', '3', 'tm'],
    });
    expect(takeTenantOption(['x'])).toEqual({ tenantId: null, rest: ['x'] });
    expect(() => takeTenantOption(['--tenant'])).toThrow(/tenant/);
    expect(() => takeTenantOption(['--tenant', 'abc'])).toThrow(/tenant/);
  });

  it('needs a tenant when there are several, and finds the one named', () => {
    expect(selectTenant(tenants, 2).host).toBe('two.test');
    expect(() => selectTenant(tenants, null)).toThrow(/--tenant/);
    expect(() => selectTenant(tenants, 9)).toThrow(/no tenant #9/);
  });

  it('needs none for the legacy single portal, and refuses one it does not have', () => {
    const legacy = [
      legacyTenant({
        port: 0,
        dbPath: join('/d', 'p.sqlite'),
        storageRoot: '/d/s',
        smtp: undefined,
      }),
    ];
    expect(selectTenant(legacy, null).tenantId).toBeNull();
    expect(() => selectTenant(legacy, 1)).toThrow(/no tenant registry/);
  });
});

describe('adding a tenant', () => {
  const first: PortalTenant = {
    tenantId: 1,
    host: 'one.test',
    dbPath: '/d/t1/portal.sqlite',
    storageRoot: '/d/t1/storage',
  };

  it('puts a new tenant beside the registry by default, one folder per tenant number', () => {
    expect(defaultTenantPaths('/d/portal-tenants.json', 2)).toEqual({
      dbPath: '/d/t2/portal.sqlite',
      storageRoot: '/d/t2/storage',
    });
  });

  it('adds one that overlaps nothing, and refuses one that shares a number, host, file or folder', () => {
    const second: PortalTenant = {
      tenantId: 2,
      host: 'two.test',
      ...defaultTenantPaths('/d/x.json', 2),
    };
    expect(addTenant([first], second).map((t) => t.tenantId)).toEqual([1, 2]);
    expect(() => addTenant([first], { ...second, tenantId: 1 })).toThrow(/twice/);
    expect(() => addTenant([first], { ...second, host: 'one.test' })).toThrow(/host/);
    expect(() => addTenant([first], { ...second, dbPath: first.dbPath })).toThrow(
      /database/,
    );
    expect(() =>
      addTenant([first], { ...second, storageRoot: first.storageRoot }),
    ).toThrow(/folder/);
  });
});
