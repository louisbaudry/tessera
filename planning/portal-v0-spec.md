# Translation Portal v0 — spec

This is Ring 2 (`ai-platform-vision.md`
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
schema change. Since schema v3 (backlog #58) each row names its actor,
`client:<id>` or `admin:<id>`, and triggers enforce the append-only
rule. Logins, deliveries and downloads go to `audit_event`
(`audit-spec.md` §2.6).

Legal transitions are enforced in `@cat-tool/portal-core`
(`assertValidTransition`), not scattered across route handlers — the same
"one frozen fact, one definition" rule the root `CLAUDE.md` already applies
to `primarySubtag`/`NORMALIZER_VERSION`.

**Approval needs a price, and the price the client saw** (backlog
`#63`). `submitted → approved` is refused while the order has no price,
whoever asks: the client's approve route and the admin's `PATCH` alike.
That check sits beside the transition table in `portal-core`
(`assertCanApprove`), and `setStatus` runs it, so no route can skip it.
The client's approve request also carries the price its page showed.
If the admin re-priced the order after the page loaded, the numbers
differ, and the server answers 409 instead of recording an approval of
a price the client never saw. The client reloads and sees the new one.

## 3. Pricing

Simple and isolated on purpose (explicitly out of scope for v0: discounts,
retainers (a client plan is designed in §10, not built), POs, payment
integration):

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

**Setting a price is audited and bounded** (backlog `#63`, decided
2026-09-28):

- **Who and what.** `setWordCountAndPrice` takes the admin as a
  required actor and writes `order.priced` (`audit-spec.md` §2.6) in the
  same transaction. Pricing again with the same count and price
  changes nothing, so it writes nothing.
- **Only while `submitted`.** Once the client has approved, the price
  they approved is the price, so re-pricing an order in any later status
  is a 409. The rule lives in `portal-core` (`assertCanPrice`) beside the
  transition table.
- **One exception: an order approved with no price.** Before `#63`, the
  admin `PATCH` could approve an unpriced order. Such an order, if
  `approved` or `in_progress`, may be priced **once**, so it can still be
  invoiced; after that it is priced and the rule above applies. No such
  approval can happen any more.
- **Prices set before `#63`** have no author on record. Portal schema v4
  writes one `order.price_baseline` per priced order, actor
  `system:migration`: what the price was when recording began, the way
  `segment.baseline` records a segment (`audit-spec.md` §6).

## 4. Word count

**The count is advice, computed by `@cat-tool/core` (backlog `#62`,
decided 2026-09-27).** A `.docx` or `.txt` upload is counted at submit
and the figure stored on its `source_file` row (§6). The admin's screen
pre-fills the order's total from those figures, and the admin's
confirmation of a total is what sets `translation_order.word_count` and,
through §3, the price. The client sees "estimate pending" until then,
`.txt` included: the count is never shown to them, and their API never
carries it. The conservative principle stands: a wrong automated figure
on a real quote is worse than an honest "pending", so a machine's number
is something a person signs off, not something a client is quoted.

What counts as a word is defined once, in `core`
(`v1-spec.md` §3.6, `model/words.ts`), and shared with the editor's
progress and vendor pay: `portal-core`'s `countWords` is a re-export of
it, not a third splitter.

How a file is counted (`portal-core`'s `estimateWordCount`, over
`core`'s `countDocxWords` / `countTextWords`, both in `project/`):

- **The format is read from the name and the bytes, never from the
  declared content type.** `.docx` must also start with the ZIP magic;
  `.txt` is decoded as UTF-8 with `{ ignoreBOM: true, fatal: true }`. A
  client-supplied `Content-Type` is a claim, and a wrong one must not
  choose the parser.
- **`.pptx`, `.xlsx`, `.pdf` and anything else are `null`**: `core` has
  no filter for them, so there is no honest number.
- **`null`, never a wrong number**, also for: a source language that
  does not space its words (`v1-spec.md` §3.6); a DOCX that will not
  parse (not a ZIP, no `word/document.xml`, malformed XML, a numeric
  entity past U+10FFFF); a package whose translatable parts inflate past
  32 MiB; and `.txt` that is not valid UTF-8 or holds a NUL or other C0
  control (BOM-less UTF-16 of ASCII text is valid UTF-8 full of NULs, so
  the decoder alone would not reject it).
- **A DOCX is counted without the segmenter.** It goes
  `extractSkeleton` → `tokenizeRegion` → `countRegionWords` over the
  translatable parts only, which is `importDocx`'s path minus reading the
  media and fonts. `assembleFile`, which §8 first named, is the wrong
  tool: sentence splitting moves no word, `rulesFor` throws on a source
  language with no segmentation rules (an order may name any), and
  hashing every segment is cost for nothing. The parts are unzipped with a
  filter, so an upload that is mostly images costs its XML only, and the
  cap is enforced on the declared size before anything inflates
  (`fflate` writes no more than the declared size, so a lying header
  gives a truncated part and, in practice, a parse error and `null`).
- **Counting never fails an order.** It runs before the order is
  created, on the buffers already in memory, so a count that goes wrong
  cannot leave a committed order behind a 500; any error is `null` and a
  log line. It is synchronous on the request thread (timings in the
  backlog record).

## 4a. Update orders: a new version, quoted on what changed (backlog #131, 2026-10-11)

A client with a **delivered** order may send version 2 of its files as a new
order that names it (`updateOf`, a field of the multipart `POST
/api/client/orders`, and a select in the client's form that appears once a
request is delivered). The order carries `previous_order_id`; its creation
`order_event` says so. Nothing else about the lifecycle changes.

- **Who may be updated.** The same client's, `delivered`, in the same source
  language by primary subtag (`assertCanUpdate`, `portal-core`). Anything else
  is a 400 with one message for a missing order, another client's and a
  non-number, so the field cannot be used to ask which order numbers exist.
- **What is compared.** Each upload is matched, by name and ignoring case, to a
  source file of the order it updates (`matchEarlierFile`). A DOCX against a DOCX
  is compared sentence by sentence (`core`'s `countChangedDocxWords`): a sentence
  is unchanged when its normalised hash (`tm-format-spec.md` §4) is among the
  earlier file's, wherever it moved to. The words in the rest are
  `source_file.changed_word_count`, with the matched file in
  `compared_to_file_id`. A name with no earlier file is a new file, all of it
  changed. A file that cannot be compared (`.txt`, a bad DOCX, an unspaced
  language) has `NULL`, and counts at its whole word count in the total.
- **Advice, like §4.** The admin's pre-filled total for an update order is the
  sum of those figures, and the screen says it is an estimate that reads a
  reflowed paragraph, or a formatting-only change, as changed (tags are part of
  the hash). Only the admin's confirmation sets `word_count` and so the price;
  neither figure is on a client route.
- **Not built:** leverage from the client's own memory (§9; issue #159's
  TM-aware quote will take this figure as input), a fuzzy tier for a sentence
  one word off, `.txt`/`.pptx`/`.xlsx` comparison.

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
  (nullable until admin sets it: the admin-confirmed figure the price
  comes from, never a file's advisory count), price (nullable until
  word_count is set), previous_order_id (v7; nullable, the delivered order
  this one is a new version of, §4a), created_at, updated_at
- `order_target_lang` — order_id, tgt_lang (an order can request more than
  one target language; one row per requested pair)
- `source_file` — id, order_id, filename, content_type, byte_size,
  storage_path, uploaded_at, word_count (v5; nullable, **advisory**: §4.
  `NULL` is "not counted". It prices nothing and no client route
  returns it), compared_to_file_id and changed_word_count (v7; update
  orders only, §4a: the earlier file compared with and the words in new or
  changed sentences, advisory and never on a client route)
- `delivered_file` — id, order_id, filename, content_type, byte_size,
  storage_path, uploaded_at
- `order_event` — id, order_id, from_status (nullable, null for the
  creation event), to_status, note, created_at, actor, actor_label
  (v3; append-only by trigger)
- `audit_event` — the shared audit log (v3, `audit-spec.md` §2, §2.6);
  v4 admits `order.priced` and `order.price_baseline` (backlog `#63`); v6
  admits `resource.linked`, `resource.unlinked` and `resource.exported`
  (backlog `#127`)
- `client_resource` — id, client_id, kind (`tm` or `glossary`), path (the
  operator's absolute path, never sent to a client), name, linked_at; unique
  per (client_id, kind) (v6, backlog `#127`, §9). Paths, not translation
  content: the files stay where their owner keeps them.

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

Manual today: actual translation production (Trados/DeepL by hand),
**confirming** the word count (the count itself is automatic for `.docx`
and `.txt`, but advisory: the admin checks the pre-filled total and
confirms it, and only that sets the price, §4; for `.pptx`, `.xlsx`,
`.pdf` and an unspaced source language there is no figure and the admin
counts by hand), deciding when to move an order to `in_progress`. Moving the files themselves is not: since 2026-09-22 the
admin downloads the client's uploads and the client downloads the
delivered translation from the portal (§6), which is what §1 said the
portal was for. Notification delivery now has a real channel
(`SmtpNotificationService`, §5) — configuring `PORTAL_SMTP_HOST` is all a
deployment needs to stop relying on console logs.

Future CAT integration point: a `CatToolProductionAdapter` implementing
`ProductionAdapter`. It is additive; it does not require touching
`translation_order`, pricing, or the status machine. The word count no
longer waits on the CAT tool: it already runs on `@cat-tool/core`, by the
lighter path §4 describes and not through `assembleFile`/the segmenter.
What a CAT project would add is a count of the *segmented* file (matches
and repetitions), which is a different number from this one and belongs
to analysis and pay (`#49`), not to the quote.

## 9. A client's own memory and glossary (backlog #127, 2026-10-10)

A client's translation memory and glossary are theirs: they can download
them whenever they like, as TMX and CSV, from their page. Decided
2026-10-10 (Louis chose the dedicated-file model over a filter):

- **A link names a whole file.** `client_resource (client_id, kind, path,
  name)`, one `.ctm` and one `.ctg` per client at most, set by the operator
  with `pnpm --filter @cat-tool/portal-server run link-client-resource --
  link <client-id> tm|glossary <absolute-path>` (also `unlink`, `list`).
  Never an HTTP endpoint: the path is typed by the person who owns the
  file. The operator links only a file that is that client's alone, since a
  client takes all of it; a base memory shared with other clients is never
  linked. A client sees a name and a download name, never the path.
- **Read, not opened.** The file belongs to the CAT server's owner. The
  portal reads it through `openReadOnly` (`query_only`, no migration, no
  backup, no integrity check) and only at the newest format version.
- **What leaves.** The memory's text, languages, dates, quality and unit
  identity; not who created or changed a unit, notes, neighbour hashes, usage
  counts or properties outside `client`/`domain`/`subject`/`register`. The
  glossary's live renderings with `preferred`/`allowed`/`forbidden`; not
  notes, authors or the decision log.
- **Routes.** `GET /api/client/resources` (kind, name, download name) and
  `GET /api/client/resources/:kind/export`, scoped by the client's token and
  the kind alone: another client's link, a kind never linked and an unknown
  kind are one identical 404; an unreadable file is a 503 and a memory above
  100,000 units a 413. Each download is logged as `resource.exported` before
  the first byte goes out.

## 10. A client plan: a monthly word allowance (idea #220, designed, not built)

Decided 2026-10-11 (Louis): this feature is written down now and built when
the time comes. It is generic on purpose. Nothing in it names a client, and the
terms of any particular agreement (rate, allowance, term, rollover) are set by
the operator per client, never shipped as defaults.

**What.** An operator can give a portal client a *plan*: an allowance of words
per month at a stated per-word rate, for a term, with unused words carried over
for a stated number of months. An approved order draws its confirmed word count
from the allowance. The client's page shows the plan and the balance. The portal
charges nothing: the monthly fee is invoiced outside it (§3 and idea `#178`
keep payment out of scope), and the portal only says what was drawn.

**Why it is a separate design.** §3 prices one order at a time:
`max(wordCount * ratePerWord, minimumPrice)`. A plan is a fact about *several*
orders over time, and the lifecycle in §2 links no two orders. The new thing is
the balance, so most of the design is about keeping the balance honest.

### Rules

- **A draw is a row, never an edit.** `plan_draw` (append-only by trigger, actor
  required, the same shape as `order_event` and `assignment_payable`) records
  `(plan_id, order_id, words, kind, month, created_at, actor)` with `kind` one of
  `draw` or `release`. The balance is **derived** from the plan and its rows when
  read and never stored, so it cannot disagree with the history that produced it.
  A cancelled order writes a `release` row that reverses its draw; nothing is
  deleted or updated.
- **A draw is frozen when the client approves.** It is written in the transaction
  of the approval, from the order's confirmed word count. Recomputing coverage
  later from a changing set of orders would change what an earlier approval
  covered after the client agreed to it. This is the §2 rule again: approval is
  consent to the figure that was shown, so the figure is fixed at that moment.
- **The price shown to the client does not change meaning.** `translation_order`
  still carries a price and `assertCanApprove` still compares it with what the
  client's page showed. A plan adds a second, derived statement beside it ("covered
  by your plan: N words, M remaining") and changes neither the price nor the
  transition table.
- **Carry-over is first in, first out.** A month's unused words stay usable for
  the plan's carry-over months and then expire. A draw takes from the oldest
  usable month first. Both rules are pure functions in `portal-core`
  (`planBalance(plan, draws, at)`), provable with no database, like `pricing.ts`.
- **Words beyond the allowance** are priced at the plan's rate unless the plan
  names an overage rate. The balance never goes negative: the part of an order
  that exceeds it is the order's overage, stated, not hidden.
- **A plan ends, it is not edited.** Changing terms means ending the plan and
  creating a new one, so a past month is always read under the terms that held
  in it. Renewal is a new plan row. Notice periods and exit terms are contractual
  and are not enforced by the software.
- **Operator-written only.** Plans are created and ended through admin routes.
  No client route can write one, and another client's plan is the same 404 as a
  plan that does not exist.
- **Audited.** `plan.created`, `plan.ended`, `plan.draw` and `plan.release` are
  new `audit_event` actions. Each is a migration that widens the `CHECK` with
  `rebuildTable` as a literal, never an import of a live list (the snapshot
  invariant in `CLAUDE.md`), and `db/check-lists.test.ts` must pass.
- **One currency per plan, never converted**, as in the vendor ledger. A monthly
  statement (orders, words drawn, balance) can be exported as CSV through the
  shared cell guard in `core/model/csv.ts`, and logs a `resource.exported`-style
  event with a count and a digest.

### Open questions (settle before building)

- **Several target languages.** Does an order with two target languages draw its
  word count once or twice? Proposal: once per target language it covers, since
  the work is done per language, and the plan names the pairs it covers.
- **Month boundaries.** Calendar months in UTC, or months counted from the plan's
  start date? Proposal: from the start date, so a term is always whole months.
- **Money type.** The portal's `rate` table stores `REAL`; the vendor ledger
  stores integer micros. A plan should store integer micros, which means pricing
  a plan order needs a conversion at one named place.
- **The per-file minimum** (`#222`): a file under the minimum counts as the
  minimum number of words against the allowance. That needs a confirmed count
  per file, which §4 does not have today.
- **Rush** (`#160`): is a rush surcharge a charge on top, or extra words drawn?
- **Orders created by an admin** (`#221`): the draw is written at approval, so
  the actor on the draw is whoever recorded that approval.

### Tests it will need (test first, per `CODING.md`)

- The balance equals allowance minus draws plus releases, for any order of rows.
- Cancelling an approved order restores its words exactly once (idempotent).
- Words expire after the carry-over window and a draw takes the oldest first.
- Approving the same order twice writes one draw.
- A client cannot read or write another client's plan, and cannot write its own.
- The price a client approves is unchanged by the plan.
- Appending to `plan_draw` works; updating or deleting a row aborts.

### Related

`#160` (delivery date and rush), `#178` (invoicing and payment), `#221` (an admin
enters an order for a client), `#222` (minimum price per file), `#159` (a quote
that reflects the client's own memory), `#163` (update orders quoted on what
changed), `#179` (solo-translator mode).
