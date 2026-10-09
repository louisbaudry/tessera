import { describe, expect, it } from 'vitest';

import {
  eventForStatus,
  generateWebhookSecret,
  isPublicAddress,
  nextAttemptDelayMs,
  serializeWebhookBody,
  signWebhook,
  validateWebhookUrl,
  verifyWebhookSignature,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_RETRY_DELAYS_MS,
  type WebhookBody,
} from './webhook.js';
import { ASSIGNMENT_STATUSES } from './assignment.js';

const body: WebhookBody = {
  id: 'd-1',
  type: 'assignment.delivered',
  createdAt: '2026-03-02T10:00:00.000Z',
  assignmentId: 7,
  from: 'in_progress',
  to: 'delivered',
  vendorAccountId: 11,
};

describe('events', () => {
  it('has an event for every status an assignment can enter', () => {
    for (const status of ASSIGNMENT_STATUSES) {
      expect(WEBHOOK_EVENT_TYPES).toContain(eventForStatus(status));
    }
  });

  it('serialises the body in one fixed key order, with nothing else in it', () => {
    expect(serializeWebhookBody(body)).toBe(
      '{"id":"d-1","type":"assignment.delivered","createdAt":"2026-03-02T10:00:00.000Z","assignmentId":7,"from":"in_progress","to":"delivered","vendorAccountId":11}',
    );
    const reordered = { ...body, vendorAccountId: 11, id: 'd-1' } as WebhookBody;
    expect(serializeWebhookBody(reordered)).toBe(serializeWebhookBody(body));
    // an extra field a caller passed by mistake is never sent
    const extra = { ...body, projectName: 'acme-brochure' } as WebhookBody;
    expect(serializeWebhookBody(extra)).not.toContain('acme');
  });
});

describe('signing', () => {
  const secret = generateWebhookSecret();
  const text = serializeWebhookBody(body);

  it('makes a 256-bit URL-safe secret, never the same twice', () => {
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(secret);
  });

  it('is verified by the receiver within the window and refused outside it', () => {
    const header = signWebhook(secret, 1_000_000, text);
    expect(header).toMatch(/^t=1000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, text, 1_000_000)).toBe(true);
    expect(verifyWebhookSignature(secret, header, text, 1_000_299)).toBe(true);
    expect(verifyWebhookSignature(secret, header, text, 1_000_301)).toBe(false);
    expect(verifyWebhookSignature(secret, header, text, 999_000)).toBe(false);
  });

  it('is refused for another secret, another body or a changed timestamp', () => {
    const header = signWebhook(secret, 1_000_000, text);
    expect(verifyWebhookSignature(generateWebhookSecret(), header, text, 1_000_000)).toBe(
      false,
    );
    expect(verifyWebhookSignature(secret, header, text + ' ', 1_000_000)).toBe(false);
    const moved = header.replace('t=1000000', 't=1000001');
    expect(verifyWebhookSignature(secret, moved, text, 1_000_001)).toBe(false);
  });

  it('refuses a header that is not in the documented form', () => {
    for (const bad of ['', 'v1=abc', 't=1,v1=zz', `t=1,v1=${'a'.repeat(63)}`]) {
      expect(verifyWebhookSignature(secret, bad, text, 1)).toBe(false);
    }
  });
});

describe('retries', () => {
  it('waits 1 min, 5 min, 30 min, 2 h and 12 h, then gives up', () => {
    expect(WEBHOOK_RETRY_DELAYS_MS).toEqual([
      60_000, 300_000, 1_800_000, 7_200_000, 43_200_000,
    ]);
    expect([1, 2, 3, 4, 5].map(nextAttemptDelayMs)).toEqual([...WEBHOOK_RETRY_DELAYS_MS]);
    expect(nextAttemptDelayMs(6)).toBeNull();
    expect(nextAttemptDelayMs(0)).toBeNull();
  });
});

describe('validateWebhookUrl', () => {
  const ok = (u: string) => validateWebhookUrl(u).ok;

  it('accepts a plain https URL with a path and a query', () => {
    const r = validateWebhookUrl('https://hooks.example.com/in/abc?token=x');
    expect(r).toMatchObject({ ok: true, host: 'hooks.example.com' });
  });

  it.each([
    ['plain http', 'http://hooks.example.com/'],
    ['another scheme', 'ftp://hooks.example.com/'],
    ['user info', 'https://user:pw@hooks.example.com/'],
    ['only a user name', 'https://user@hooks.example.com/'],
    ['a fragment', 'https://hooks.example.com/#x'],
    ['a port', 'https://hooks.example.com:8443/'],
    ['an IPv4 literal', 'https://93.184.216.34/'],
    ['an IPv6 literal', 'https://[2606:2800:220:1::1]/'],
    ['a loopback literal', 'https://127.0.0.1/'],
    ['a decimal IPv4', 'https://2130706433/'],
    ['a hex IPv4', 'https://0x7f000001/'],
    ['an octal-looking IPv4', 'https://0177.0.0.1/'],
    ['a short IPv4', 'https://127.1/'],
    ['localhost', 'https://localhost/'],
    ['a single label', 'https://intranet/'],
    ['a .local name', 'https://printer.local/'],
    ['a .internal name', 'https://api.internal/'],
    ['not a URL', 'hooks.example.com'],
    ['empty', ''],
  ])('refuses %s', (_name, url) => {
    expect(ok(url)).toBe(false);
  });

  it('refuses a URL over the length limit', () => {
    expect(ok('https://hooks.example.com/' + 'a'.repeat(2100))).toBe(false);
  });
});

describe('isPublicAddress', () => {
  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '2606:2800:220:1:248:1893:25c8:1946',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('allows the public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    ['this network', '0.0.0.0'],
    ['this network, other', '0.1.2.3'],
    ['private 10/8', '10.0.0.1'],
    ['private 172.16/12 low', '172.16.0.1'],
    ['private 172.16/12 high', '172.31.255.255'],
    ['private 192.168/16', '192.168.1.1'],
    ['loopback', '127.0.0.1'],
    ['loopback high', '127.255.255.254'],
    ['link-local and cloud metadata', '169.254.169.254'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['carrier-grade NAT high', '100.127.255.255'],
    ['IETF protocol block', '192.0.0.8'],
    ['documentation 192.0.2', '192.0.2.1'],
    ['documentation 198.51.100', '198.51.100.7'],
    ['documentation 203.0.113', '203.0.113.9'],
    ['benchmarking', '198.18.0.1'],
    ['6to4 relay', '192.88.99.1'],
    ['multicast', '224.0.0.1'],
    ['reserved', '240.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['IPv6 unspecified', '::'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unique local', 'fd00::1'],
    ['IPv6 unique local fc', 'fc00::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 link-local with zone', 'fe80::1%eth0'],
    ['IPv6 site-local', 'fec0::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv6 documentation', '2001:db8::1'],
    ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped private (hex form)', '::ffff:c0a8:0101'],
    ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
    ['NAT64 of a private address', '64:ff9b::a00:1'],
    ['6to4 of a loopback', '2002:7f00:1::1'],
    ['6to4 of a private address', '2002:c0a8:101::1'],
    ['compatible address', '::7f00:1'],
    ['not an address', 'example.com'],
    ['empty', ''],
    ['IPv4 with a leading zero octet form', '010.0.0.1x'],
  ])('refuses %s (%s)', (_name, ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});
