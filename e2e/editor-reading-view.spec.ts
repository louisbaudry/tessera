/**
 * The editor's reading view (issue #172) in a real browser: it opens from the toolbar below
 * the grid, shows a translated sentence in the translation and the rest in the source, follows
 * an edit without a reload, and a sentence selected in it opens that segment in the grid.
 *
 * The project is this test's own (`editor.ts`).
 */
import { expect, test } from '@playwright/test';

import { EDITOR_SETTLE_MS, openEditor } from './editor.js';

test('the reading view shows the translation in context and jumps to a sentence', async ({
  page,
}) => {
  await openEditor(page, 'e2e-reading-view');
  await page.getByLabel('Reading view').check();
  const view = page.getByRole('region', { name: 'Reading view' });
  await expect(view).toBeVisible();
  // Nothing is translated yet: every sentence is shown in the source.
  await expect(view.locator('.reading-seg.untranslated').first()).toBeVisible();
  await expect(view.locator('.reading-seg:not(.untranslated)')).toHaveCount(0);

  await page.getByRole('rowgroup').focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Target' });
  await expect(editor).toBeFocused();
  await page.waitForTimeout(EDITOR_SETTLE_MS);
  await page.keyboard.type('Erster Satz.');
  await page.keyboard.press('Control+Enter');

  // The confirmed sentence is in the view as the translation, in the target's language.
  const translated = view.locator('.reading-seg:not(.untranslated)');
  await expect(translated).toHaveCount(1);
  await expect(translated).toHaveText('Erster Satz.');
  await expect(translated).toHaveAttribute('lang', 'de');

  // Selecting it opens that segment in the grid again.
  await page.keyboard.press('Escape');
  await translated.click();
  await expect(page.locator('.row.active')).toHaveAttribute('aria-rowindex', '2');
});
