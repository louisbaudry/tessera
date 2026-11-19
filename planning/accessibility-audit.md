# Accessibility audit of the editor

**Dates:** 2026-11-19 (two passes) · **Issues:** #193 (the editor), #392 item 4 (the other
screens) · **Scope:** the editor screen (the grid, the target editor, the filter bar, the QA,
glossary and resources panels, the command palette and the three dialogs), then the screens a
member of staff signs in to (§5). Follow-ups: issue #391 (changes to behaviour) and issue #392
(what a session cannot check).

This is the record of one pass, made so the findings are not found twice. **It is not a
conformance evaluation and supports no accessibility statement**: one browser,
checked by script, with no assistive technology and no person who relies on one. The contrast
figure used (4.5:1 for text) is the commonly cited WCAG 2.x AA threshold; the standard's text
was not read for this pass, so nothing here cites a clause.

## 1. Method

Everything ran in headless Chromium against the built application and the real server, on a
project holding two fixtures from `fixtures/docx/` (358 and 18 segments), with targets typed
in to produce QA findings. Four checks, each a script:

1. **Keyboard only.** Tab pressed from the top of the page and from inside the editor, the
   focused element and whether it shows a focus ring recorded at each press; then each key a
   person would try on the grid (Enter, Space, arrows, F2), Escape from the editor, and Tab
   and Escape inside each dialog.
2. **Names.** The browser's own accessibility tree (the DevTools protocol's
   `Accessibility.getFullAXTree`), listing every control, landmark and table with an empty
   name; and the tree read as text for the grid, a row, the panels and each dialog.
3. **Contrast, both themes.** For every visible text node, the computed colour against the
   computed background (alpha and opacity composed), flagged under 4.5:1, or 3:1 for large
   text. Run with every panel open, with a segment open, and with each dialog open.
4. **Focus order.** Read from the Tab walk of check 1.

No accessibility-testing library was added: the checks are a few dozen lines against the
browser's own tree, and a new dependency needs its licence recorded first
(`planning/prior-art.md`).

## 2. Findings

`K` keyboard, `N` names and structure, `C` contrast. "Fixed" means in the pull request that
closed #193, with the test named.

| Id  | Finding                                                                                                                                                                                                                             | Outcome                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | A segment could be opened only by a mouse click on its target cell. On the focused grid, Enter, Space, the arrows and F2 did nothing. The one keyboard route was the command palette's two "go to" commands.                        | Fixed. Enter on the grid opens the first editable segment in view, or the one last left (`grid-entry.ts`). The grid is an explicit tab stop. `e2e/editor-keyboard.spec.ts`, `grid-entry.test.ts`.        |
| K2  | Escape closed the editor and left focus on the page body, so the next Tab began at the top of the page, twenty-five stops before the grid.                                                                                          | Fixed. Escape puts focus on the grid, and Enter returns to the same segment. `e2e/editor-keyboard.spec.ts`.                                                                                             |
| K3  | The four dialogs say `aria-modal="true"` and a mouse cannot click behind them, but Tab left each one after two to five presses, into the page behind. From there Escape no longer closed the dialog.                                | Fixed. Tab wraps inside the dialog (`focus-trap.ts`), in the palette, concordance, find-and-replace and add-term dialogs. `e2e/editor-keyboard.spec.ts`, `focus-trap.test.ts`.                          |
| K4  | With no segment open there is no key that moves from row to row.                                                                                                                                                                    | Left: issue #391.                                                                                                                                                                                       |
| K5  | Twenty-five Tab stops come before the grid; no skip link, and the top links are in no navigation landmark.                                                                                                                          | Fixed later (2026-11-19, §6): a skip link is the first tab stop and the top links are a navigation landmark named "Main". `e2e/editor-keyboard.spec.ts`. |
| N1  | The grid's table had no name, and its header row sat outside the element with `role="table"`, so the column headers belonged to no table. `aria-rowcount` and `aria-rowindex` did not count the header.                             | Fixed. One `role="table"` named "Segments" holds the header and the rows (a `rowgroup`); the header is row 1. `e2e/editor-keyboard.spec.ts`.                                                            |
| N2  | A segment's status was a glyph or a letter (a check mark, `D`, `T`, a padlock) whose meaning was only in a `title`. The QA count had an `aria-label` on an element with no role, which is not reliably read.                        | Fixed. Both are `role="img"` with the status or the count as the name; an unsaved segment says so. Seen in the accessibility tree ("1 Confirmed 2 QA error").                                           |
| N3  | Nothing is announced when a segment is confirmed, saved or changes status.                                                                                                                                                          | Left: issue #391.                                                                                                                                                                                       |
| N4  | The origin badge's meaning is only in a `title`.                                                                                                                                                                                    | Fixed later (§6): the badge is an image named by its meaning, as the status is. |
| N5  | Tags in a source cell are read as their visible text. Not judged.                                                                                                                                                                   | Left: issue #391.                                                                                                                                                                                       |
| N6  | The breadcrumb `nav` and the glossary panel's setup form had no name.                                                                                                                                                               | Fixed: "Breadcrumb" and "Choose a glossary". Seen in the accessibility tree.                                                                                                                            |
| C1  | Light theme: the confirmed mark (`#2f855a`) measured 4.23:1 on a striped row; white on the QA warning badge (`#b7791f`) 3.64:1, and that amber as text 3.39 to 3.64:1. The dark theme had no failure.                               | Fixed. `--status-confirmed` is `#2b7a53` and `--status-draft`/`--qa-warning` are `#93600f`, each at least 4.5:1 on every background it is drawn on. `theme-contrast.test.ts` holds both themes to it.   |
| C2  | A disabled primary button measures 3.11:1 (light) and 3.19:1 (dark).                                                                                                                                                                | Not changed: a disabled control is outside the contrast rule. Whether it is readable enough is a judgement of look: issue #392.                                                                         |

