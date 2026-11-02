# Standards register

**Status:** register and direction, opened 2026-11-02.
**Extends:** `worldwide-and-compliance-spec.md` §6 (security and privacy
controls), `prior-art.md` (a standard is cited, never copied).
**Not a spec.** It says which ISO (and related) standards apply to a product
like Tessera, what each asks of the software, where Tessera already stands,
and which card carries each gap. Each gap is designed in its own spec section
before code, as usual.

## 0. What "Tessera complies" can and cannot mean

Louis's instruction (2026-11-02): Tessera should comply with the ISO
standards for this kind of product. Three different things hide in that
sentence, and the register keeps them apart:

1. **Process standards certify a company, never software.** ISO 17100
   (translation services) and ISO 18587 (post-editing) are audited against a
   Language Service Provider. No CAT tool is "ISO 17100 certified", and the
   product must never say it is. What software can do is **let a tenant run
   the required process and prove it ran**: the steps, the people's
   competences, the records. That is the target: _a tenant certified to
   ISO 17100 can run its whole certified workflow in Tessera, and hand an
   auditor the evidence from it._
2. **Format and code standards are conformance the software itself has**
   (XLIFF 2.0, TBX, OOXML, language and currency codes, dates). These are
   testable in CI, and several are already met.
3. **Management-system standards** (ISO/IEC 27001, 27701, ISO 9001) certify
   an organisation's controls. The software's share is the control set in
   `worldwide-and-compliance-spec.md` §6.2. Certification of the company that
   operates Tessera stays "when a paying client needs it" (§6, decision of
   2026-09-23). This register does not reopen that decision.

### 0.1 How much of this is read from the standards themselves

**Fact:** none of the ISO texts below has been read in this repository. ISO
standards are sold per copy. What follows is from their published titles,
scopes and widely documented summaries, so every requirement is written in
general terms. No clause number is cited, because none has been checked.
**Before a card claims to satisfy a standard, the standard is bought and read**,
and its card records which clauses it meets. Buying them is Louis's call
(a cost; §5).

## 1. Process standards (the tenant's certification, Tessera's support)

