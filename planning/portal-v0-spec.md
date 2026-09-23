# Translation Portal v0 — spec

Status: v0 implementation in progress. This is Ring 2 (`ai-platform-vision.md`
§"Client-facing") pulled forward, deliberately, ahead of Ring 0 finishing —
the CAT tool itself doesn't need to be ready until 2027, but the business
needs a client-facing intake/delivery surface now. Pilot client: one
long-standing direct client.

This document only covers v0. The full Ring 2 design pass (real client
pain points gathered from the pilot client, non-jargon UX) is deferred per
`ai-platform-vision.md` §7.2 — v0 exists to get a pilot running, not to be
the final client-facing design.

## 1. Core principle: decouple the order from the engine

A `translation_order` is a business object: client, files, languages, price,
status. How the translation is actually produced is a separate concern
behind a `ProductionAdapter` interface. v0 ships exactly one implementation,
`ManualProductionAdapter`, which does nothing but let an admin upload
finished files by hand — because the portal exists to let intake and
delivery happen without email, not to require the CAT tool to exist first.
When the CAT tool (Ring 0) is ready, it becomes a second adapter behind the
same interface; nothing about the order model, pricing, or notifications
changes.

```ts
interface ProductionAdapter {
  // v0's ManualProductionAdapter is a no-op: production happens outside
  // the system (Trados/DeepL by hand) and finishes with an admin upload.
  // A future CatToolAdapter would kick off real segmentation/MT here.
}
```

v0 does not need this interface to do anything yet — it exists as a named
seam (`packages/portal-core/src/adapter.ts`) so admin file upload has a
documented home to migrate into, not as a speculative plugin system.

## 2. Order lifecycle

```
submitted -> approved -> in_progress -> delivered
   \-> cancelled          \-> cancelled  \-> cancelled
```

- `submitted`: client created the order, has not yet approved the estimate.
- `approved`: client approved; work can begin (manually, today).
- `in_progress`: admin has started production.
- `delivered`: admin uploaded final files and marked delivered.
- `cancelled`: terminal, reachable from any non-terminal state.

Every transition is recorded as an `order_event` row (append-only status
history) — this is what "order status" in the UI reads from, and it's the
hook a future notification-on-every-transition feature needs without a
schema change.

Legal transitions are enforced in `@cat-tool/portal-core`
(`transitionOrder`), not scattered across route handlers — the same
"one frozen fact, one definition" rule the root `CLAUDE.md` already applies
to `primarySubtag`/`NORMALIZER_VERSION`.

## 3. Pricing

Simple and isolated on purpose (explicitly out of scope for v0: discounts,
retainers, POs, payment integration):

```
lineTotal(pair, wordCount) = max(wordCount * ratePerWord(pair), minimumPrice)
orderTotal = sum(lineTotal) over each requested target language
```

`ratePerWord` is looked up by `(srcLang, tgtLang)` from a configurable
`rate` table (`packages/db` `portal/schema.ts`); no matching row is an
error surfaced to the admin, not a silent zero. `minimumPrice` is
per-rate-row (a language pair can have its own floor), consistent with
"start simple" — one row of config to look at, not a separate global.

Pricing logic lives in `packages/portal-core/src/pricing.ts`, pure
functions, no DB/HTTP — same headless discipline `CLAUDE.md` requires of
`@cat-tool/core`, and for the same reason: provable by a test with nothing
else in the loop.

## 4. Word count

v0 does **not** reuse `@cat-tool/core`'s DOCX segmenter for this — that
pipeline is Ring 0 infrastructure built around TM/QA correctness, not a
quick estimate, and wiring the portal to it now would couple a business
object to engine internals exactly backwards from §1's principle.

Instead: a naive whitespace word count for `.txt` uploads (exact), and for
every other supported type (`.docx`, `.pptx`, `.xlsx`, `.pdf`) the estimate
is left `null` and shown to the client as "estimate pending" — the admin
fills in a word count manually when reviewing the order, which also sets
the authoritative number the price is computed from. This is the
conservative choice: a wrong automated estimate on a real quote is worse
than an honest "pending".

## 5. Notification

`NotificationService` interface (`packages/portal-core/src/notify.ts`) with
one interface, two implementations. `ConsoleNotificationService` (in
`portal-core`, pure/no I/O) logs what would be sent — used when no SMTP
config is present. `SmtpNotificationService`
(`packages/portal-server/src/notification/smtp.ts`, via nodemailer) sends
real email; it lives in `portal-server`, not `portal-core`, because SMTP
is an I/O dependency and `portal-core` stays the same headless, provable-
by-test layer `CLAUDE.md` requires of `@cat-tool/core`. `buildApp` picks
`SmtpNotificationService` automatically when `PORTAL_SMTP_HOST` is set
(config in `portal-server/src/config.ts`: `PORTAL_SMTP_HOST`,
`PORTAL_SMTP_PORT`, `PORTAL_SMTP_SECURE`, `PORTAL_SMTP_USER`,
`PORTAL_SMTP_PASS`, `PORTAL_SMTP_FROM`, `PORTAL_ADMIN_EMAIL` — the last is
required alongside `PORTAL_SMTP_HOST`, since the admin has no address to
notify without it), otherwise falls back to `ConsoleNotificationService`.
Triggers:

