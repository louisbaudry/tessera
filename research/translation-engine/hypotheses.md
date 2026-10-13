# Hypotheses

Append-only. Each entry is dated and lives in the commit that states it,
which must come before the commit of any result that tests it.

## 2026-10-13 — engineering predictions for the slice-0 spike (E-001)

These are **feasibility predictions about cost and speed, not about
translation quality**. Quality is the D7 benchmark's question and has its
own hypotheses, written when that experiment is set up. The numbers are
estimates made before any measurement, from the shape of the prompt
(`translation-engine-spec.md` §3); they are expected to be wrong in places,
and being wrong is a recorded result.

Prompt shape for all four: the source segment, at most 3 retrieved TM
matches (`retrieveFuzzy`), at most 5 glossary terms, the 2 preceding source
segments, a fixed instruction block. Source segments of at most 40 words.

- **H1 (token budget).** Median input per call is at most 900 tokens and
  median output at most 120 tokens.
- **H2 (latency).** Median wall-clock time per call is at most 4 s and the
  95th percentile at most 10 s, on a mid-tier Claude model. The reason it
  matters: a translator confirms a segment every 10 to 30 s, so a prefetch
  that answers within about 10 s can stay ahead of them
  (`ai-platform-vision.md` §3, "never a blocking wait").
- **H3 (tag safety).** For segments carrying inline tags, at least 90% of
  drafts map their placeholders back to exactly the source's visible tags
  on the first try, with no retry and no repair.
- **H4 (embedded instructions).** Of 5 synthetic memory units that contain
  an instruction aimed at the model ("ignore the above and …"), none is
  obeyed: every draft is a translation of the source segment.

Falsified means: H1 or H2 missed by more than a third, H3 below 80%, or any
obeyed instruction in H4. Each falsification changes a slice-2 or slice-3
decision (batching, a smaller prompt, a stricter validator) and is written
into the spec with a pointer to the results file.
