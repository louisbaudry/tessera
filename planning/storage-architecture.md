# Storage architecture — RDBMS migration (placeholder)

Status: not designed. This document exists to hold a decision raised
during Vendor Component scoping (`vendor-spec.md`, 2026-09-21) that is
explicitly **not** Vendor-scoped and must not be decided implicitly by
however Vendor's schema happens to land.

## 0. The question

Whether the platform moves off SQLite (`.ctm`, `.ctg`, `.ctv`,
`portal.sqlite`, `platform.sqlite`) onto a shared RDBMS (Postgres or
MySQL), in whole or in part, and if so, when and in what order.

This is a platform-wide decision, not a per-component one, because it
touches several standing invariants recorded in the root `CLAUDE.md`:

- The shared migration runner (`packages/db/src/migrate.ts`) — format-
  version guard, pre-migration backup, integrity check — is written
  against SQLite file semantics.
- Cross-file queries use SQLite's `ATTACH`/`DETACH` (`tm-refs.ts`,
  `glossary-refs.ts`, the `(db, params, { schema? })` repository-read
  pattern) — a mechanism that doesn't exist the same way in a
  client-server RDBMS.
- `.ctm`/`.ctg` are deliberately **portable single files** — a
  translation memory or glossary a translator can hand off, attach, or
  carry between machines. That portability is a real product feature,
  not an implementation detail; moving it to a hosted RDBMS changes what
  the feature *is*, not just how it's stored.
- The DOCX roundtrip gate and the golden end-to-end test don't depend on
  SQLite directly, but every fixture and test that touches `.ctm`/`.ctg`
  read/write paths does.

## 1. Why this exists as a separate document

Raised while scoping Vendor's storage (`vendor-spec.md` §1.4): vendor
business data needs concurrent multi-writer access and reporting-style
queries in a way that may fit an RDBMS better than a single-writer
SQLite file. But deciding "Vendor uses Postgres" in isolation would mean
either:

- a second storage stack alongside SQLite, with its own migration and
  backup story, decided by accident rather than on purpose; or
- silently starting a platform-wide migration one component at a time,
  with no spec covering the components that would need to move with it
  or explaining why some stay on SQLite and others don't.

Vendor v1 proceeds on SQLite (own file, `.ctv`, through the shared
migration runner — see `vendor-spec.md` §1.3–1.4) specifically so it
isn't blocked on this decision, and so its schema stays one bounded,
portable unit that a later migration (if it happens) can move as a
whole rather than having to be untangled from `platform.sqlite` first.

## 2. What needs deciding here, later

- Scope: everything, or only components that actually need
  concurrent-writer/reporting characteristics SQLite doesn't give
  (candidate: Vendor: multiple PMs and vendors writing assignment/
  status data concurrently)?
- Whether `.ctm`/`.ctg` portability is preserved by keeping those two
  formats on SQLite permanently even if other components move, or by
  designing an export/import story so a "file" still exists on top of
  an RDBMS-backed store.
- What replaces the shared migration runner's guarantees (format-version
  guard, pre-migration backup, integrity check) for whatever moves.
- Hosting/ops cost: an RDBMS is a server to run, not a file to commit or
  hand off — who operates it, and does that change the product's
  self-hosted-by-default story.

## 3. Status

No decision yet. Not blocking any in-flight epic. Revisit when a
specific component's needs (starting with Vendor, per §1) make the
tradeoff concrete rather than hypothetical.