- order submitted -> notify admin
- order marked delivered -> notify client

Send failures are logged, never thrown into the request path — a flaky
SMTP provider shouldn't fail the order-submit/deliver API call itself.

## 6. Data model (`packages/db/src/portal/schema.ts`, new `.sqlite` file,
   `PORTAL_APPLICATION_ID`, through the shared migration runner)

- `client` — id, name, email, access_token (unique, bearer for the private
  link), created_at
- `rate` — id, src_lang, tgt_lang, rate_per_word, minimum_price
- `translation_order` — id, client_id, src_lang, notes, status, word_count
  (nullable until admin sets it), price (nullable until word_count is set),
  created_at, updated_at
- `order_target_lang` — order_id, tgt_lang (an order can request more than
  one target language; one row per requested pair)
- `source_file` — id, order_id, filename, content_type, byte_size,
  storage_path, uploaded_at
- `delivered_file` — id, order_id, filename, content_type, byte_size,
  storage_path, uploaded_at
- `order_event` — id, order_id, from_status (nullable, null for the
  creation event), to_status, note, created_at

Files are stored on local disk under a configurable storage root
(mirrors the existing `account.storage_root` pattern in
`platform/schema.ts`), source and delivered files in separate
subdirectories, metadata only in SQLite — same "never re-derive, one
definition" discipline as the rest of the schema.

**The on-disk name is minted by the server, never taken from the
upload** (`mintStoredName`, `packages/portal-server/src/storage.ts`):
`orders/<order id>/source/<uuid>` and `orders/<order id>/delivered/<uuid>`.
v0 first stored files under the client's own filename, which is the
pattern the CAT server's storage rule forbids ("no function takes a path
from a request", `CLAUDE.md`) — the fix is not to sanitise the name but
to never build a path from it. The uploaded name survives only as
`filename` (its last path segment, `displayFilename`), for display and
for the download's `Content-Disposition`; `storage_path` never leaves
the server (the API strips it from every file it returns).

**Downloads are the delivery** (2026-09-22): a client fetches each
delivered file of their own order from
`GET /api/client/orders/:id/delivered-files/:fileId`; an admin fetches
an order's uploads and deliveries from
`GET /api/admin/orders/:id/source-files/:fileId` and
`.../delivered-files/:fileId`. Every lookup is scoped to the order in
the URL (`getSourceFile`/`getDeliveredFile` in `db/portal/files.ts` take
both ids), so a file id from another order is a 404, the same answer as
an order the caller may not see. A file whose bytes are gone from the
volume is a 500, not a 404 — the metadata says it exists, so its absence
is the server's inconsistency to report, not the client's mistake. The
bearer token can't ride on a plain link, so both screens download with
a `fetch` and hand the browser a blob.

## 7. Auth

- **Client**: a private link containing `client.access_token` as a bearer
  token. No password, no registration flow — this is one pilot client. Good
  enough for v0; a real login system is future work, not blocking the pilot.
- **Admin** (upgraded from v0's single shared-secret env var): a real
  account — `admin_user` (email, salted/hashed password) and
  `admin_session` (a random bearer token, stored only as its SHA-256
  hash, with an expiry) in `packages/db/src/portal/schema.ts`, migration
  v2. `POST /api/admin/login` (email + password) returns a session token;
  every other `/api/admin/*` route requires it as `Authorization: Bearer
  <token>`; `POST /api/admin/logout` revokes it. Password hashing
  (`scryptSync`, a random salt per password) and session-token
  generation/hashing are pure functions (`node:crypto` only, no DB/HTTP)
  — same headless discipline as the rest of `portal-core`. They began in
  `@cat-tool/portal-core/src/auth.ts` and moved to
  `@cat-tool/core/src/auth/credentials.ts` when the CAT server's accounts
  (`v1-spec.md` §2.5, backlog #27) needed the same four functions;
  `portal-core/src/auth.ts` re-exports them, one definition for both
  products. The DB repository (`packages/db/src/portal/admin.ts`) is what
  actually stores and looks them up. There is still exactly one admin account in practice (created
  via `pnpm --filter @cat-tool/portal-server run create-admin -- <email>
  <password>`, a one-off script, not an HTTP endpoint — self-service
  admin signup isn't a v0 need with one admin), but it's a real account
  now, not a env-var secret shared with every deploy config.
  `PORTAL_ADMIN_TOKEN` is gone.

## 8. What's manual in v0 / where the CAT tool plugs in later

Manual today: actual translation production (Trados/DeepL by hand), word
count for every format except `.txt`, deciding when to move an order to
`in_progress`. Moving the files themselves is not: since 2026-09-22 the
admin downloads the client's uploads and the client downloads the
delivered translation from the portal (§6), which is what §1 said the
portal was for. Notification delivery now has a real channel
(`SmtpNotificationService`, §5) — configuring `PORTAL_SMTP_HOST` is all a
deployment needs to stop relying on console logs.

Future CAT integration point: a `CatToolProductionAdapter` implementing
`ProductionAdapter`, and a word-count service that calls
`@cat-tool/core`'s `assembleFile`/segmenter instead of the naive estimator
above — both are additive, neither requires touching `translation_order`,
pricing, or the status machine.
