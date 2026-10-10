# Competitive research

**Status:** record of one sweep (2026-10-08) and the method for the next
**Extends:** `ai-platform-vision.md`, `v1-backlog.md`
**Not a spec.** Nothing here is a decision. Each idea is an open issue,
and an issue becomes a backlog entry only when someone picks it up.

Tessera spans three surfaces most competitors split across separate
products: the translation editor, agency (LSP) project and vendor
management, and the client and freelancer side. This file records how
the first sweep was done, what it found and where each finding went, so
the next sweep starts from it instead of repeating it.

## 1. Method

Three research agents read **public pages only**, one per surface. They
did not log in, sign up, or bulk-scrape any site whose terms forbid it.

- **Vendor pages:** changelogs, release notes, feature and pricing pages,
  help-centre docs, public roadmaps.
- **User voice:** forums, review sites, public issue trackers.
- **Market signals:** trade press and comparison articles.

Every claim carries a source URL and a date, and is tagged as an opened
page, a search snippet, or vendor marketing. A claim that could not be
read is marked `unknown`, never filled in. Quotes are verbatim or marked
as paraphrase.

An idea is worth filing when it (a) is backed by a named competitor
feature or a recurring user complaint, (b) is not already built (check
`v1-backlog.md` and the open issues first), and (c) names which of
Tessera's invariants it must respect. It is filed as an issue titled
`Idea: …` with its evidence links, what Tessera has today, the risks, and
any decision that is Louis's to make.

## 2. Limits of this sweep

- Reddit was unreachable. ProZ, Capterra, G2 and TrustRadius refused
  direct fetches, so user voice is thin and mostly from search snippets.
- Several page summaries came back second-hand from a smaller model.
- Several price comparisons were written by competitors.
- Studio 2026's official release notes were not found. Wordfast, OmegaT
  and Matecat have no usable dated changelog.
- The raw reports are not committed: they hold unverified third-party
  claims, many of them snippet-derived. The issues carry the evidence
  that matters for each idea.

## 3. What the sweep found

- **Agent endpoints:** Lilt, Phrase, Crowdin, Lokalise, Transifex and
  Weglot all shipped an MCP or agent interface in 2026.
- **Document-level context for AI:** Trados Studio 2026 and Crowdin pass
  surrounding segments, style guides and glossary terms to the model.
- **Cascading offers** are standard in agency tools (Smartcat, XTRF,
  Plunet). None of the XTRF, Plunet or Wordbee pages read mention
  self-billing.
- **Instant quotes** are rare: only Translated, MotaWord and in part
  Rapid Translate offer one. Most others say "contact sales".
- **Weglot billing** is the loudest client complaint found (words counted
  once per language, translation stops at the plan cap, unclear TM tier).
  That supports Epic 12's "bring your TM" position.
- **Freelancer pain:** late or opaque payment, many portals, slow
  invoicing. The frozen analysis and locked payable already answer part of
  it; what was missing was presentation (since built, `#112`/`#113`).

## 4. Where each idea went

