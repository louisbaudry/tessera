# Accessibility audit of the editor

**Dates:** 2026-11-19 (the passes), 2026-11-22 (the three choices of §10) · **Issues:** #193
(the editor), #392 item 4 (the other screens) · **Scope:** the editor screen (the grid, the
target editor, the filter bar, the QA, glossary and resources panels, the command palette and
the three dialogs), then the screens a member of staff signs in to (§5). Follow-ups: issue #391
(changes to behaviour, all settled: §6, §9, §10) and issue #392 (what a session cannot check).

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
| K4  | With no segment open there is no key that moves from row to row.                                                                                                                                                                    | Fixed later (2026-11-19, §9): the arrow keys move a row cursor and Enter opens its row. `e2e/editor-keyboard.spec.ts`, `grid-entry.test.ts`. |
| K5  | Twenty-five Tab stops come before the grid; no skip link, and the top links are in no navigation landmark.                                                                                                                          | Fixed later (2026-11-19, §6): a skip link is the first tab stop and the top links are a navigation landmark named "Main". `e2e/editor-keyboard.spec.ts`. |
| N1  | The grid's table had no name, and its header row sat outside the element with `role="table"`, so the column headers belonged to no table. `aria-rowcount` and `aria-rowindex` did not count the header.                             | Fixed. One `role="table"` named "Segments" holds the header and the rows (a `rowgroup`); the header is row 1. `e2e/editor-keyboard.spec.ts`.                                                            |
| N2  | A segment's status was a glyph or a letter (a check mark, `D`, `T`, a padlock) whose meaning was only in a `title`. The QA count had an `aria-label` on an element with no role, which is not reliably read.                        | Fixed. Both are `role="img"` with the status or the count as the name; an unsaved segment says so. Seen in the accessibility tree ("1 Confirmed 2 QA error").                                           |
| N3  | Nothing is announced when a segment is confirmed, saved or changes status.                                                                                                                                                          | Built later (2026-11-22, §10): a confirmation gained, lost or refused is said in a live region, a plain save is not. `announce.test.ts`, `e2e/editor-announcements.spec.ts`.                             |
| N4  | The origin badge's meaning is only in a `title`.                                                                                                                                                                                    | Fixed later (§6): the badge is an image named by its meaning, as the status is. |
| N5  | Tags in a source cell are read as their visible text. Not judged.                                                                                                                                                                   | Not changed (2026-11-22, §10): which reading is right is for someone who translates with a screen reader to say. Carried on issue #392, item 1.                                                         |
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
audited by any pass: a vendor's job screen (it needs an offered job), the staff invitation
page, the page for a vendor who already has an account, and the chat assistant's consent page.
The client portal (§7) and the vendor's other screens (§8) were audited later. The colours
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
- A screen's title is its one `<h1>` and its sections are `<h2>`: no level is skipped. A new
  screen is added to `e2e/screen-headings.spec.ts`. A title's size is written in the
  stylesheet (`.screen h1`, or the screen's own rule), never left to the browser.
- What the editor says aloud about a write is decided in `web/src/announce.ts` and goes
  through the grid's two regions, which are in the page before anything is said. A new live
  region is never added with its text already in it.

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
| O3  | No signed-in screen has a level-1 heading: each starts at level 2, and the product name in the banner is a link.                                                             | Built later (2026-11-22, §10): each screen's title is its level-1 heading. `e2e/screen-headings.spec.ts`.            |
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

Still open on #391 at that date, because each is a choice: what to announce (N3), how tags
should be read (N5), and a level-1 heading on each screen (O3: twelve screens whose heading
styles are written per screen). K4 was built afterwards (§9), and the three choices were made
on 2026-11-22 (§10).

## 7. The client portal (third pass, issue #392, 2026-11-19)

The portal is a different application (`packages/portal-server/src/public/`: two pages, plain
scripts, one stylesheet, no dark theme). Same scripts, on a throwaway portal with one seeded
client: the client's page with and without its link, an order placed through the form, the
admin's sign-in, order list, an order's page, deadlines, clients and rates.

**Sound:** no contrast failure but a disabled button (C2); each page has a language, a title,
one level-1 heading and a `main`; every tab stop showed a focus ring; the admin's forms wrap
their fields in their labels.

| Id  | Finding                                                                                                                                                                                       | Outcome                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **The client's order form**: its five labels (source language, target languages, update of, files, notes) sat beside their fields and were tied to none, so each field was announced unnamed. | Fixed: each label names its field. `public-labels.test.ts`.                                                                     |
| P2  | **The admin's order lists** (all orders, deadlines): a row opened on a mouse click alone, so an order could not be opened from the keyboard at all.                                           | Fixed: the order number is a button ("Open order N"); the row stays clickable. Opened by keyboard in a browser, and the test.   |
| P3  | No error message on either page was announced: sixteen `p.error` elements, none a live region.                                                                                                | Fixed: each is `role="alert"`. The refused admin sign-in was seen as an alert in a browser.                                     |
| P4  | Admin, an order's page: the word-count label named no field, "Status" was a label over a row of buttons, the per-file counts and the delivery's file field had no name.                       | Fixed: the label names the field, the buttons are a group named "Status", the counts are "Words in <file>", the file field named. |
| P5  | The portal's tables have header cells and no name, and its forms no name. A heading stands before each.                                                                                       | Not changed: see the note on unnamed forms in §5; the same holds for a table under its heading.                                 |
| P6  | Neither page sets a viewport, so a phone shows the desktop layout small.                                                                                                                      | Left: issue #392 (zoom and reflow). Not measured.                                                                               |

`public-labels.test.ts` reads the two scripts' text and fails on a label that names no field,
an error that is not an alert, or an order row with no control. It holds the shape only: what
a browser makes of it was seen once, by the script, and by no screen reader.

## 8. The vendor's screens and the invitation page (fourth pass, issue #392, 2026-11-19)

The same scripts, on a vendor invited through the Vendors screen: the invitation page a new
vendor sets a password on, then as that vendor the jobs list (empty, with the availability
control), the payments record (empty), the account screen, and a staff address (`#/tms`).
Both themes.

**Nothing to fix.** No contrast failure but disabled buttons (C2); every control named; every
tab stop visible with a focus ring; the invitation page has a level-1 heading and labelled
fields; the availability buttons say which is pressed. The staff address shows the vendor the
message of §6 ("This page is not part of your account") with its link home, which until now
only a unit test had shown for a vendor.

The lists were empty, so a job's row and an offered job's screen were not seen.

## 9. The row cursor (issue #391, finding K4, 2026-11-19)

Louis was offered a row cursor or a "go to segment number" command and passed over the
question, so the recommendation was built; a command can still be added, and the cursor is
one function and a few lines of wiring to take out.

With the segment rows focused and no segment open, Down and Up move a cursor one row, Page
Down and Page Up ten, Home and End to the ends (`moveCursor`, `web/src/grid-entry.ts`). The
first press shows the cursor on the first row in view, so it appears where the person is
looking. Enter opens the row it is on; a locked row can hold the cursor (it is for reading
too) and does not open. Leaving a segment with Escape puts the cursor on it. The cursor's row
takes real keyboard focus (each row is focusable and none is a tab stop), which is how a screen
reader learns where the cursor is; the cursor is an inset ring on that row, and the list
scrolls to keep it in view (seen on a file of 358 segments: End reaches the last row, in view).
While a segment is open the cursor keys are left alone: the cursor is hidden then, and moving
it would scroll the open editor away.

What it costs: with the rows focused, the arrow keys no longer scroll the list by themselves;
they move the cursor, and the list follows. The mouse wheel and the scrollbar are unchanged.
Stack: TypeScript, like the grid it is part of.

Two things the automated review of the change caught, both real. The first version named the
cursor's row with `aria-activedescendant` on the rows' `rowgroup`, a role that does not support
it, so it would have told a screen reader nothing while a test happily read the attribute's
value: the test checked what was written, not what it does. And with a segment open and focus
back on the rows, the arrow keys moved a cursor nobody could see.

Not verified: how a screen reader reads a row that takes focus this way. No assistive
technology was run.

## 10. The three choices left on issue #391 (2026-11-22)

Each was a choice, not a repair. They were made in the session, not by Louis: each is cheap
to reverse (one module, or one rule of the stylesheet), and the reasoning is here so that any
of them can be overturned.

### N3: what is announced

**A confirmation is what gets said: gained, lost or refused, and any write that failed.**
The wording and the rule are one pure module, `web/src/announce.ts`.

| What happened                                                   | What is said                                             | Where                |
| --------------------------------------------------------------- | -------------------------------------------------------- | -------------------- |
| The server answered a confirm                                   | "Segment 12 confirmed." or "…, with 2 QA findings."       | polite (`status`)    |
| A save took a confirmed segment out of `confirmed` (an edit)    | "Segment 12 is no longer confirmed."                     | polite (`status`)    |
| A save, a confirm or the taking of a draft failed               | "Segment 12: Not confirmed: …" (the row's own message)   | assertive (`alert`)  |
| Any other save; a draft taken                                   | nothing                                                  |                      |

- **A plain save is silent.** One goes every time a segment is left; the row's status is
  already its name (N2), and the absence of an alert is the news. An announcement per save
  would bury the three that matter.
- **A confirm is said when the server answers, not when the key is pressed.** Until then it
  is a request, and a refusal may follow. By then the next segment is open, so the sentence
  names the segment it is about.
- **The QA findings a confirm leaves are part of the sentence**, as a count: that count is
  what appears in the gutter next, and it is the one thing a confirm changes that the
  translator may have to act on. Nothing is said about QA when it did not rerun (a project in
  deferred QA).
- **Losing a confirmation is said**, because it is a consequence the person did not ask for:
  they edited a segment, and the edit also took its confirmation away. Not when a confirm
  follows the save (Ctrl+Enter on an edited, confirmed segment), where the confirm's answer
  is the last word: the save queue now says which request an answer is for and whether a
  confirm still waits (`pending`).
- **Two regions, both in the page from the moment the file opens**, at the end of the grid's
  section, read and not drawn. Only their text changes: a region inserted with its text
  already in it is not reliably read. The same words twice in a row are a new node, and an
  announcement is removed after seven seconds, so that someone reading the page later does
  not meet a stale sentence.
- **Not changed:** the note beside the file's name (a refused merge or split, "No QA finding
  below") is still a `role="status"` element added with its text. Whether it is read was not
  checked, so it was not moved either.

Tests: `announce.test.ts` (the rule), `save-queue.test.ts` (which request an answer is for),
`e2e/editor-announcements.spec.ts` (the regions, in a real page, get the text when the server
answers; a plain save leaves them empty). Each was seen to fail against the code before the
change, and the silent-save rule was broken on purpose to see its own tests fail.

**Not verified, and it matters here more than anywhere:** no screen reader was run. Whether
the polite sentence is heard after the next segment's field is read or lost behind it, and
whether one sentence per confirm is welcome to someone who confirms hundreds of segments in
a sitting, are for a person who uses one to say (issue #392, item 1).

### N5: how tags are read (closed without a change)

A tag in a source cell is read as its visible text: `‹1 … 1›`, or `‹1 bold … bold 1›` with
full tags on. The alternatives are to name each chip in words ("tag 1, bold, start"), or to
hide the chips from a screen reader and say only that the segment has tags. Each trades
something: the first makes every tagged segment long to listen to, the second hides what a
translator must place. Which is right depends on how someone who translates with a screen
reader works, and nobody who does has been asked. A change made now would be a guess as
unjudged as what is there, and what is there has one property worth keeping: it is what a
sighted colleague sees, so the two can talk about "tag 1". The question is carried on issue
#392, item 1, with the target editor's tags, which are the same chips.

### O3: each screen's title is its level-1 heading

**The screen's title, not the banner's name.** A level-1 heading that says "Tessera" on
every screen says nothing about where one is; the title is the thing that differs, and it is
what the skip link lands before.

- The twelve screens: projects (and a vendor's jobs), a project, a file, a job, memories,
  vendors, the pay run, payments, staff, activity, account and the chat assistant's consent
  page. Each title moved from level 2 to level 1.
- **No level is skipped under it.** Where a screen's sections were level 3 (staff, vendors
  and their webhooks, account and its editor keys, a job), they are level 2 now. On a file's
  screen the panels' groups and the three dialogs' titles are level 2 too.
- **A file's screen is titled by its file**: the bold name beside the progress line became
  the heading.
- **A vendor's feed with jobs in it shows no title**, only its groups. Its level-1 heading,
  "Your jobs", is read and not drawn there, so the screen looks as it did. The empty feed
  already showed that title.
- **Nothing looks different.** A script recorded every heading's computed size, weight,
  margins and position on twenty-six screen states (staff and vendor, the panels and each
  dialog open, a fresh invitation link, an offered job) before and after: identical but for
  the level. Each title's size is now written in the stylesheet (`.screen h1`, or the
  screen's own rule): a browser's own style for a level-1 heading is larger, and inside a
  `section` some browsers shrink it.

Test: `e2e/screen-headings.spec.ts` opens each of those screens in a browser, as staff and as
a vendor invited through the Vendors screen, and requires one level-1 heading with the
screen's title, first, and no skipped level. Seen to fail on the code before the change.

**Not covered:** the one-sentence message of a screen that is not the account's (§6) and the
"Loading…" line of a screen still waiting for its data have no heading. The sign-in and
invitation pages already had one ("Tessera": they have no other title). One viewport, one
browser, no screen reader.
