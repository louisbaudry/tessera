# Multi-Session Agent Workflow

This document describes the approach used to implement complex, multi-phase features in this codebase using AI agents across multiple sessions.

It covers **phased** items only — the ones too big for one session. The ordinary case (one issue, one session, one PR) is CLAUDE.md's working rhythm; don't reach for this pattern when that one fits.

## Where state lives

Since the backlog was split into issues, three places carry three different things, and the handoff protocol below depends on not mixing them:

- **The GitHub issue** (one per open backlog entry, sub-issues per phase where an item is phased) — status, ordering, what is in flight. The only thing that changes constantly.
- **`planning/v1-backlog.md`** — the record of what shipped and what it taught. An entry gets rewritten once, when its work lands.
- **`planning/*-spec.md`** — the decision, written before or alongside the code.

The failure mode this replaces: marking phases DONE in markdown as the handoff signal. Two sessions then write status into the same file and conflict, and the board — which is what you actually look at — is the last thing to hear about it.

## Pattern

Large backlog items (particularly in Ring 0 and beyond) are broken into **phases**, each phase has **explicit scope**, and implementation happens **one phase per session** with deliberate handoff points. This keeps context manageable while allowing substantial work to accumulate across sessions.

### Backlog Item Structure

Each item in `planning/v1-backlog.md` includes:

- **Backlog #N: Title** — the feature or fix
- **Phase 1, Phase 2a, Phase 2b, etc.** — discrete, testable units
- **Dependencies** — which phases must complete before others
- **Spec reference** — the planning document that governs scope

Example: Backlog #18b (Native Trados `.sdltm` import) was split:

- **Phase 1** — Parser foundation: types, schema reverse-engineering, test fixtures
- **Phase 2a** — Parser function implementation: segment parsing, token conversion, database reading
- **Phase 2b** — Database integration & real-file validation: write parsed data to `.ctm`, validate against real exports

### Handoff Protocol

At the end of each session:

1. **Write the record into the backlog entry** — design decisions taken, known unknowns, bugs found. Not status: no "Phase 2a DONE" as a handoff signal, because the issue already says that.
2. **Document known unknowns explicitly** — if Phase 2a found that "tag ordering in segments is a simplification pending real-file validation," it goes in the backlog entry so Phase 2b doesn't rediscover it. This is the highest-value thing a session leaves behind.
3. **Open the PR with `Closes #NN`** in the body, naming this phase's issue (or sub-issue). On merge it closes the issue and moves its card, so the board stays true without anyone updating it by hand.
4. **Push the branch and stop.** No merge without an explicit go-ahead.
5. **If the next phase is now unblocked**, say so on its issue — a one-line comment, not a rewrite of the backlog.

When the next session starts, the agent:

1. **Reads the issue** — it names the phase, its constraints, and what is already decided
2. **Reads the backlog entry** — what the previous phases built and what they learned, including the known unknowns left deliberately open
3. **Reads the spec section** — `planning/tm-format-spec.md` §8a for `.sdltm`, for example
4. **Branches from `main`** — never from the previous session's branch. If the earlier phase is merged, `main` has it; if it isn't, that is a signal to merge it first, not to stack on it. Stacking is how `main` silently stopped being trunk once already, with a PR reading "closed unmerged" while its code was live on a session branch.
5. **Implements that one phase**

### Session Scope

**One session at a time on one area.** Every session writes its record into `planning/v1-backlog.md`, which makes that file a single point of contention by design. Two sessions working the same epic in parallel will conflict there, in entries neither of them was editing on purpose.

Each session's scope is **one phase, or a logical partition of a large phase**, not "as much as fits." This ensures:

- **Clear handoff points** — the next agent always knows where to start
- **Reviewable PRs** — one PR per phase means code review focuses on one concern
- **Shallow context depth** — by the end of the session, the agent can summarize what was done in text without needing the full implementation re-read next time

