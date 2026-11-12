# Accounting connectors — candidate list (draft)

Status: candidate list, not a spec. Recorded 2026-11-11 from a planning
session. Nothing here is built, scheduled or decided beyond the lean below.

## Why this exists

`ai-platform-vision.md` Ring 3 (v4, invoicing and payments) and
`e-invoicing-spec.md` §1 set the direction: Tessera integrates with an
existing ledger for bookkeeping, VAT returns, bank reconciliation and
payments, and does not rebuild accounting software. Zoho Books is the
provisional choice. This file lists the other accounting apps a connector
could target, so the next decision (which market first) has a list to read.

## What the sources are

Everything about each app below comes from memory of its public product
and developer documentation, read in 2026-11. **Nothing has been checked
against current developer docs.** Auth method, endpoints, rate limits,
sandbox availability and API completeness are all unverified. Before a
card is written for any entry, its current developer documentation is
read and the findings are recorded here (per the repo's rule against
inventing APIs).

## Tier 1 — start here

| App | Markets (from memory) | API shape (unverified) | Notes |
|---|---|---|---|
| Zoho Books | Global | REST, OAuth 2.0 | Provisional choice in `ai-platform-vision.md`. Zoho MCP tools are already reachable from the build environment, so data shapes can be inspected early. |
| QuickBooks Online (Intuit) | US, UK, CA, AU | REST, OAuth 2.0 | Large installed base among small firms. |
| Xero | UK, AU, NZ (strong in Commonwealth markets) | REST, OAuth 2.0 | The Xero MCP server did not connect in the build environment (dynamic client registration refused), so a direct API connector would be needed. |

## Tier 2 — choose by pilot-client country

| Market | App | Notes |
|---|---|---|
| UK | FreeAgent | Aimed at sole traders and freelancers, which fits `solo-translator-spec.md`. |
| UK | Sage Accounting | Cloud product, not the desktop Sage 50. |
| NL, BE, DE | Exact Online | Strong in the Benelux. |
| DE | sevdesk | Germany-focused, small firms. |
| DE | lexoffice (Lexware) | Germany-focused, small firms. |
| FR | Pennylane | Popular with French SMEs and accountants. Relevant to the French e-invoicing mandate in `e-invoicing-spec.md`. |
| DK, Nordics | e-conomic (Visma) | Danish origin, used across the Nordics. |
| ES | Holded | Spain-focused. |
| US | Wave | Free tier; its API is limited, so it is the lighter option. |

## Tier 3 — larger LSPs and ERP

| App | Notes |
|---|---|
| NetSuite | SuiteTalk REST and SOAP. Enterprise. |
| Microsoft Dynamics 365 Business Central | Mid-market ERP. |
| Sage Intacct | Mid-market, US-led. |
| SAP Business One | SMB and mid-market ERP. |
| Odoo | Open source, often self-hosted. Its licence is checked under `prior-art.md` only if code is ever reused; connecting over its API copies nothing. |

## Likely file export only, not a connector

| App | Why |
|---|---|
| Sage 50 (desktop) and other desktop-only tools | No public cloud API to our knowledge. Route: export a file and import it. |

## Adjacent, same spec, not accounting apps

- **E-invoicing networks**: Peppol access points, and the national platforms
  for France, Poland and Italy. Covered in `e-invoicing-spec.md`.
- **Payment providers**: Stripe, GoCardless and similar. Payment is a
  stop-and-ask item (`#178`), so these are not connectors to build without a
  decision.
- **Bank feeds**: Open Banking aggregators. Only if the ledger does not
  already provide bank feeds.

## How to choose the first target

Three inputs decide it, and only the first needs Louis:

1. **Pilot-client country** (decision for Louis). It sets the Tier 2 market.
2. **A public API with OAuth 2.0 and a sandbox.** Verified from the docs,
   not assumed.
3. **Whether any tenant already uses the app.** A connector nobody's ledger
   runs on is not worth building first.

## Constraints every connector must meet

- **Outbound client data.** A connector sends invoice data (client names,
  amounts, invoice numbers) to a third party. Each connector needs its own
  consent and outbound-data review, in the same shape as the engine consent
  gate (`translation-engine-spec.md`, `server/src/engine.ts`).
- **No client or person name in this repo.** This file names products and
  markets only. Real client, tenant or invoice data never enters it or an
  issue filed from it (`CLAUDE.md`, public repository rules).
- **Tenant boundary.** A connector is a tenant's own setting, never shared
  across tenants (`tenant-spec.md`).
- **Ledger is the system of record for the ledger**, not Tessera
  (`ai-platform-vision.md` Ring 3). Invoice numbers are issued by Tessera and
  copied to the ledger (`e-invoicing-spec.md` §10.1).

## Open questions

- Which country the pilot clients invoice from. This selects the Tier 2
  market and is the one decision this list cannot make.
- Whether the first connector writes invoices into the ledger, reads payment
  status back, or both.
- Whether Tessera asks the tenant to connect its own ledger account, or
  whether an accountant holds the connection. Both need OAuth consent and
  stop-and-ask handling (`UNIVERSAL.md`, credentials and consent).

## Next steps

1. Louis picks the pilot market (Tier 2 row, or Tier 1 default).
2. Read the chosen app's current developer docs and record the verified auth,
   endpoints and sandbox here, replacing the unverified cells.
3. File one backlog-linked issue per connector, with a milestone of v4
   (Ring 3).
