/**
 * A vendor's time off (issue #156): set on their availability panel, kept, and shown to
 * the owner as a reason in the advisory "who fits this job" read, never as a refusal.
 * A vendor invited through the Vendors screen, as a person would be.
 */
import { expect, test } from '@playwright/test';

import { makeProject, signIn } from './editor.js';

const day = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test('a vendor plans time off, and the owner sees it against a job’s days', async ({
  page,
  browser,
}) => {
  await signIn(page);
  await makeProject(page, 'e2e-time-off');
  await page.goto('/#/vendors');
  await page.getByLabel('Email').fill('time-off-vendor@example.test');
  await page.getByRole('button', { name: 'Create link' }).click();
  const link = await page.getByRole('textbox', { name: 'Invitation link' }).inputValue();

  const context = await browser.newContext();
  const vendor = await context.newPage();
  await vendor.goto(link);
  await vendor.getByLabel('Password', { exact: true }).fill('time-off-vendor-password');
  await vendor.getByLabel('Repeat the password').fill('time-off-vendor-password');
  await vendor.getByRole('button', { name: 'Set password and join' }).click();
  await expect(vendor.getByText('None planned')).toBeVisible();

  await vendor.getByLabel('From').fill(day(5));
  await vendor.getByLabel('To').fill(day(8));
  await vendor.getByRole('button', { name: 'Add' }).click();
  const planned = vendor.getByRole('list', { name: 'Planned time off' });
  await expect(planned.getByRole('listitem')).toHaveCount(1);
  // Kept: it is there again after a reload.
  await vendor.reload();
  await expect(planned.getByRole('listitem')).toHaveCount(1);

  // The owner's advisory read: off during a job that runs past day 5, not one that ends before.
  const reasons = (deadline: string) =>
    page.evaluate(async (d) => {
      const headers = {
        authorization: `Bearer ${localStorage.getItem('cat-tool.session')}`,
      };
      const res = await fetch(
        `/api/vendors/eligibility?project=e2e-time-off&deadline=${d}`,
        { headers },
      );
      const body = (await res.json()) as {
        excluded: Array<{ reasons: string[] }>;
      };
      return body.excluded.flatMap((v) => v.reasons);
    }, deadline);
  expect(await reasons(day(6))).toContain('time_off');
  expect(await reasons(day(3))).not.toContain('time_off');

  // Removed by the vendor: no longer a reason.
  await vendor.getByRole('button', { name: /Remove time off/ }).click();
  await expect(vendor.getByText('None planned')).toBeVisible();
  expect(await reasons(day(6))).not.toContain('time_off');
  await context.close();
});