| Standard | Asks of an LSP (summary) | Tessera today | Gap → card |
| -------- | ------------------------ | ------------- | ---------- |
| **ISO 17100:2015** (+ Amd 1:2017), translation services | Documented competences and qualifications for translators and revisers, with evidence kept; a translation process of translation, the translator's own check, **revision by a second person** (mandatory), then optional review and proofreading, then final verification and release; project records kept; confidentiality; client feedback handled. Raw machine output with post-editing is outside its scope. | Roster with language pairs and specialties (`.ctv`), assignment lifecycle ending in a PM's `reviewed` gated by blocking QA (`reviewAssignment`), audit log of every write with a named actor, tenant isolation and per-project grants. No reviser role, no segment-level revision, no competence evidence, no per-job process record. | Revision step: #171 (now also the ISO 17100 revision). Competence records: #334. Per-job process record: #335. |
| **ISO 18587:2017**, full post-editing of MT output | Full post-editing to a quality comparable to human translation; post-editor competences; the client agrees to MT use. | Draft engine off until the client consents per engine (`client_engine_consent`); a draft is a suggestion a person accepts (`acceptDraftSuggestion`), never a target; the accepted origin `mt_draft` is stored on the segment. | Per-job record must say whether MT drafts were used, so the tenant knows which standard the job falls under (#335). See §3 for the tension with the invisible engine. |
| **ISO 20771:2020**, legal translation | ISO 17100's process with stricter translator competences for legal work, confidentiality and records. | As ISO 17100. | Covered by the same two cards plus a `legal` specialty, which is free text today. |
| **ISO 11669:2024**, translation projects (general guidance) | Agree a structured specification per project (audience, purpose, terminology, style, deliverables) before work starts. Guidance, not certifiable. _Edition year unconfirmed._ | Project holds a language pair, client number, glossary and memory refs; no structured brief. | #148 (versioned style guide) is the nearest card; a structured project brief belongs with it when it is specified, not in a card of its own yet. |
| **ISO 5060:2024**, evaluation of translation output | An error typology with severities and a scoring method for judging a translation. | QA rules (`core/qa/rules.ts`) are checks, not an evaluation; no error-typed scoring. | Scoring half of #171. |

## 2. Format and code standards (conformance the software has)

| Standard | Where it applies | Tessera today |
| -------- | ---------------- | ------------- |
| **ISO 21720:2017** (XLIFF 2.0, OASIS) | Exchange of bilingual files | XLIFF 2.x read and written as a string, zero-edit byte-identical (`v1-spec.md` §3.8). Only hand-written fixtures; no real tool's file read. |
| **ISO/IEC 29500** (Office Open XML) | DOCX and PPTX | Roundtrip gate byte-identical; differential validation with the Open XML SDK in CI (`v1-spec.md` §3.7). |
| **ISO 30042:2019** (TBX) | Glossary exchange | **Missing.** Named and deferred in `smart-glossary-spec.md` §8. #336. |
| **ISO 639 / ISO 15924 / ISO 3166** via **BCP 47** (IETF RFC 5646) | Language tags | Language tags are BCP 47, split once by `primarySubtag` (`core/model/lang.ts`). |
| **ISO 4217** | Currency codes | Vendor ledger: three-letter code (`CHECK (length(currency) = 3)`), never converted. Portal shows `$` always: #327. A length check is not a code check; #327 should validate against the list. |
| **ISO 8601** | Timestamps in files and APIs | Timestamps written with `toISOString()` throughout `db` and the servers. |
| **ISO/IEC 40500:2012** (WCAG 2.0) | Accessibility of the web app | Not audited. #193 (accessibility audit of the grid). Public-sector clients (a target sector, compliance spec §6) commonly require it; their rules usually cite WCAG 2.1, which is newer than 40500. |

Not ISO, listed so nobody looks for them under ISO: **TMX** and **SRX** (LISA
standards, now maintained by ETSI), **MQM** (an industry framework that
ISO 5060's typology resembles), **EN 16931** (CEN, e-invoicing, Epic 13 #224).

## 3. Tension to resolve: the invisible engine and ISO 17100 / 18587

`translation-engine-spec.md` D3, D20, D41 make the draft engine invisible to
whoever does the work: no screen names an engine or shows a draft marker. A
certified LSP needs two things from that design:

- **The client must have agreed to MT use.** Met: consent is per client and
  per engine, and fails closed.
- **The LSP must know which jobs used MT**, because those are post-editing
  jobs (ISO 18587), not ISO 17100 translation. Met by the data
  (`mt_draft` origin, `ai.requested` events), not yet by any record a PM or
  auditor can read per job. The process-record card closes it **for the
  tenant's staff only**: the translator still sees no engine. Nothing in this
  register changes D3.

## 4. Gap cards filed

Filed 2026-11-02 as `Idea:` issues:

- #334, v2 (Ring 1): vendor competence records for ISO 17100 (which qualification route, the
  evidence, per pair and domain; reviser competence separately).
- #335, v2 (Ring 1): per-job process record for an auditor (translator, reviser, release
  sign-off, MT used or not, QA state at release), exported from the audit log
  and roster, never stored as a second copy.
- #336, v1: TBX (ISO 30042) import and export for `.ctg`.

And on existing cards: #171 carries the ISO 17100 revision step and the
ISO 5060 scoring; #327 the ISO 4217 code list; #193 WCAG / ISO/IEC 40500.

## 5. Open, for Louis

- **Buying the texts** of ISO 17100, 18587 and 5060 (and 30042 before the
  TBX card) before any card claims conformance (§0.1).
- **Whether the pilot LSP is or wants to be ISO 17100 certified.** If yes, the
  revision step (#171) stops being "Not before #157" and moves ahead.
- **Wording on the website** (#81): "built to support an ISO 17100 workflow"
  is defensible once the cards land; "ISO compliant" or "ISO certified" is not.
