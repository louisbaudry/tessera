/**
 * Making the request for one webhook delivery (`planning/vendor-spec.md`, its
 * #125 note). This is the only place the server calls a URL a person typed, so
 * it is deliberately narrow: the name is resolved here, **every** address it
 * resolves to must be public, and the connection is made to the address that
 * was checked, so what was vetted is what is dialled (a name that resolves
 * differently a moment later cannot redirect the call). Redirects are never
 * followed, TLS is verified against the host name, the request times out, and
 * at most a few KiB of the answer is read and none of it is kept.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';

import type { DueWebhook, WebhookAttempt } from '@cat-tool/db';
import {
  isPublicAddress,
  signWebhook,
  validateWebhookUrl,
  WEBHOOK_MAX_RESPONSE_BYTES,
  WEBHOOK_TIMEOUT_MS,
} from '@cat-tool/vendor-core/webhook';

/** Every address a host name resolves to, or throws when it does not resolve. */
export type Resolver = (host: string) => Promise<readonly string[]>;

export const resolveAddresses: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Sends one delivery and says what came of it. Never throws. */
export type WebhookSender = (delivery: DueWebhook, now?: Date) => Promise<WebhookAttempt>;

export interface SenderDeps {
  readonly resolve?: Resolver;
  /** Whether an address may be connected to. Only a test replaces it. */
  readonly isPublic?: (address: string) => boolean;
  /** The HTTPS client. Only a test replaces it. */
  readonly request?: typeof httpsRequest;
  readonly timeoutMs?: number;
  /** Extra `ca` certificates to trust. Only a test uses it. */
  readonly ca?: string | Buffer;
}

const fail = (error: string, httpStatus: number | null = null): WebhookAttempt => ({
  ok: false,
  httpStatus,
  error,
});

/**
 * Whether a host name resolves only to public addresses, and which one to dial.
 * Used when an endpoint is registered (so a typo or a private name is refused at
 * once) and again on every attempt (so a name that changed is caught).
 */
export async function vetHost(
  host: string,
  deps: Pick<SenderDeps, 'resolve' | 'isPublic'> = {},
): Promise<
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly error: string }
> {
  const resolve = deps.resolve ?? resolveAddresses;
  const isPublic = deps.isPublic ?? isPublicAddress;
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, error: 'dns' };
  }
  if (addresses.length === 0) return { ok: false, error: 'dns' };
  // One private address among the answers is enough to refuse: the resolver
  // could hand back any of them, and the others are not ours to prefer.
  if (!addresses.every(isPublic)) return { ok: false, error: 'address' };
  return { ok: true, address: addresses[0]! };
}

/** The real sender; tests give it a fake resolver and client. */
export function createWebhookSender(deps: SenderDeps = {}): WebhookSender {
  const request = deps.request ?? httpsRequest;
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  return async (delivery, now = new Date()) => {
    // The URL was checked when it was registered and is checked again: a stored
    // value is not trusted just because it was once valid.
    const checked = validateWebhookUrl(delivery.url);
    if (!checked.ok) return fail('url');
    const vetted = await vetHost(checked.host, deps);
    if (!vetted.ok) return fail(vetted.error);
    const { address } = vetted;
    const family = address.includes(':') ? 6 : 4;
    const body = delivery.body;
    const seconds = Math.floor(now.getTime() / 1000);
    return new Promise<WebhookAttempt>((resolve) => {
      let settled = false;
      const done = (attempt: WebhookAttempt) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(attempt);
      };
      const req = request(
        {
          method: 'POST',
          hostname: checked.host,
          path: `${checked.url.pathname}${checked.url.search}`,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'user-agent': 'Tessera-Webhooks/1',
            'x-tessera-event': delivery.eventType,
            'x-tessera-delivery': JSON.parse(body).id as string,
            'x-tessera-signature': signWebhook(delivery.secret, seconds, body),
          },
          // The address that was checked is the one connected to; the host name
          // still drives the Host header, the TLS server name and the certificate check.
          lookup: (_host, options, callback) => {
            if (options && (options as { all?: boolean }).all) {
              (callback as unknown as (e: null, a: unknown[]) => void)(null, [
                { address, family },
              ]);
            } else {
              callback(null, address, family);
            }
          },
          ...(deps.ca ? { ca: deps.ca } : {}),
          // Never follow a redirect: https.request does not, and nothing here adds it.
        },
        (res) => {
          let read = 0;
          res.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read >= WEBHOOK_MAX_RESPONSE_BYTES) res.destroy();
          });
          const status = res.statusCode ?? 0;
          const finish = () =>
            done(
              status >= 200 && status < 300
                ? { ok: true, httpStatus: status, error: null }
                : fail(status >= 300 && status < 400 ? 'redirect' : 'http', status),
            );
          res.on('end', finish);
          res.on('close', finish);
          res.on('error', finish);
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        done(fail('timeout'));
      }, timeoutMs);
      req.on('error', (err: NodeJS.ErrnoException) => {
        const tls = /certificate|self[- ]signed|hostname|altname/i.test(err.message);
        done(fail(tls ? 'tls' : err.code === 'ECONNREFUSED' ? 'refused' : 'network'));
      });
      req.end(body);
    });
  };
}
