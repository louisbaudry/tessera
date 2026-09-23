# AI Platform Vision

**Status:** draft for review
**Date:** 2026-08-30
**Extends:** `v1-spec.md`, `conversation-context.md`, `v1-backlog.md`
**Backlog:** new epics, placed after Epic 7 (see §6) — sizing deferred

This is not a new product. It is what v1 grows into once it actually
works: the same engine (`@cat-tool/core`, `@cat-tool/db`), aimed at the
whole translation business instead of one segment-and-export loop.

---

## 1. The thesis

> "There are a lot of good tools on the web, but no tool has every aspect
> of the translation business." — the reason for this document

Trados does CAT. A separate tool does PM. Another does quoting. Vendor
management lives in a spreadsheet. Client communication lives in email.
Every one of those handoffs is a place work gets lost, and every one of
them is a separate subscription and a separate mental model for the
person running the business.

The bet: one system, one data model, covering client intake through
delivery — not by building everything at once, but by building the CAT
tool core first (because that's the daily pain) and growing outward from
it, so nothing has to be re-architected to add the next piece.

This **replaces** the original three-point commercial wedge
(`conversation-context.md`) as the headline differentiator, without
discarding the other two — cross-platform reach and modern UX are still
true and still matter, but "the only tool that covers the whole business"
is the one a competitor can't cheaply copy by adding a feature.

---

## 2. Who "client / Language Provider / translator" actually are

Not a generic three-sided marketplace, modeled abstractly. A concrete
triangle, grounded in the business that will actually test it:

- **Language Provider** — the vendor-manager role. Louis, running the
  business: quoting, assigning, project setup, delivery.
- **Translator** — the person doing the segment-level work. Louis, and
  the freelance translator Louis already outsources to.
- **Client** — the person the finished work goes back to. Louis's own
  real client, a current agency/direct client of 22 years' worth of
  relationships, has agreed to be the test case for whatever a
  client-facing surface eventually looks like.

**Decision (2026-08-30): built to eventually sell to other LSPs and
freelancers, proven first on this one real triangle.** That horizon is
why storage was already built account-scoped (`v1-spec.md` §4.1a, backlog
#15) rather than as a single global project set — extending to other
users later is additive, not a migration. It does **not** mean building
generic multi-tenant signup now; see §5.

---

## 3. The roadmap: rings around what exists

Each ring is a real, separately shippable product state — not a phase
that has to finish before the next starts thinking begins, but a
sequencing of *building* effort.

### Ring 0 — "Get rid of Trados." *(in progress; unchanged by this doc)*

Asked directly what to fix first, across 22 years and every tool tried,
the answer was **the CAT tool itself** — clunky, slow, or ugly — not the
absence of AI. Trados's actual daily failure is the editing experience,
not a missing chatbot.

Ring 0 is exactly the existing v1 backlog (Epics 0–7, `v1-backlog.md`):
DOCX filter, segmentation, TM-exact matching, rule-based QA, the editor
itself — fast, keyboard-driven, calm. **No AI in Ring 0.** A rock-solid
TM-based editor is already a Trados replacement for daily work; it is
also the only honest foundation to add AI *to* later; see Ring 0.5.

Nothing here changes. Continue the backlog in its existing order.

### Ring 0.5 — AI-assisted translation *(deliberately sequenced after Ring 0, not bundled with it)*

**Decision (2026-08-30): a solid plain editor first, AI added
after — not built together.** This was a direct, considered choice
against my own recommendation, made by naming exactly what's wrong with
every LLM-in-CAT-tool integration tried so far:

| Named failure | What Ring 0.5 must do instead |
|---|---|
| Suggestions ignore glossary/TM/style | Every AI suggestion is generated *with* the project's TM matches, glossary, and style guide in the prompt — never a bare "translate this sentence" |
| A bolted-on chat/sidebar | AI assistance lives inside the segment-by-segment flow — an inline draft where the target goes, not a separate panel to switch to |
| Too slow, breaks keyboard flow | Suggestions are prefetched ahead of where the translator is working, never a blocking "wait for the response" step |

Architecture, otherwise settled:

- **Matching order: TM first, MT as fallback** — Trados-like. An exact
  TM hit still wins outright (v1's existing locked decision, untouched).
  Only a segment with no TM hit gets an AI-generated draft.
- **Two engines, two jobs.** A dedicated MT engine produces the fast
  first-pass draft; **Claude** does context-aware polish (glossary, style
  guide, surrounding segments) and powers the AI QA layer described
  below. Provisional pick for the MT engine: **DeepL** — strongest on
  the Romance/Germanic language pairs this business actually uses, and
  EU-based, which sits better with the confidentiality posture in §5.
  Swappable; not a deep architectural commitment.
- **AI QA is a second AI surface, not the same as MT drafting.** The
  original complaint — "QA is dumb, catches trivial stuff, misses real
  errors" — is answered by Claude reading a translated segment against
  its source for meaning, tone, and terminology, *in addition to* the
  existing rule-based checks (`v1-spec.md` §6.4), not instead of them.
  Rule-based QA is cheap, deterministic, and already built; semantic QA
  is what closes the actual gap named.
- **`origin` needed no schema change.** `Segment.origin` was built as a
  deliberately open string specifically so a new source is just a new
  value (`v1-spec.md` §4.3) — `mt_draft`, `mt_claude_polished` slot in
  without touching `@cat-tool/db`.

**Already fixed for Ring 0.5 (2026-09-23):** every accepted AI draft
is recorded with the accepting human as actor and the engine, model,
prompt version and input digest as provenance. Every send of client
content to an engine is an event too. This is what makes §5's disclosure
and per-client opt-out provable after the fact
(`planning/audit-spec.md` §4).

Not yet designed: the actual editor interaction (what an inline AI
suggestion looks like, how it's accepted/rejected/edited, how QA findings
surface next to rule-based ones). That's Ring 0.5's own spec, written the
way `segmentation-spec.md` was — when Ring 0 is far enough along that
Ring 0.5 is next, not now.

### Ring 1 — Language Provider tools

Vendor/translator management (profiles, rates, specialties, capacity,
quality history — making assigning work to a subcontractor a real
feature instead of an email) and AI-assisted quoting (client uploads a
file, AI analyzes word count/complexity/domain/repetition and drafts a
quote and a suggested assignment).

Concrete workflow discovery — how a job to a subcontractor actually happens
today, what's manual about the handoff — is **deliberately deferred to
when Ring 1 is being designed**, not guessed at now. Recorded as open in
§7.

### Ring 2 — Client-facing

Intake beyond a file and a language pair (brief, tone, audience,
references), status visibility, a way to leave feedback — instead of all
of it living in email. Real client, real test: the one who agreed to be
the client-role tester. Same deferral as Ring 1 — her actual pain points
get gathered when this ring is next, not now.

**Design note, recorded 2026-08-30 for when this ring is designed:** most
translation web apps aimed at ordinary clients get the client experience
wrong — Weglot and WPML were named specifically. They're built by and for
people already fluent in the translation/localization domain, and that
shows up as jargon, workflow steps, and options that make sense to a
translator or a developer but scare off someone who just needs something
translated and has never heard of a TM, a segment, or a language pair
convention. The client-facing surface is not a stripped-down version of
the translator's editor — it needs its own design pass, written for
someone who is *not* in the translation business at all.

### Ring 3 — Invoicing and payments

Provisional lean: **integrate, don't rebuild.** The account already has
Zoho Books connected; the natural shape is handing off billable totals to
a tool already in use rather than building accounting software. Revisit
when Ring 3 is actually next — cheap to change, expensive to build early
and be wrong.

### Ring 4 — Website localisation *(v2/v3 — "Weglot, but it accepts your TM")*

**Recorded 2026-09-15, from a real and repeated loss.** Clients who
already had a translation memory here — years of approved, reviewed,
client-specific wording — put their websites through Weglot anyway,
because that is what a website plugin looks like on the market. Weglot
has no way to import a translation memory. So the site gets
machine-translated from zero, the terminology the client already paid to
settle is discarded, and the translator is paid again to re-approve
wording that was already approved in a `.ctm` sitting on this side of the
relationship. The content overlap between a client's documents and their
website is not marginal — product names, boilerplate, legal text, the
"about" copy — and every point of it is thrown away twice: once as MT
cost, once as review time.

That is the whole wedge, and it is one this codebase is unusually
placed to take: the memory already exists, the retrieval path already
exists, and neither knows or cares that the caller is a web page.

- **The TM is the feature, not an add-on.** A website is one more caller
  of `retrievePair` (`db/tm/retrieve.ts`) and the priority-ordered
  attached-refs mechanism — a client `.ctm` over a base `.ctm`, a client
  `.ctg` glossary over a base one, exactly as a project gets them today.
  The match tiers, the ICE definition, the glossary decision log all
  apply unchanged. Nothing about the matcher becomes web-specific.
- **HTML is a new filter, under the DOCX filter's rules.** The
  skeleton-by-slicing invariant is if anything *more* load-bearing here:
  a re-serialized DOM reorders attributes, normalises quoting, and
  rewrites void elements, so a page would come back subtly different
  everywhere the translation did not change anything. An HTML roundtrip
  gate against a corpus of real client pages is the equivalent of
  `pnpm test:gate`, and it is what the epic should be proven by.
- **A TM match takes the receiving page's formatting.** The existing
  invariant lands exactly right: a bold span from a 2023 DOCX must render
  as today's page's `<strong>`, not carry a run property across a format
  boundary. `TmToken`'s `kind`-only design is what makes a DOCX memory
  usable on HTML at all.
- **It is a continuous loop, not an import.** A site changes under you;
  the shape is crawl → diff → segment → match → review → publish, run
  repeatedly. That is precisely the workload a TM makes cheap, and the
  reason a pure-MT competitor bills for it every time.
- **Human review is the product, and this business already has it.**
  Weglot sells MT with an optional "order a translation" button. Here the
  review surface already exists twice over (the editor for the
  translator, the portal for the client), so the reviewed-website tier is
  a configuration of things already built, not a new product line.

Deliberately **not decided now** — they need a design pass when this ring
is next, and guessing costs more than deferring:

1. **Delivery mechanism.** Client-side JS snippet (what Weglot does —
   trivial to install, weak for SEO), reverse proxy on a subdomain or
   subdirectory (server-rendered, SEO-correct, more operationally
   involved), or CMS/build-time integration (best output, one per
   platform). SEO is usually the reason a client pays for a translated
   site at all, which argues against starting with the snippet however
   easy it is to demo.
2. **Stable segment identity across a redesign.** A page's text moves,
   and matching needs to survive that. Note the frozen-contract
   invariant before anyone reaches for it: `prev_hash`/`next_hash` mean
   §4-normalised neighbouring *segment* hashes and nothing else. A
   URL-, DOM-path- or selector-derived value does not go in those
   columns — that is exactly the `.sdltm` mistake — it goes in `tu_attr`
   as provenance, and web-sourced units say plainly whether they can be
   ICE.
3. **Where the review happens** — the translator's editor, the client
   portal, or an in-page overlay on the live site.
4. **Pricing.** Weglot bills per translated word per month, in
   perpetuity, for content it already translated once. Something else is
   possible when the memory is an asset the client owns; §7.5's general
   pricing question covers it and this is the sharpest instance of it.

---

---

## 4. What stays exactly as built

Nothing in `@cat-tool/core` or `@cat-tool/db` changes because of this
document. The DOCX filter, the segmentation engine (including custom
segmentation), the tag model, split/merge, the project schema, and the
migration runner are Ring 0 infrastructure and Ring 0.5+ infrastructure
alike — this vision is additive to them, the same way the web-service
pivot was.

---

## 5. Confidentiality and data handling

Client documents carry real contractual and legal exposure once AI
processing enters the picture (Ring 0.5 onward) — this was worked
through in conversation and the conclusion is recorded here so it isn't
re-litigated per project:

1. **Only paid/enterprise API tiers, never a consumer AI product**, for
   any client content. This one rule removes most of the actual risk —
   enterprise terms mean no training on inputs/outputs and a real data
   processing agreement; consumer tools often make the opposite promise.
2. **AI processing is opt-in per project or per client**, default on,
   one click off — because some client contracts explicitly forbid
   third-party tools or machine translation, and that's a contract
   question the *translator* has to be able to answer per client, not
   something the software should decide for them.
3. **Disclosure, not silence.** A line in whatever service agreement
   exists with a client, naming that AI-assisted tools may be used.
4. **GDPR paperwork (DPAs, cross-border transfer terms) is a real task,
   deferred until it's needed** — i.e., until a client in a regulated
   sector (legal, health, government, pre-filing patents) is actually
   on the books. Building the compliance machinery before there's a
   client who needs it is effort spent on the wrong thing right now.
   **Partly reversed 2026-09-23** (`worldwide-and-compliance-spec.md`
   §6.1): the compliance *machinery* (audit log, access control,
   encryption at rest, deletion) is now built by design from the start;
   the per-client *paperwork* (DPA, BAA) is still produced when a client
   needs it.

---

## 6. Backlog placement

Epics 0–7 (`v1-backlog.md`, #1–#38) are Ring 0 and are unchanged in scope
or order. New epics are appended, not interleaved — Ring 0 finishes on
its own merits before Ring 0.5 is scoped in the same detail
segmentation-spec.md gave custom segmentation:

- **Epic 8 — AI-assisted translation** *(Ring 0.5, unsized — spec'd when Epic 7 is close to done)*
- **Epic 9 — Language Provider tools** *(Ring 1, unsized — first design
  pass drafted 2026-09-22, `planning/vendor-spec.md`; see §7.1)*
- **Epic 10 — Client-facing** *(Ring 2, unsized)*
- **Epic 11 — Invoicing/payments integration** *(Ring 3, unsized)*
- **Epic 12 — Website localisation** *(Ring 4, v2/v3, unsized — see §3)*

---

## 7. Open, deliberately deferred

Recorded so they aren't lost, not because they're urgent:

1. **The subcontractor's actual workflow** — how a job reaches her today, how her
   output comes back, what's manually painful about it. A first Epic 9
   design pass now exists (`planning/vendor-spec.md`, 2026-09-22),
   grounded in Louis's own vendor/translator/owner experience rather
   than guessed at — but it is not yet validated against the subcontractor's
   specific workflow, the one real outsourcing relationship this product
   has today. Still needed before implementation, to catch anything the
   owner-side view doesn't surface.
2. **The test client's actual pain points** — what she doesn't currently
   see or get that a client-facing surface should fix. Needed before
   Epic 10.
3. **DeepL vs. an alternative MT engine** — provisionally DeepL (§3);
   worth a real comparison once Epic 8 is underway, not before.
4. **Invoicing: integrate with Zoho vs. build native** — provisional
   lean toward integration (§3); revisit when Epic 11 is next.
5. **Pricing/licensing model for eventual other-LSP customers** — not
   touched in this document at all. Out of scope until the product
   works for one business first.
6. **Website localisation delivery mechanism** — proxy vs. JS snippet
   vs. CMS plugin, and how segment identity survives a redesign (§3,
   Ring 4). Recorded 2026-09-15; needed before Epic 12 is designed, not
   before.
