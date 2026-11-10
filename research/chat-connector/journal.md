# Journal

Append-only. Newest entry last.

## 2026-11-10 — folder opened, E-001 set up

- Louis chose "measure first" for the chat connector (`chat-connector-spec.md`
  O5). Card: issue #373.
- Wrote the harness (`harness/loop.mjs`): the draft loop of D8 as shell commands
  over the product's own `assembleXliff`, `markTokens` and `validateDraft`.
  Checked by hand that it accepts a valid draft and refuses a dropped tag
  (`tag_missing`) and a stray angle bracket (`malformed_markup`).
- The DOCX fixtures could not be the corpus: their words are synthetic
  pseudo-words (`fixtures/docx/README.md`), which no model can translate. The
  corpus is generated English sentences in an XLIFF file instead, so E-001 says
  nothing about a DOCX round trip; the roundtrip gate already covers that.
- No model key is available in this session, and a real chat host needs a hosted
  server and a person's account. The runs use an agent of this session's model as
  a stand-in, and E-001 says in its setup what that does not show.
- H1 to H4 and the setup are committed before any run.
