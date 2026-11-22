/**
 * What the editor says to a screen reader about a write (issue #391, audit N3,
 * `planning/accessibility-audit.md` §10): a confirmation gained, lost or refused is put in
 * a live region, and a save that changes none of that is not. The wording is tested in node
 * (`announce.test.ts`); this holds that the regions exist in a real page and get the text
 * when the server answers. No screen reader is run: what one makes of it is not seen here.
 */
import { expect, type Page, test } from '@playwright/test';

import { EDITOR_SETTLE_MS, openEditor } from './editor.js';

/** Opens the first segment from the grid and types a target into it. */
async function typeInFirstSegment(page: Page, text: string): Promise<void> {
  await page.getByRole('rowgroup').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Target' })).toBeFocused();
  await page.waitForTimeout(EDITOR_SETTLE_MS);
  await page.keyboard.type(text);
}

test('a confirm is announced, and so is the edit that undoes it', async ({ page }) => {
  await openEditor(page, 'e2e-announce-confirm');
  // Both regions are in the page before anything is said: a region added with its text
  // already in it is not reliably read.
  const said = page.locator('.grid > [role="status"]');
  const alerted = page.locator('.grid > [role="alert"]');
  await expect(said).toHaveCount(1);
  await expect(alerted).toHaveCount(1);
  await expect(said).toBeEmpty();

  await typeInFirstSegment(page, 'Erster Satz.');
  await page.keyboard.press('Control+Enter');
  await expect(said).toHaveText(/^Segment 1 confirmed(, with \d+ QA findings?)?\.$/);
  await expect(alerted).toBeEmpty();
  // The next segment opened meanwhile: the announcement names the one that was confirmed.
  await expect(page.locator('.row.active')).toHaveAttribute('aria-rowindex', '3');

  // Back to the first segment and change it: it is confirmed no more, which the row's badge
  // shows and the region says.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.locator('.row.active')).toHaveAttribute('aria-rowindex', '2');
  await page.waitForTimeout(EDITOR_SETTLE_MS);
  await page.keyboard.type(' Mehr.');
  await page.keyboard.press('Escape');
  await expect(said).toHaveText('Segment 1 is no longer confirmed.');
});

test('a save that changes no confirmation is not announced', async ({ page }) => {
  await openEditor(page, 'e2e-announce-quiet');
  const said = page.locator('.grid > [role="status"]');
  await typeInFirstSegment(page, 'Erster Satz.');
  await page.keyboard.press('Escape');
  // The save landed: the row says it is translated. Nothing was said about it.
  await expect(
    page.getByRole('row').nth(1).getByRole('img', { name: 'Translated' }),
  ).toBeVisible();
  await expect(said).toBeEmpty();
  await expect(page.locator('.grid > [role="alert"]')).toBeEmpty();
});

test('a refused confirm is announced as an alert, with its segment', async ({ page }) => {
  await openEditor(page, 'e2e-announce-refused');
  // The server's own refusal of a stale write, given here for the confirm alone.
  await page.route('**/segments/*/confirm*', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'the segment changed since it was loaded' }),
    }),
  );
  await typeInFirstSegment(page, 'Erster Satz.');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.grid > [role="alert"]')).toHaveText(
    'Segment 1: Not confirmed: the segment changed since it was loaded',
  );
  await expect(page.locator('.grid > [role="status"]')).toBeEmpty();
});