### Example: Backlog #18b Across Sessions

**Session 1 (Phase 1 — Foundation)**
- Reverse-engineer Trados `.sdltm` schema from one real file
- Define `ParsedSdltm`, `SdltmSegment`, `SdltmContextOccurrence` types
- Stub parser functions (signatures only)
- Create synthetic test database helper
- Commit: `8da5a4b Backlog #18b: Native .sdltm parser foundation (Phase 1)`
- Backlog: what the reverse-engineering found — schema cookie `0x2f`, `parameters.VERSION = 8.06`, one sample file only
- PR, reviewed, awaiting explicit merge go-ahead

**Session 2 (Phase 2a — Parser Implementation)**
- Implement `parseSdltmSegment()` — segment XML parsing
- Implement `sdltmSegmentToTokens()` — segment-to-tokens conversion
- Implement `parseSdltm()` — main database reader
- Write 9 comprehensive tests covering schema compatibility, unit extraction, context extraction
- Run full gate: typecheck, lint, test, build all pass
- Commit: `94cd966 Backlog #18b: Phase 2a implementation — native .sdltm parser functions`
- Backlog: what the parsers are and what they were tested against (synthetic data from the reverse-engineered schema, deliberately not the real file — Phase 2b needs that anyway)
- Known unknowns recorded for Phase 2b: Trados's context-hash algorithm, tag ordering, version-specific schema differences
- PR, merged after go-ahead

**Session 3 (Phase 2b — Database Integration)** — not started; tracked in an issue of the former private repository
- Create `packages/db/src/tm/import-sdltm.ts` — mirror `import-tmx.ts`
- Validate against real pseudonymised `.sdltm` files
- Document any schema differences by Trados version
- PR that closes that issue

Note what the issue carries that this document deliberately does not: whether Phase 2b has started, who is on it, and what is blocking it (here, a second real `.sdltm` to validate the one-sample schema against). Look there for state; look here for the shape of the work.

## Why This Pattern Works

1. **Cognitive load**: Each session tackles one phase, not a whole epic. The agent starts fresh, reads the spec, reviews the prior commits, and implements one piece.
2. **Reviewability**: One PR per phase means reviewers see the feature unfold deliberately, not all at once.
3. **Debuggability**: A bug found during Phase 2b validation can reference Phase 2a's specific design choice (tag ordering, for example) which is already documented in the backlog.
4. **Flexibility**: If Phase 2a reveals a problem with Phase 1's schema reverse-engineering, the team can decide to revise Phase 1 rather than pushing forward with bad assumptions.
5. **Traceability**: Every merge commit points back to a backlog entry, which points to a spec section, which grounds the decision.

## Coordination with Code Review

- **Phase PRs are not merged until explicitly approved.** No "auto-merge on green CI" — every merge is a deliberate go-ahead from the team.
- **Prefer merging the earlier phase before starting the later one.** The temptation is to stack Phase 2a on Phase 1's unmerged branch and keep going; that is exactly how trunk drifts, and it turns one review into a diff nobody can read in isolation. If a phase genuinely cannot wait, stack deliberately — the earlier phase merges first, the later branch then rebases onto `main` — and never let a third phase join the stack.
- **Backlog updates are part of the same commit/PR as the implementation**, not separate documentation PRs. The code and its summary live together.

## When to Use This Pattern

- Features with clear phasing and dependencies (TMX import, `.sdltm` import, exact matching)
- Work requiring real-world validation that can't complete without external data (TM format work, especially)
- Changes touching multiple packages or layers (core → db → server)
- Items with known unknowns that will only resolve after implementation (reverse-engineered formats)

## When Not to Use This Pattern

- Small bug fixes (one commit, one PR)
- Single-package refactors
- Configuration changes or tooling improvements
- Anything that fits in one, focused session

---

See `planning/v1-backlog.md` for the current state of all backlog items and their phases.
