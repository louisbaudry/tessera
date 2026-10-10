/**
 * What the owner's Webhooks section says (backlog #125; `vendor-spec.md`, its #125
 * note): how an endpoint's deliveries read, and the few lines a receiver needs to
 * check a signature. Pure, so it is proved in node. What is sent, signed and
 * retried is the server's and `vendor-core`'s; nothing here re-derives it.
 */
import type { WebhookView } from './api.js';

/** The most endpoints an owner may register; the server enforces it, this only sets expectations. */
export const MAX_ENDPOINTS = 3;

/** Shown once beside the new secret: how a receiver verifies what it gets. */
export const SIGNATURE_HELP = [
  'Each request carries X-Tessera-Signature: t=<unix seconds>,v1=<hex>.',
  'v1 is the HMAC-SHA256, keyed with the secret, of "<t>.<raw request body>".',
  'Recompute it, compare in constant time, and refuse a t more than 5 minutes from now.',
  'A delivery can arrive more than once: dedupe on the "id" in the body (also in X-Tessera-Delivery).',
] as const;

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * An endpoint's counts in words, failures first because they are the ones to act
 * on: "2 failed, 1 waiting to retry, 14 delivered", or "Nothing sent yet".
 */
export function deliverySummary(
  w: Pick<WebhookView, 'pending' | 'delivered' | 'failed'>,
): string {
  const parts = [
    ...(w.failed > 0 ? [`${w.failed.toLocaleString()} failed`] : []),
    ...(w.pending > 0 ? [`${w.pending.toLocaleString()} waiting`] : []),
    ...(w.delivered > 0 ? [`${w.delivered.toLocaleString()} delivered`] : []),
  ];
  return parts.length === 0 ? 'Nothing sent yet' : parts.join(', ');
}

/** The receiver's last answer, e.g. "last answer 503", or null when it never answered. */
export function lastAnswer(w: Pick<WebhookView, 'lastStatus'>): string | null {
  return w.lastStatus === null ? null : `last answer ${w.lastStatus}`;
}

/** Whether an endpoint needs the owner's attention: something failed for good. */
export function needsAttention(w: Pick<WebhookView, 'failed'>): boolean {
  return w.failed > 0;
}

/** Why the form cannot be sent yet, or null. The server checks the rest and says why. */
export function urlProblem(url: string, existing: number): string | null {
  if (existing >= MAX_ENDPOINTS) {
    return `You can register ${plural(MAX_ENDPOINTS, 'endpoint', 'endpoints')}: remove one first.`;
  }
  const text = url.trim();
  if (text === '') return 'Enter the address that should receive the events.';
  if (!/^https:\/\//i.test(text)) return 'The address must start with https://';
  return null;
}
