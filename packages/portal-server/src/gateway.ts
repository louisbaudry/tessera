/**
 * The portal's front door (backlog #208, `planning/tenant-spec.md` D13): one app per
 * tenant, found by the request's host. Each tenant's app is the existing portal app built
 * over that tenant's own `portal.sqlite` and storage folder, so there is nothing for a
 * route, a query or an upload path to reach another tenant's data with: the closure holding
 * it is not there. The gateway only decides which app a request belongs to.
 *
 * A host that names no tenant is a 404 that says nothing about which hosts exist, and the
 * gateway never falls back to a tenant. The one exception is the legacy single portal (no
 * registry), which answers every host with its one app, as the portal always has.
 */

import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';

import type { NotificationService } from '@cat-tool/portal-core';
import type { FastifyInstance } from 'fastify';

import { buildApp, type BuildAppOptions } from './app.js';
import { CONTACT_SSO_CALLBACK_PATH, tenantNumberOfState } from './contact-sso.js';
import type { PortalConfig } from './config.js';
import {
  configForTenant,
  loadTenants,
  normaliseHost,
  type PortalTenant,
} from './tenants.js';

export interface GatewayOptions {
  readonly config: PortalConfig;
  /** Defaults to the registry (or the legacy portal) `config` names; tests pass their own. */
  readonly tenants?: readonly PortalTenant[];
  readonly notifications?: NotificationService;
  readonly logger?: boolean;
  /** See `BuildAppOptions.sso`: tests pass a provider that never leaves the process. */
  readonly sso?: BuildAppOptions['sso'];
  /** See `BuildAppOptions.onRoute`. */
  readonly onRoute?: (route: { readonly method: string; readonly url: string }) => void;
}

export interface PortalGateway {
  readonly tenants: readonly PortalTenant[];
  /** The app a request for `host` belongs to, or `null` when no tenant answers there. */
  appFor(host: string | undefined): FastifyInstance | null;
  /**
   * The app a request belongs to, the portal's sign-in callback host included (issue #342): that
   * host answers the callback alone, handed to the tenant its state names, and a fixed 404 otherwise.
   * On a tenant's own host the callback is not answered, so a state is claimed only where it was meant
   * to come back. `null` is the 404.
   */
  routeFor(host: string | undefined, method: string, url: string): FastifyInstance | null;
  /** Starts listening; resolves with the address. */
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

const NOT_FOUND = JSON.stringify({ error: 'not found' });

export async function buildGateway(options: GatewayOptions): Promise<PortalGateway> {
  const tenants = options.tenants ?? loadTenants(options.config);
  const apps = new Map<string | null, FastifyInstance>();
  for (const tenant of tenants) {
    mkdirSync(dirname(tenant.dbPath), { recursive: true });
    mkdirSync(tenant.storageRoot, { recursive: true });
    const app = await buildApp({
      config: configForTenant(options.config, tenant),
      ...(options.notifications ? { notifications: options.notifications } : {}),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.onRoute ? { onRoute: options.onRoute } : {}),
      ...(options.sso ? { sso: options.sso } : {}),
    });
    await app.ready();
    apps.set(tenant.host, app);
  }
  // The legacy portal is the one entry with no host: it answers any.
  const only = apps.get(null) ?? null;

  const appFor = (host: string | undefined): FastifyInstance | null => {
    if (only) return only;
    const name = normaliseHost(host);
    return name === null ? null : (apps.get(name) ?? null);
  };

  // The portal's own neutral callback host, when it is not the portal's host itself (sso-spec.md §2b).
  const callbackHost =
    options.config.sso && !only
      ? normaliseHost(new URL(options.config.sso.callbackOrigin).host)
      : null;
  const byNumber = new Map<number, FastifyInstance>();
  for (const tenant of tenants) {
    if (tenant.tenantId !== null) byNumber.set(tenant.tenantId, apps.get(tenant.host)!);
  }

  const routeFor = (host: string | undefined, method: string, url: string) => {
    const path = url.split('?')[0];
    if (callbackHost !== null && normaliseHost(host) === callbackHost) {
      if (method !== 'GET' || path !== CONTACT_SSO_CALLBACK_PATH) return null;
      const state =
        new URL(url, 'http://callback.invalid').searchParams.get('state') ?? '';
      const number = tenantNumberOfState(state);
      return number === null ? null : (byNumber.get(number) ?? null);
    }
    if (callbackHost !== null && path === CONTACT_SSO_CALLBACK_PATH) return null;
    return appFor(host);
  };

  let server: Server | null = null;
  return {
    tenants,
    appFor,
    routeFor,
    async listen(port, host = '0.0.0.0') {
      server = createServer((req, res) => {
        const app = routeFor(req.headers.host, req.method ?? 'GET', req.url ?? '/');
        if (!app) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(NOT_FOUND);
          return;
        }
        app.routing(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, host, resolve);
      });
      return server.address() as AddressInfo;
    },
    async close() {
      if (server) {
        const closing = server;
        server = null;
        await new Promise<void>((resolve) => closing.close(() => resolve()));
      }
      await Promise.all([...apps.values()].map((app) => app.close()));
    },
  };
}