What was found sound and left alone: every focusable element showed a focus ring; every
control in the panels, the filter bar and the dialogs had a name; each dialog takes focus when
it opens and returns it to the editor when it closes; the source and target cells carry
`lang`; the command palette is a combobox over a listbox with the active option announced;
the target editor is a named textbox.

## 3. Not checked

Listed in issue #392: a real screen reader; zoom and reflow; Firefox and Safari. Screens not
audited by either pass: a vendor's job and payment screens, the two invitation pages, the chat
assistant's consent page, and the client portal's pages (a different application). The colours
changed for C1 have been seen in a screenshot only.

## 4. Rules this leaves

- A new dialog calls `keepFocusInside` from its `onKeyDown` (`web/src/focus-trap.ts`).
- A new colour token that carries text is added to `PAIRS` in `theme-contrast.test.ts` with
  the backgrounds it is drawn on.
- A badge whose meaning is a glyph, a letter or a colour gets `role="img"` and a name; a
  `title` alone is not a name.
- The grid's rows stay inside the one `role="table"`; `aria-rowindex` counts the header.
- A new screen that only some accounts have is added to `screenAllowed`
  (`web/src/screen-access.ts`), so the others are told and not shown an empty page.

## 5. The other screens (second pass, issue #392 item 4)

The same scripts, on the screens a member of staff reaches: sign-in, projects, a project's
page, memories, vendors, the pay run, staff, activity and account, each in both themes, on a
server holding one account, one project and two files. Lists that were empty on that data
(vendors, payables, connections) were audited empty: a row's own controls were not seen.

**Sound:** no contrast failure in either theme but disabled controls (C2, which also covers
the disabled link-style buttons at 2.6:1 light and 3.2:1 dark); every control had a name;
every tab stop was visible and showed a focus ring; the tables on the staff and activity
screens are named; the sign-in refusal is a `role="alert"`.

| Id  | Finding                                                                                                                                                                      | Outcome                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| O1  | Sign-in: pressing the button disables it while the request runs, so after a refusal focus was on the page body and the next Tab began at the top.                           | Fixed. Focus goes to the password field. `e2e/sign-in.spec.ts`.                                                      |
| O2  | Account: the table of editor keys had no name.                                                                                                                               | Fixed: "Editor keys".                                                                                                |
| O3  | No signed-in screen has a level-1 heading: each starts at level 2, and the product name in the banner is a link.                                                             | Left: issue #391. A change to every screen's heading and its styling.                                                |
| O4  | `#/payments` is the vendor's screen; a member of staff who opens that address gets an empty page with a breadcrumb. No link leads staff there.                              | Fixed later (§6): a screen that is not the account's says so and links home (`screen-access.ts`). `e2e/editor-keyboard.spec.ts`, `screen-access.test.ts`. |

Two things the scripts reported that were not faults, kept here so they are not chased again:

- **A `<form>` with no name is not a finding.** The browser's tree lists every form, but a form
  is a landmark only when it has a name, and most forms here are one of several on a screen
  with a heading of their own. The first pass named one (N6); that was harmless, not needed.
- **The Tab walk reported no focus ring on the pay run's two date fields.** Checked directly,
  each shows the browser's own ring. The walk read the style a moment too early; a "no ring"
  from it is checked by hand before it is believed.

## 6. Follow-ups that needed no decision (issue #391, 2026-11-19)

Three of the findings left for #391 were repairs, not choices, and were made:

- **K5.** The first tab stop of every signed-in screen is a skip link: "Skip to content", or
  on a file's screen "Skip to segments", which lands on the segment rows, where Enter opens
  one. It is a button, not a link with a `#` target, because the address is the route. The
  banner's links are one `nav` named "Main"; the breadcrumb stays its own.
- **N4.** A segment's origin badge is an image named by its meaning ("Fuzzy TM match, 87%
  (a draft to review)"), no longer a short text with a tooltip.
- **O4.** An address that belongs to another role (`#/payments` for staff, `#/tms` for a
  vendor, `#/staff` for a project manager) now says "This page is not part of your account"
  with a link home, where it rendered nothing. `screenAllowed` (`web/src/screen-access.ts`)
  states who has which screen; it explains, and is never the access check, which is the
  server's.

Still open on #391, because each is a choice: a row cursor or a "go to segment" command (K4),
what to announce (N3), how tags should be read (N5), and a level-1 heading on each screen
(O3: twelve screens whose heading styles are written per screen).

