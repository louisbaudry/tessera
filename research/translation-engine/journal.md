# Journal

Append-only. Dated entries: what was done, decided, found, abandoned.

## 2026-10-13 — slice 0 begins

Done: opened the record (this folder), wrote the spike's setup (E-001) and
its four engineering predictions (H1–H4) before any run.

Found: the spike cannot run yet. The session has no Anthropic API key in
its environment (`ANTHROPIC_API_KEY` is not set), and a key is a credential
only Louis can provide. The language pair is also not named (spec D14),
which the spike needs only as a parameter, but the setup is not frozen until
it is filled in.

Decided: nothing new. No result exists, so nothing here is confirmatory.

## 2026-10-13 (later) — the pairs are named

Louis named the pairs: mostly EN to ES and EN to VI. Recorded in spec D14
and in E-001's setup, which is now frozen apart from the key. Decided: the
spike runs per pair and every hypothesis is tested per pair (stricter than
the single-run wording of 2026-10-13's hypotheses, which named no pair; the
hypotheses themselves are unchanged).

Found, from the repo and not measured: Vietnamese has no segmentation rules
(backlog #13a, open), which blocks a Vietnamese source but not EN to VI.
Whether DeepL translates into Vietnamese is unverified and is checked first
when the D7 benchmark is set up. Neither changes a hypothesis.

Still blocked: no API key in the environment.

## 2026-10-14 — correction

The 2026-10-13 (later) entry says Vietnamese has no segmentation rules and
that backlog #13a blocks a Vietnamese source. That was wrong: I read the
backlog card and a truncated look at `core/segment/rules.ts` and did not see
that `ko` and `vi` entries exist there (a first-pass abbreviation list).
Backlog #13a's text, written when they did not, is the stale part. What
holds: EN to VI needs no Vietnamese segmentation (the source is English), and
a Vietnamese source's boundaries are not yet earned from real failures.
Nothing measured is affected; no hypothesis changes. Spec D14 is corrected.

## 2026-10-15 — slice 2 built, nothing measured

Built `core/draft/` (backlog #134, spec D21 to D24): the engine seam, prompt
template `tessera-draft-v1`, the placeholder markup and the reply validation,
tested offline through a fake engine. No run, no result, nothing confirmatory.

Recorded for the spike: the system prompt's tag rules (markers `<tN>`,
`&lt;` for a literal bracket) are untested against any real model. If H-series
results show tag failures, read `validateDraft`'s refusal counts by reason
before changing the template, and bump `PROMPT_VERSION` when it changes.

Still blocked: no API key in the environment.
