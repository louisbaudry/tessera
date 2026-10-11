# E-invoicing — spec (draft)

Status: **draft, nothing built.** Written 2026-10-11 from Louis's request:
Tessera should produce electronic invoices compatible with European
regulations, or at least send them to approved European e-invoicing
platforms. Placed in **Ring 1** (the vendor side: receiving invoices) and
**Ring 2** (the client side: issuing them), see §1. Reasoning is kept on the
record, not just the conclusions. Decisions that are Louis's to make are in
§10 with a recommendation each. **§10.1 was settled on 2026-10-11: Tessera
issues the invoice numbers.** The other decisions are still open, and §4 is a
proposal until they are settled.

**This is not legal or tax advice.** Invoice content, VAT treatment,
numbering and retention are set by law per country and change. Every
regulatory fact in §2 was read from secondary sources on 2026-10-11 and is
to be re-verified against the official source (and the owner's accountant)
before anything is built on it.

## 0. What is being asked, in one paragraph

A delivered portal order becomes a legal invoice: structured data in the
European standard (EN 16931), serialised as XML, validated, numbered,
frozen, and handed to an approved platform that delivers it to the buyer.
In the other direction, a vendor's e-invoice arrives, is read into the same
model, and is matched to the payable Tessera already locked at delivery.
Tessera does **not** become the approved platform (§4, D1).

## 1. Where it sits in the rings

`ai-platform-vision.md` puts invoicing in Ring 3 with a provisional lean:
_integrate with Zoho Books, don't rebuild accounting software._ That lean
stands for the **ledger**: bookkeeping, VAT returns, bank reconciliation and
payments stay in a tool built for them. What this spec pulls forward is
narrower, and it is a different problem, a legal _document_ rather than
accounting:

| Half                                      | Ring | Why it belongs there                                                                                                                                                     |
| ----------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Issuing** a client invoice from an order | 2    | The portal owns the order, its confirmed word count, its approved price and its `delivered` state (`portal-v0-spec.md` §2–§3). The invoice is what the delivery bills.   |
| **Receiving** a vendor invoice, matching it to a payable | 1 | The `.ctv` owns the locked payable and its payment events (`vendor-spec.md`, #49/#51b/#112). A vendor's invoice is the document that payable is meant to be settled by. |
| Ledger, VAT return, payments, bank feed   | 3    | Unchanged: integrate, don't rebuild. Payment is stop-and-ask territory (`#178`).                                                                                         |

Related cards, which this spec narrows rather than replaces: `#158` (vendor
statement, then self-billing and e-invoice export; its "later" is §6 here),
`#178` (pay-after-delivery terms; its "an invoice generated at delivery" is
§5 here, its payment half stays out), `#179` (solo-translator mode, which
needs an invoice and is not decided, §10.4), `#153` (the payables ledger,
built). The epic is **Epic 13** in `v1-backlog.md`.

## 2. The regulatory landscape (as of 2026-10-11, to be re-verified)

Recorded so the design is checked against something, and so the next
session sees what was believed and where it came from. **Dates are data,
not code** (D8): no date or threshold below belongs in a source file.

| Layer         | What                                                                                                                                                                                                  | Confidence                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| EU standard   | **EN 16931**: a semantic model of an invoice with two permitted syntaxes, **UBL 2.1** and **UN/CEFACT CII**. Born of Directive 2014/55/EU (public procurement), now the base of every EU mandate.   | High (background knowledge)                                                 |
| EU, 2030      | **ViDA** adopted by the Council on 2025-03-11. E-invoicing on EN 16931 becomes mandatory for **intra-EU B2B from 2030-07-01**, with near-real-time reporting of the data; states with older systems have until 2035-01-01. | Medium (consultancy summaries; EUR-Lex text not read)                       |
| Peppol        | A four-corner network: the seller's **access point** sends to the buyer's access point, found through a directory lookup. **Peppol BIS Billing 3.0** is a UBL profile of EN 16931 used across the EU. | High (background knowledge)                                                 |
| France        | Reception for every company and issuing for large and mid-size ones from **2026-09-01**, SMEs and micro-businesses from **2027-09-01**, through a state-approved platform (_plateforme agréée_, formerly _PDP_). Formats UBL, CII, **Factur-X**. | Medium. A source says both dates may be moved by decree; not confirmed whether the 2026 start held. |
| Germany       | Receiving structured invoices since **2025-01-01**; issuing from **2027-01-01** above EUR 800,000 turnover, from **2028-01-01** for all. Domestic B2B only. **XRechnung** and **ZUGFeRD** (an EN 16931 profile). | Medium                                                                      |
| Belgium       | Domestic B2B e-invoicing on Peppol from **2026-01-01**. A reporting step for 2028 is a draft, unconfirmed.                                                                                           | Medium                                                                      |
| Poland        | **KSeF**, a national platform and a national XML schema (not EN 16931), from **2026-02-01** for large taxpayers and **2026-04-01** for the rest.                                                      | Medium                                                                      |
| Italy, Spain, others | Italy's _SdI_ (FatturaPA) has been mandatory for years; Spain's B2B rules and Verifactu, Croatia, Romania and others have their own timetables. Not searched.                                    | **Unverified.** Check the tax authority before relying on any of it.        |

Two things follow for the design, whichever dates hold:

- **EN 16931 is the common core.** Every mandate above is either that
  standard, a profile of it (Peppol BIS 3.0, XRechnung, Factur-X) or a
  national format with a mapping from it. One internal model, many outputs
  (D2).
- **A country's rule is reached through its platform, not through the
  invoice alone.** France, Poland and Italy route through a state platform;
  Germany and Belgium through a network. That is why transport is a seam
  (D6) and not a feature of the document.

Sources read: [France schedule (EY)](https://www.ey.com/en_gl/technical/tax-alerts/france-revises-schedule-for-adopting-e-invoicing-reform),
[Germany timeline](https://www.fiscal-requirements.com/news/4525-germanys-road-to-full-b2b-e-invoicing-by-2028),
[ViDA adoption](https://www.deloitte.com/be/en/services/tax/blogs/final-go-for-the-vida-package.html),
[Belgium and Poland overview](https://www.fonoa.com/resources/blog/e-invoicing-and-digital-reporting-in-the-eu-upcoming-changes).

## 3. What is in, and what is not

**In:** the invoice data model on EN 16931; building an invoice from a
delivered order; tax treatment recorded by the owner; numbering; validation;
serialisation to UBL and CII (Factur-X later); an immutable issued record;
a transport seam with a file export that always works; delivery through a
certified provider; reading a received invoice and matching it to a payable;
the audit trail.

**Out, on purpose:**

- **Being an access point or an approved platform.** Certification, uptime
  duties and liability make it a regulated service, not a feature (D1).
- **Accounting:** a ledger, VAT returns, bank reconciliation, dunning, and
  payment collection (Ring 3; `#178` stays stop-and-ask).
- **Deciding tax.** Tessera records the owner's decision and refuses to
  issue without one (D4). It never infers VAT treatment from a country code
  and calls it correct.
- **B2C invoices, and a national scheme nobody needs yet** (KSeF, SdI,
  Verifactu). Each is an adapter and a profile added when a real client
  requires it (§7, phase 6), not built to cover the map.

## 4. Design decisions (proposed; §10 lists the ones that are Louis's)

**D1 — Tessera never becomes the platform.** It builds and validates the
document and hands it to a provider that is already certified (a Peppol
access point; in France an approved platform). Cost: a per-invoice fee and a
dependency on one provider. Mitigations: the transport is an interface (D6),
and a file export is always available, so a provider outage or exit never
stops an invoice being issued.

**D2 — One model: EN 16931.** `EInvoice` is a typed value in a headless
package (§8) following the standard's business terms. UBL, CII and the PDF
profile (Factur-X) are serialisers; Peppol BIS 3.0 and XRechnung are
_profiles_: a customization identifier plus extra rules. Not one model per
output, which would drift (the root `CLAUDE.md` rule on a fact defined once).

**D3 — The invoice that was sent is the record.** On issue, the number is
assigned and **the exact serialised bytes are stored**; the transmitted
document is those bytes, never a regeneration from rows. Reason: the
skeleton-by-slicing and "the price the client saw" rules again. A later
change to a serialiser must not alter what a buyer was sent years ago. An
issued invoice is immutable by trigger; a correction is a **credit note**
(type 381) referencing it plus a new invoice, never an edit. Digest
(SHA-256) of the stored bytes is recorded and compared on every send.

**D4 — Tax is the owner's input, confirmed, never derived.** The VAT
category and any exemption reason for a client (for example: domestic
standard rate; EU business client, reverse charge with both VAT numbers;
non-EU client, outside scope) are set by the owner per client and confirmed
per invoice, the way the portal treats a word count: **advice that a person
confirms, and only the confirmation counts** (`portal-v0-spec.md` §4). The
tool may _suggest_ from the buyer's country and VAT number, and says so. It
cannot issue an invoice whose treatment is unconfirmed. A VAT number check
against the EU's VIES service is advice, never a gate.

**D5 — Money is integers.** Amounts are integer minor units; a unit price is
integer micros, as `rate_micros` already is in the roster. The invoice never
inherits a float: the portal's `rate` table stores `REAL` today (the same
open question as `portal-v0-spec.md` §10's "Money type"), so building an
invoice from an order converts at **one named function** and the invoice
stores what it issued. Rounding follows EN 16931's business rules for the
line, document and VAT totals; a total that does not reconcile is an error
the validator reports, never a silent adjustment.

**D6 — Transport is an interface in `core`, implementations in the shell.**
`EInvoiceTransport` (pure interface, like `NotificationService` and
`ProductionAdapter`) has three operations: _can this buyer be reached?_
(directory lookup), _submit_ (the stored bytes, with the invoice id as an
idempotency key, so a retry never sends twice), and _receive/poll_ (inbound
documents and delivery statuses). Implementations live next to
`SmtpNotificationService`:

| Adapter                         | Use                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `FileTransport`                 | Download the XML (and later the PDF). Always on. The fallback for every other adapter.                                                      |
| `EmailTransport`                | Send the document by email to a buyer who is on no network. Fine where a mandate does not apply; **not** a way to meet one.                 |
| `PeppolAccessPointTransport`    | Through a certified provider's API. First network adapter (phase 2).                                                                        |
| `FrenchPlatformTransport`       | Through an approved platform, phase 4, only when an invoice to a French buyer is needed.                                                    |

**D7 — Delivery state is a log.** `invoice_event` is append-only by trigger
with a required actor, like `order_event` and `assignment_event`:
`drafted → issued → submitted → delivered → accepted | rejected` (and
`credited`, `cancelled_before_issue`). The latest event is the state; a
provider's callback is an event, never an edit. A rejection by the platform
or the buyer is recorded with its reason and leads to a credit note and a
new invoice, not to editing the issued one.

**D8 — Country rules are data.** Which format a buyer needs, from which
date, behind which platform, is a table (country, from, formats, platform
kind) read by the code, with its source and "verified on" date beside each
row. A date moving is an edit to data and to this spec's §2, never a
release. §2 is the human copy of that table until it exists in code.

**D9 — Validation is judged by the official artefacts.** What makes an
invoice acceptable is the standard's own business rules and the profile's
(EN 16931 and Peppol Schematron, the XRechnung rules), not our reading of
them. Two layers: (1) a TypeScript check in the product that refuses to
issue structurally invalid or non-reconciling invoices, so a person is told
before sending; (2) a **conformance gate** in CI that runs the official
rule sets over every invoice the builder produces for a corpus of
synthetic orders and over the published example files. The second layer
exists because of the lesson in the root `CLAUDE.md`: a validator we wrote,
tested by fixtures we wrote, proves only that we agree with ourselves. How
to run the official rules without a JVM at runtime (for instance compiled
Schematron executed with SaxonJS) is a spike to settle first (§7, phase 0).

**D10 — Outbound calls and secrets.** The provider's API credentials come
from the environment, never the database or a log. The provider host is
configuration, not something a request supplies. Anything an owner types
that becomes a URL the server calls keeps the webhook rules
(`vendor-spec.md` #125). The provider's inbound callback is a public path
named in `PUBLIC_PATHS`, authenticated by its signature, with a
body-and-fragment token rule if it ever carries one. The provider is a data
processor that sees invoice content, so its owner and hosting matter as
`worldwide-and-compliance-spec.md` §5.2 says, and a data-processing
agreement is part of choosing it.

**D11 — Numbering and concurrency.** Tessera is the only issuer of a portal
invoice's number (§10.1, decided 2026-10-11). One sequence per seller and
series, assigned at issue, inside `BEGIN IMMEDIATE`, in the same transaction that
stores the bytes and writes `invoice.issued`. A number is never reused or
skipped by the software; a draft that is abandoned has no number. Format
(prefix, year, padding) is a pure function; some countries require gapless
sequences, so the safe design is gapless everywhere.

**D12 — Retention beats erasure, and says so.** An issued invoice must be
kept for a period set by country (years; varies). It contains a buyer's
name and address, and a sole trader's are personal data. The audit rule
that "erasure can only reach `actor_label`" (`audit-spec.md`) therefore has
a sibling: an issued invoice is retained under a legal-obligation basis
and is not erased on request within its period. Flagged for Louis and a
lawyer (§10.6); this spec does not decide it.

## 5. Ring 2 — issuing to a portal client

The flow, from a delivered order:

1. The order is `delivered` (`portal-v0-spec.md` §2). The admin chooses
   "prepare invoice". Nothing is created before then.
2. **A draft is built from the order**, never typed: one line per target
   language, quantity the confirmed word count, unit price the approved
   rate, net amount the approved line total; a line priced at the minimum is
   one "minimum charge" line, not a fractional word count. The total equals
   the price the client approved (the 409 rule in `portal-v0-spec.md` §2),
   or the draft refuses to be built and says why.
3. **Parties.** The seller is one `seller_profile` (legal name, address, VAT
   number, registration number, bank details, platform identifier). The
   buyer is the client's billing profile: legal name, address, VAT number,
   the identifier a platform routes on (a French SIRET, a German
   _Leitweg-ID_ for a public buyer, a Peppol participant id), an optional
   buyer reference or purchase-order number. Today a portal `client` has a
   name and an email; the billing profile is new data the operator enters,
   never taken from the client's request.
4. **Validation report** (D9) shown on the draft: errors block issue,
   warnings do not. The admin **confirms the tax treatment** (D4).
5. **Issue** (D3, D11): number, stored bytes, digest, `invoice.issued`.
6. **Submit** through the configured transport (D6), or download the file.
   Events follow (D7).
7. The client's page lists their invoices and downloads them, scoped to the
   client by token: another client's invoice, a missing one and an unissued
   draft are one identical 404, as for a delivered file. The client sees the
   number, date, total and state, never a platform's internal reference.

Rules specific to this half:

- **A cancelled or re-priced order after issue is a credit note**, linked to
  the invoice; a new price is a new invoice. The order's price is frozen at
  approval, so the invoice and the order cannot silently differ.
- **A client plan** (`portal-v0-spec.md` §10, idea `#220`) invoices its
  monthly fee outside the order flow. Whether the same machinery issues that
  invoice is open (§10.5); the per-order draw never produces a line here.
- **Payment details are printed, not collected.** The seller's bank details
  and the due date appear on the invoice; recording that it was paid is a
  Ring 3 job (`#178`) and writes nothing in this spec.

## 6. Ring 1 — the vendor side

Two separable pieces, in this order.

**(a) Receiving a vendor's e-invoice.** A vendor's invoice (UBL, CII or
Factur-X) arrives by the provider's inbound channel or an owner's upload. It
is parsed into the same `EInvoice` model, stored as received (bytes and
digest, never rewritten), and **matched to a locked payable** by the
reference it carries (an assignment number the offer showed the vendor) and
compared on total and currency. A mismatch is a flag with both figures,
**advisory like every comparison in this product**: the payable is locked
and is never edited to agree with an invoice, and an invoice is never
edited to agree with a payable. Recording that a payable was paid stays the
payment event (`#112`), which this does not replace. Receiving is also a
legal duty in some countries (§2); being reachable is the provider's job,
parsing and matching is Tessera's.

**(b) Self-billing**, later and legally heavier: the owner issues the
invoice _on the vendor's behalf_ from locked payables (UBL type 389). It
needs a prior written agreement with each vendor, the vendor's acceptance of
each document, and the vendor's own VAT status, and the rules differ by
country. Per `#158`, a **vendor-confirmed payable statement** comes first
and self-billing is a per-vendor flag backed by an uploaded agreement. A
vendor with no VAT registration (a small-business or franchise regime) is
invoiced without VAT and with the exemption stated; the vendor's tax
profile is a roster field the owner sets, not inferred.

## 7. Phasing

Each phase ships on its own and is gated; none starts before the one above
it is merged (`CLAUDE.md`, one session on one area).

| Phase | What                                                                                                                                                  | Done when                                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 0     | **Decisions and spikes.** §10 settled; §2 re-verified; Rust/Wasm question asked (§10.7); a spike shows the official rule sets run headlessly in CI; a provider is chosen. | The decisions are recorded here; the spike's result is a results note, failures included.                                  |
| 1     | Seller profile, client billing profile, draft from a delivered order, tax confirmation, numbering, **issue**, immutable record, **credit note**, Peppol BIS 3.0 UBL serialiser, file download, the conformance gate. | An invoice built from a fixture order validates with zero official errors; issue is concurrency-safe and gapless; the stored bytes never change. |
| 2     | `PeppolAccessPointTransport`, `invoice_event`, the provider's callback, the client's invoice list.                                                    | An invoice reaches the provider's test network and its delivery status comes back as events; a retry sends once.            |
| 3     | Ring 1 receiving: parse UBL/CII into the model, store as received, match to a payable, flag mismatches.                                               | A published example invoice and a synthetic one match their payables; a mismatch is a flag, the payable unchanged.          |
| 4     | CII and Factur-X (PDF/A-3 with the XML embedded), the XRechnung profile, `FrenchPlatformTransport`.                                                   | Each output validates under its own official rules; only built for a country a real client needs.                           |
| 5     | Vendor-confirmed statement, then self-billing behind a per-vendor agreement (`#158`).                                                                | Per `#158`.                                                                                                                 |
| 6     | A national scheme (KSeF, SdI, Verifactu …), one at a time, on demand.                                                                                  | A client in that country is waiting for it.                                                                                 |

## 8. Where it lives

- **`@cat-tool/einvoice-core`** (new, headless like `core`, `portal-core` and
  `vendor-core`): the model, the order-to-invoice builder, tax categories,
  rounding, the numbering format, the serialisers, the TypeScript validator,
  the delivery-state machine, and the `EInvoiceTransport` interface. No
  database, no HTTP, no I/O: every rule provable from a test with nothing
  else in the loop. The XML reader needed for receiving is a dependency
  decision for phase 3; serialising is string building, which avoids the
  namespace problem the root `CLAUDE.md` describes for DOCX.
- **`packages/db/src/invoicing/`**: repositories through the shared
  migration runner. A client invoice lives in `portal.sqlite` (business
  data, not translation content, which that file's header allows); a
  received vendor invoice lives in the `.ctv`. Tables: `seller_profile`,
  `client_billing_profile`, `invoice` (immutable once issued, by trigger,
  holding the bytes and digest), `invoice_line`, `invoice_event`,
  `invoice_sequence`; and in the `.ctv`, `vendor_invoice` with its match to
  `assignment_payable`. Every closed set (states, tax categories) is a
  frozen literal in its migration, as the snapshot invariant requires.
- **`audit_event` actions**, each a migration that widens the `CHECK`:
  `invoice.drafted`, `invoice.issued`, `invoice.submitted`,
  `invoice.credited`, `invoice.exported`, `vendor_invoice.received`,
  `vendor_invoice.matched`. The actor is required and is the admin (or a
  named `system:` job for a provider callback).
- **`portal-server` / `server`**: routes (each one a repository call with
  HTTP around it) and the transport adapters. The web SPA imports types
  from `einvoice-core` only, never its runtime, as it does `core`.

## 9. Tests

Test first (red, then green), per `CODING.md`, for the hard invariants:

- An issued invoice cannot be updated or deleted (trigger).
- The transmitted bytes equal the stored bytes (digest), on every send.
- Two concurrent issues get two consecutive numbers; none is skipped.
- A total that does not reconcile is refused; no float reaches an amount.
- An invoice cannot be issued with an unconfirmed tax treatment.
- A credit note references an issued invoice and cannot exceed it.
- Re-submitting an invoice does not send it twice (idempotency key).
- A client reads only their own issued invoices; any other id is one
  identical 404.
- A received invoice never changes a locked payable.

The **conformance gate** (`pnpm test:einvoice`, sibling of `test:gate`) is
the product-level proof, not a unit test: it is excluded from `pnpm test`,
has its own CI job, and a red run is read before anything is touched.

**Fixtures are synthetic.** The repo is public: every seller, buyer,
address, VAT number and bank detail in a fixture is invented (reserved or
obviously fake identifiers), never taken from a real invoice, and no real
client or vendor appears in a fixture or a results file. Published example
files from the standard's or a network's own repository are used only where
their licence allows redistribution; otherwise they are fetched in CI and
not committed.

## 10. Decisions for Louis (§10.1 decided, the rest open)

Each is cheap to leave open now and expensive to reverse once an invoice
number has been issued, which is why they are listed rather than defaulted.

1. **Who owns the invoice number. Decided 2026-10-11 (Louis): Tessera
   issues the invoice numbers.** The alternative was that the ledger tool
   (Zoho Books) issues the invoice and Tessera only hands over the order. The
   reasons, kept on the record: a number sequence has to live in exactly one
   place; a legal e-invoice is a document this product can build from data it
   already holds (the order, its confirmed word count, its approved price);
   and whether the ledger tool can issue a compliant e-invoice for every
   country needed was never checked. Cost accepted: Tessera now carries a
   legal-document duty (numbering, immutability, retention, D3, D11, D12).
   What follows from it:
   - **The ledger is a consumer.** It receives a copy of each issued invoice
     as a read-only export (a structured file, with a digest, logged like
     `payables.exported`); it never issues a number in a portal invoice's
     series and never edits an issued invoice. Whether a direct push to the
     ledger is built, or the export only, belongs to Ring 3 and is not decided.
   - **An invoice created in the ledger by hand is outside Tessera.** It
     carries the ledger's own numbering and is not a portal invoice; the
     operator keeps the two series apart, and a seller profile names the
     series Tessera owns so nothing else can draw from it.
   - **Phase 1 is unblocked on this question.** Phase 0 still settles §10.2
     and §10.3, because the provider and the seller's country decide which
     profile is built first.
   - **Still to do before the first issued invoice,** and not decided here:
     the numbering format (prefix, year, padding) and whether the series
     restarts each year, which depend on the seller's country (§10.3).
2. **Which provider and which network first.** _Recommendation: a Peppol
   access point first_ (phase 2), because one adapter reaches several
   countries and French platforms are expected to interoperate with it (to
   be confirmed). Selection criteria: certified, an API and a sandbox,
   EU-owned and EU-hosted (`worldwide-and-compliance-spec.md` §5.2), a
   data-processing agreement, a published price. No provider is named here.
3. **From which country the business invoices.** This decides the first
   profile (Peppol BIS 3.0, XRechnung, Factur-X) and the first mandate that
   binds. Not assumed in this spec.
4. **One seller or several.** _Recommendation: one `seller_profile` (the
   portal's operator) in phase 1._ Solo-translator mode (`#179`) and other
   LSPs as customers (`ai-platform-vision.md` §7.5) would need several; the
   tables are keyed so adding it is a migration, not a rewrite, but nothing
   is built for it.
5. **A client plan's monthly fee** (`portal-v0-spec.md` §10): invoiced
   through this machinery, or outside Tessera as that section now says.
   _Recommendation: outside, until phase 1 has shipped._
6. **Retention and erasure** (D12). Needs the owner's accountant and a
   lawyer.
7. **Rust/WebAssembly**, asked before the first line of the feature, per
   the root `CLAUDE.md` working rhythm. _Default: TypeScript._ The one
   plausible kernel is running the official rule sets (XSLT/Schematron) and
   embedding XML in a PDF/A-3, both pure and checkable by the conformance
   gate; neither has a measured bottleneck, so nothing is proposed yet.
   Recorded here, answered in phase 0.
