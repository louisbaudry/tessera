/**
 * The editor used with the keyboard alone (issue #193, `planning/accessibility-audit.md`):
 * the fixes the audit made, held in a real browser. A segment opens from the grid with
 * Enter, Escape hands focus back to the grid at the same segment, a dialog keeps Tab inside
 * it, and the grid is one named table with its header.
 *
 * It makes its own project, so it relies on nothing the sign-in tests created.
 */
import { fileURLToPath } from 'node:url';

import { expect, type Page, test } from '@playwright/test';

const FIXTURE = fileURLToPath(
  new URL('../fixtures/docx/prose-short.docx', import.meta.url),
);

/** Signs in and opens the one file of a project made for this test. */
async function openEditor(page: Page, slug: string): Promise<void> {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error('E2E_EMAIL and E2E_PASSWORD are not set');
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Title').fill(`Keyboard ${slug}`);
  await page.getByLabel('Name its address').fill(slug);
  await page.getByLabel('Source language').fill('en');
  await page.getByLabel('Target language').fill('de');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${slug}$`));
  await page.locator('input[type=file]').first().setInputFiles(FIXTURE);
  await page.getByRole('link', { name: 'prose-short.docx' }).click();
  // The row group, not the table's name: the test of the name is one test, not all three.
  await expect(page.getByRole('rowgroup')).toBeVisible();
}

/** ProseMirror undoes a caret moved in the first 200 ms after it takes focus (CLAUDE.md). */
const EDITOR_SETTLE_MS = 250;

test('the grid is one named table that holds its header', async ({ page }) => {
  await openEditor(page, 'e2e-keyboard-table');
  const table = page.getByRole('table', { name: 'Segments' });
  await expect(table.getByRole('columnheader')).toHaveCount(3);
  await expect(table.getByRole('row').first()).toHaveAttribute('aria-rowindex', '1');
  // The first segment is the table's second row.
  await expect(table.getByRole('row').nth(1)).toHaveAttribute('aria-rowindex', '2');
});

test('Enter opens a segment from the grid, and Escape returns to it', async ({
  page,
}) => {
  await openEditor(page, 'e2e-keyboard-entry');
  const rows = page.getByRole('rowgroup');
  const editor = page.getByRole('textbox', { name: 'Target' });

  await rows.focus();
  await expect(editor).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await page.waitForTimeout(EDITOR_SETTLE_MS);
  await page.keyboard.type('Erster Satz');

  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  // Focus is on the row that was left: the cursor's row, inside the rows.
  await expect(page.locator('.row.cursor')).toBeFocused();

  // Scrolled away or not, Enter comes back to the segment that was left.
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('Erster Satz');
  await expect(page.locator('.row.active')).toHaveAttribute('aria-rowindex', '2');
});

test('a dialog keeps Tab inside it and Escape closes it', async ({ page }) => {
  await openEditor(page, 'e2e-keyboard-dialog');
  await page.getByRole('rowgroup').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Target' })).toBeFocused();

  await page.keyboard.press('Control+Shift+KeyL');
  const dialog = page.getByRole('dialog', { name: 'Concordance' });
  await expect(dialog).toBeVisible();
  const inside = () =>
    page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
  // More presses than the dialog has controls, both ways.
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    expect(await inside()).toBe(true);
  }
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Target' })).toBeFocused();
});

test('the first Tab offers a way past the banner, to the segments', async ({ page }) => {
  await openEditor(page, 'e2e-keyboard-skip');
  // From the top of the page, as someone arriving with the keyboard: after a click the
  // browser starts its Tab order from where the click was, so the page is loaded afresh.
  await page.reload();
  await expect(page.getByRole('rowgroup')).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('button', { name: 'Skip to segments' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('rowgroup')).toBeFocused();
  // And from there one key opens a segment.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Target' })).toBeFocused();
});

test('the banner links are a named landmark, and a screen of another role says so', async ({
  page,
}) => {
  await openEditor(page, 'e2e-keyboard-nav');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Account' }),
  ).toBeVisible();
  // The vendor's payments screen, opened by a member of staff: a message, not an empty page.
  await page.goto('/#/payments');
  await expect(page.getByRole('status')).toContainText('not part of your account');
  await page.getByRole('link', { name: 'Go to the first page' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});

test('the arrow keys move a row cursor, and Enter opens the row it is on', async ({
  page,
}) => {
  await openEditor(page, 'e2e-keyboard-cursor');
  const rows = page.getByRole('rowgroup');
  const editor = page.getByRole('textbox', { name: 'Target' });
  const cursorRow = page.locator('.row.cursor');

  await rows.focus();
  await expect(cursorRow).toHaveCount(0);
  // The first press shows the cursor on the first row in view; the next two move it.
  await page.keyboard.press('ArrowDown');
  await expect(cursorRow).toHaveAttribute('aria-rowindex', '2');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(cursorRow).toHaveAttribute('aria-rowindex', '4');
  // The cursor's row holds the keyboard focus, which is how a screen reader learns of it.
  await expect(cursorRow).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await expect(page.locator('.row.active')).toHaveAttribute('aria-rowindex', '4');
  await expect(cursorRow).toHaveCount(0);

  // Leaving puts the cursor on the segment left, and the arrows carry on from it.
  await page.keyboard.press('Escape');
  await expect(cursorRow).toHaveAttribute('aria-rowindex', '4');
  await expect(cursorRow).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(cursorRow).toHaveAttribute('aria-rowindex', '3');
  await page.keyboard.press('End');
  await expect(cursorRow).toHaveAttribute('aria-rowindex', '19');
  await page.keyboard.press('Home');
  await expect(cursorRow).toHaveAttribute('aria-rowindex', '2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.row.active')).toHaveAttribute('aria-rowindex', '2');
});

test('the cursor keys are left alone while a segment is open', async ({ page }) => {
  await openEditor(page, 'e2e-keyboard-open');
  const rows = page.getByRole('rowgroup');
  await rows.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Target' });
  await expect(editor).toBeFocused();
  await expect(page.locator('.row.active')).toHaveAttribute('aria-rowindex', '2');

  // Focus goes back to the rows with the segment still open (Shift+Tab does this).
  await rows.focus();
  await expect(editor).toHaveCount(1);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  // No hidden cursor moved, so no other segment opened.
  await expect(page.locator('.row.active')).toHaveAttribute('aria-rowindex', '2');
  await expect(page.locator('.row.cursor')).toHaveCount(0);
});