| Issue | Idea | Surface |
| ----- | ---- | ------- |
| #148 | Document-level context and a versioned style guide for AI pre-translate | Editor |
| #149 | Propose glossary rulings from edits to AI output (builds on `segment_exception`) | Editor |
| #150 | Show where each draft came from, and log AI spend (metadata only) | Editor |
| #151 | Fix or retire a TM unit, and add a term, without leaving the editor (half built: backlog `#129`, add a term from a selection; editing or retiring a unit needs a match panel the editor does not have) | Editor |
| #152 | An MCP/agent endpoint over the headless core | All |
| #153 | Payables ledger (built: backlog `#112`, screens `#113`) | LSP |
| #154 | Margin report: portal order price minus locked payable | LSP |
| #155 | Offer timing: cascading offers, auto-repost, deadline reminders (built: backlog `#126`, reminders and an overdue notice; auto-repost decided against; cascading offers remain) | LSP |
| #156 | Eligibility pre-filter with time off, and restricted pools per client (built: backlog `#128`, the advisory read by pair, specialty and capacity, and `#130`, a project's portal client and a client's vendor pool; time off remains) | LSP |
| #157 | Vendor scorecard from data already held, with decline reasons (built: backlog `#123`, acceptance and on-time counts on the roster; the rest is the follow-up) | LSP |
| #158 | Vendor-confirmed payable statement, then self-billing and e-invoice | LSP |
| #159 | Portal quote reflecting the client's TM, and a no-login price calculator | Client |
| #160 | Delivery date, rush tier and an on-time promise | Client |
| #161 | Certified translation as an order type | Client |
| #162 | Client self-serve export of their own TM and glossary (built: backlog `#127`, a linked memory as TMX and glossary as CSV; the base memory is never linkable by a request) | Client |
| #163 | Update orders priced only on new or changed segments | Client |
| #172 | Document preview beside the grid, then a side-by-side review mode | Editor |
| #173 | Real-time presence and per-segment locks | Editor |
| #174 | AI quality checks in the QA panel, off by default, with a precision record | Editor |
| #175 | Command palette, assignable shortcuts and an accessibility pass (built: backlog `#115`, the palette; the rest is #193) | Editor |
| #176 | Outbound signed webhooks (built: backlog `#125`, vendor events only; the portal's order events are not) | LSP |
| #177 | A client review round inside the portal | Client |
| #178 | Pay-after-delivery terms, then card or bank checkout | Client |
| #179 | Solo-translator mode | Client |
| #180 | Large-document mode: a tested segment ceiling, QA in batch | Editor |
| #181 | A Resources side tab (built, backlog `#114`: memories and glossaries; reference files and a style guide are #190) | Editor |
| #182 | Stale-translation advisor after a glossary change (built: backlog `#122`, the memory scan; editing a unit from the report is not) | Editor |
| #183 | Review by exception for AI drafts | Client |

`#171` (a segment review step with MQM-style scoring) came from another
session and covers the reviewer-tag idea, so it was not filed twice.
Issue `#25` (website localisation) received the Weglot billing findings.

Candidates dropped because they already exist: the vendor feed and
capacity toggle (`#52`, `#54`), the running payable total in the editor
(`#53`), showing a vendor the frozen analysis and rates before they accept
(`#50`), and forbidden-term handling in the glossary (Epic 8a).

Statuses live on the issues, not here. This table is the map from the
sweep to the issues, as of 2026-10-09.

## 5. Decisions the sweep left for Louis

These are not cheap to reverse, so none was decided:

- **#152**: whether an agent endpoint is a product bet now, and for which
  side (PM, client, or both). An agent that writes needs a named human
  actor on every write, and the price-approval step stays human.
- **#158, #178, #179**: tax and VAT rules for self-billing and invoices,
  payment credentials and a provider, and whether individual translators
  are a customer segment at all.
- **#160, #161**: a late-delivery refund and an acceptance guarantee on
  certified work are commercial and legal promises.
- **#176**: webhooks add an outbound data flow and an SSRF surface.
- **#183**: auto-accepting segments without a person cuts against "a
  human decides" in `ai-platform-vision.md`, and changes what vendors are
  paid.

## 6. Rules for the next sweep

- Public pages only. Respect each site's terms and `robots.txt`. No
  logins and no trial signups (account creation is Louis's call).
- Cite a URL and a date for every claim, and say how it was read. Never
  invent a feature, quote, price or statistic.
- Check `v1-backlog.md` and the open issues before filing, and file one
  issue per idea. A competitor feature is a reason to consider an idea,
  not a reason to build it.
- Competitor facts may go in the repo. Opinions about competitors do not.
- No client data or personal data in a report, an issue, or a fixture.
- Ideas about semantic matching are research-tracked: see
  `semantic-matching-spec.md` §6 before filing or acting on one.
