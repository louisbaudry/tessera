# Solo-translator mode — spec

Issue #179. Louis's decision (2026-11-04): **individual translators are a customer
segment**. For this card, that means a spec plus a first slice that needs no tax
decision. Invoicing waits for Epic 13 (`e-invoicing-spec.md` §10). The stack
question was asked before the first line of code, and the answer is TypeScript,
for the reasons in §5.

## 1. Who this is for

A **solo translator** is one person who is both the business and the translator.
They take work from their own direct clients, do it themselves, and get paid for
it. No vendor sits between them and the client, and no project manager either.

The competitor sweep (`competitive-research.md`, #179) found one
translation-specific tool for this person. It is a desktop product with no public
price. Everyone else makes do with a generic invoice builder and a spreadsheet of
deadlines.

## 2. Decisions

**D1. A solo translator is a tenant with one admin, not a new kind of account.**
The tenant model (`tenant-spec.md`) already fits:

- one tenant, founded by its first admin (`create-tenant`);
- that admin translates their own projects in the CAT tool, with no grant and no
  roster;
- their direct clients use the tenant's portal (`portal-v0-spec.md` §9a).

Nothing in the schema says "solo". A tenant with one admin and an empty roster is
one, and it becomes an agency the day it invites a vendor, with no migration. A
`solo` flag would be a second fact that disagrees with the roster the day a vendor
joins, so there is none.

**D2. The rate card per client is the client's own rate** (`portal-v0-spec.md`
§3a, issue #331). It was built for agencies, and it is exactly what a solo
translator negotiates with each direct client. Nothing new is needed.

**D3. A quote is a printable page made from an order that has a price, never a
second price.** A quote:

- is an HTML document the admin opens from the order and prints or saves as PDF
  from the browser;
- names the portal (its display name, §9a), the client, the order, the languages
  and words, and the total in the portal's currency (§9c);
- shows **the order's stored price as its total, always**.

The line breakdown (rate, billed words, price per target language) comes from
`estimateOrder` over the client's rates (§3a, §4b). It is shown only when its lines
add up to the stored price. If the admin set a different price, or a rate changed
since pricing, the quote shows one line for the whole order instead.

So a quote can never show a total other than the one the client is asked to
approve. Approval checks that price (§3), and a quote that disagreed with it would
be a document the business cannot stand behind.

**Why HTML and not a PDF library:** the browser's print-to-PDF already makes the
file. A PDF library would be a new production dependency, which means a licence to
read and record (`prior-art.md`) and fonts to embed for every script a translator
works in. The browser already has all of those. Moving to server-side PDF later
changes the output, not the data.

**What a quote is not:**

- **Not an invoice.** It carries no invoice number, no seller tax identity, no VAT
  and no payment terms. It says so on its face. Those belong to a `seller_profile`
  and to the country an invoice is issued from (`e-invoicing-spec.md` §10.3, §10.4).
- **Not logged.** Opening it writes no event, because it reads only what
  `order.priced` already recorded.

**D4. A deadline is the translator's own date on an order: an admin field, never
shown to the client.**

- An order gets an optional `due_at` (a calendar date, `YYYY-MM-DD`), set and
  cleared by the admin. Setting or clearing it is logged in the portal's
  `audit_event` as `order.due_set`, with the date and nothing else.
- It is not a promise to the client. A delivery date the client asks for or
  is promised, with rush tiers and what a late delivery costs, is #160, and it
  needs its own decisions.
- Keeping the field off every client route means #160 can later decide what the
  client sees, without having to take back a date that clients have already read.

**D5. The deadline view lists open orders by due date.** "Open" means not
`delivered` and not `cancelled`. Each order is in one of three groups: overdue
(due before today), due today, and later. Orders with no date come last, so one is
never forgotten because nobody set its date.

"Today" is the admin's local date, which the page sends. It is never the server's
UTC date: a translator in Asia would otherwise see a deadline turn overdue in the
middle of their afternoon.

The grouping is a pure function in `portal-core` (`deadlineAgenda`). A calendar
grid view, and an export to a calendar app (iCalendar), are later, and both would
read that same function.

## 3. What the first slice builds

| Piece                     | Where                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| `quoteFor` (D3)           | `portal-core/src/quote.ts`, pure, tested                               |
| `renderQuoteHtml`         | `portal-server/src/quote-page.ts`, escaped, tested                     |
| `GET` quote route         | `/api/admin/orders/:id/quote`, admin only; 404 without a price         |
| `due_at`, `order.due_set` | portal schema v13 (`rebuildTable` widens `audit_event`)                |
| `setOrderDue`             | `db/portal/orders.ts`, logs in the same transaction                    |
| `PUT` due-date route      | `/api/admin/orders/:id/due`, admin only                                |
| `deadlineAgenda` (D5)     | `portal-core/src/deadlines.ts`, pure, tested                           |
| `GET` deadline route      | `/api/admin/deadlines?today=YYYY-MM-DD`                                |
| Admin page                | quote button, due date field on an order, Deadlines section            |

`clientOrder` keeps `dueAt` off every client route, and a test fails if it comes
back.

## 4. Later, and what each one waits for

- **Invoice from a delivered order**: Epic 13. It waits for the country the
  business invoices from and for a seller profile per tenant
  (`e-invoicing-spec.md` §10.3, §10.4). Payment terms and pay-after-delivery are
  #178. A solo translator is the case for "several sellers" there, since each
  solo tenant is a seller of its own.
- **Payable statement and self-billing** (#158): this is for vendors, so it does
  not reach a solo translator, who has no vendor.
- **Multi-currency per client**: the portal has one currency, settled once
  (§9c). A client billed in another currency would need a currency per client,
  and moving an approved price between currencies is refused today for good
  reason.
- **A free quote with no order** (a price calculator): #159.
- **Deadlines from the CAT tool's projects.** A solo translator's work is a portal
  order and a CAT project, and the two are not linked yet. The deadline view reads
  orders only. Assignment deadlines (`vendor-spec.md`) belong to vendors.

## 5. Stack (asked 2026-11-04)

TypeScript. Louis chose it over a Rust/Wasm PDF kernel and over a Wasm
component. Nothing here has a measured cost:

- a quote is a few multiplications;
- the deadline view is one indexed query over a tenant's open orders;
- PDF rendering is left to the browser (D3).
