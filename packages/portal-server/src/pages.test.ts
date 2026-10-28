/**
 * The portal's two page scripts print server data into `innerHTML`, so any text a person can type
 * must reach the page as text, never as markup (issue #323). The admin page shows what a client
 * typed (language fields and notes are free text at `POST /api/client/orders`), and the admin's
 * session token sits in that page's `sessionStorage`, so one unescaped field there is a way into
 * the admin session.
 *
 * Each script is run as shipped, in a `vm` context with a stub browser: elements record every
 * `innerHTML` they are given, `fetch` answers canned JSON. No DOM library, because only the HTML
 * string that is built matters here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

/** Markup that would run if it reached a page; the name says which field carried it. */
const PWN = (field: string) => `<i data-pwn="${field}">x</i>`;

type Canned = Record<string, { status?: number; json: unknown }>;

/** Loads `file` as a browser would and returns every HTML string it assigned, plus its context. */
async function loadPage(
  file: 'admin.js' | 'client.js',
  canned: Canned,
  storage: Record<string, string>,
): Promise<{
  renders: string[];
  context: Record<string, (...args: unknown[]) => unknown>;
}> {
  const renders: string[] = [];
  const element = (): unknown => {
    const own: Record<string | symbol, unknown> = {};
    const stub: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        if (prop in own) return own[prop];
        if (prop === 'querySelectorAll') return () => [];
        if (prop === 'dataset') return {};
        if (prop === 'options') return [];
        return () => element();
      },
      set(_t, prop, value) {
        own[prop] = value;
        if (prop === 'innerHTML') renders.push(String(value));
        return true;
      },
      apply: () => element(),
    });
    return stub;
  };
  const app = element();
  const store = (init: Record<string, string>) => ({
    getItem: (k: string) => init[k] ?? null,
    setItem: (k: string, v: string) => void (init[k] = v),
    removeItem: (k: string) => void delete init[k],
  });
  const sandbox = {
    document: { getElementById: () => app, createElement: () => element() },
    sessionStorage: store({ ...storage }),
    localStorage: store({ ...storage }),
    location: { hash: '' },
    Option: class {},
    console,
    fetch: async (path: string) => {
      const hit = canned[path.split('?')[0]!];
      const status = hit?.status ?? (hit ? 200 : 404);
      return { ok: status < 400, status, json: async () => hit?.json ?? {} };
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(publicDir, file), 'utf8'), context);
  // the script starts rendering on load; let its awaits settle
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return { renders, context: context as never };
}

const order = {
  id: 1,
  clientId: 7,
  srcLang: PWN('src'),
  tgtLangs: [PWN('tgt')],
  status: 'submitted',
  notes: PWN('notes'),
  wordCount: null,
  price: null,
  previousOrderId: null,
};
const detail = {
  order,
  sourceFiles: [
    { id: 1, filename: PWN('file'), contentType: 'x', byteSize: 1, wordCount: null },
  ],
  deliveredFiles: [],
  suggestedWordCount: null,
  needsFileWordCounts: false,
  suggestedFileWordCounts: [],
  events: [
    {
      createdAt: '2026-01-01T00:00:00Z',
      fromStatus: null,
      toStatus: 'submitted',
      note: PWN('event'),
    },
  ],
};

/** No page may hold a live copy of a payload, and the text must still be shown, escaped. */
function expectOnlyText(renders: string[], fields: readonly string[]): void {
  const all = renders.join('\n');
  for (const field of fields) {
    expect(all, `${field} reached a page as markup`).not.toContain(
      `<i data-pwn="${field}"`,
    );
    expect(all, `${field} was never rendered: the test did not reach it`).toContain(
      `&lt;i data-pwn=&quot;${field}&quot;`,
    );
  }
}

describe('the admin page', () => {
  it('shows what a client typed as text, in the order list and in an order', async () => {
    const { renders, context } = await loadPage(
      'admin.js',
      {
        '/api/admin/orders': { json: [order] },
        '/api/admin/orders/1': { json: detail },
      },
      { portal_admin_token: 't' },
    );
    await (context.renderOrderDetail as (id: number) => Promise<void>)(1);
    expectOnlyText(renders, ['src', 'tgt', 'notes', 'event', 'file']);
  });

  it('shows an error message as text', async () => {
    const { renders } = await loadPage(
      'admin.js',
      { '/api/admin/orders': { status: 500, json: { error: PWN('err') } } },
      { portal_admin_token: 't' },
    );
    expectOnlyText(renders, ['err']);
  });
});

describe('the client page', () => {
  const canned: Canned = {
    '/api/client/me': { json: { id: 7, name: PWN('name') } },
    '/api/client/orders': { json: [order] },
    '/api/client/rates': { json: [{ srcLang: 'en', tgtLang: 'es', ratePerWord: 0.1 }] },
    '/api/client/resources': { json: [] },
    '/api/client/orders/1': { json: detail },
  };

  it('shows names and the request list as text', async () => {
    const { renders } = await loadPage('client.js', canned, { portal_client_token: 't' });
    expectOnlyText(renders, ['name', 'src', 'tgt']);
  });

  it('shows a request, its notes and its history as text', async () => {
    const { renders, context } = await loadPage('client.js', canned, {
      portal_client_token: 't',
    });
    await (context.renderOrderDetail as (id: number) => Promise<void>)(1);
    expectOnlyText(renders, ['src', 'tgt', 'notes', 'event', 'file']);
  });

  it('shows an error message as text', async () => {
    const { renders } = await loadPage(
      'client.js',
      { '/api/client/me': { status: 500, json: { error: PWN('err') } } },
      { portal_client_token: 't' },
    );
    expectOnlyText(renders, ['err']);
  });
});
