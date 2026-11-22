/**
 * Every signed-in screen has one level-1 heading, its own title, and no heading level is
 * skipped under it (issue #391, audit O3, `planning/accessibility-audit.md` §10). Held in a
 * real browser because a screen is assembled from several components, each with headings of
 * its own: a member of staff's screens, the file's screen with its panels and a dialog open,
 * then a vendor's, one of them a job offered through the API.
 */
import { expect, type Page, test } from '@playwright/test';

import { makeProject, signIn } from './editor.js';

/** The heading levels inside the screen, in document order, and the level-1 texts. */
async function headings(page: Page): Promise<{ levels: number[]; titles: string[] }> {
  return page.locator('main').evaluate((main) => {
    const all = Array.from(main.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    return {
      levels: all.map((h) => Number(h.tagName.slice(1))),
      titles: all
        .filter((h) => h.tagName === 'H1')
        .map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim()),
    };
  });
}

/** One level-1 heading with this title, first, and each heading at most one level deeper. */
async function expectTitled(page: Page, title: string | RegExp): Promise<void> {
  await expect(page.locator('main').getByRole('heading', { level: 1 })).toHaveText(title);
  const { levels, titles } = await headings(page);
  expect(titles).toHaveLength(1);
  expect(levels[0]).toBe(1);
  levels.forEach((level, i) => {
    if (i > 0)
      expect(level, `heading ${i + 1} of ${levels.join(',')}`).toBeLessThanOrEqual(
        levels[i - 1]! + 1,
      );
  });
}

test("a member of staff's screens each have their title as the level-1 heading", async ({
  page,
}) => {
  await signIn(page);
  await expectTitled(page, 'Projects');
  await makeProject(page, 'e2e-headings');
  await expectTitled(page, /^Keyboard e2e-headings en . de$/);

  for (const [hash, title] of [
    ['#/tms', 'Memories'],
    ['#/vendors', 'Vendors'],
    ['#/payables', 'Pay run'],
    ['#/staff', 'Staff'],
    ['#/audit', 'Activity'],
    ['#/account', 'Account'],
  ] as const) {
    await page.goto(`/${hash}`);
    await expectTitled(page, title);
  }
  // A request no client made: the screen still says what it is.
  await page.goto(
    `/#/connect?client_id=nobody&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=${'a'.repeat(43)}`,
  );
  await expectTitled(page, 'Connect a chat assistant');
});

test("the file's screen is titled by its file, with its panels and a dialog under it", async ({
  page,
}) => {
  await signIn(page);
  await makeProject(page, 'e2e-headings-file');
  await page.getByRole('link', { name: 'prose-short.docx' }).click();
  await expect(page.getByRole('rowgroup')).toBeVisible();
  await expectTitled(page, 'prose-short.docx');

  for (const label of ['QA panel', 'Glossary', 'Resources']) {
    await page.getByLabel(label, { exact: true }).check();
  }
  await expect(page.getByRole('heading', { name: 'Reference files' })).toBeVisible();
  await page.getByRole('rowgroup').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Shift+KeyL');
  await expect(
    page.getByRole('dialog', { name: 'Concordance' }).getByRole('heading', { level: 2 }),
  ).toHaveText('Concordance');
  await expectTitled(page, 'prose-short.docx');
});

test("a vendor's screens each have their title as the level-1 heading", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await makeProject(page, 'e2e-headings-job');
  // The vendor joins by the link the Vendors screen shows, as a person would.
  await page.goto('/#/vendors');
  await page.getByLabel('Email').fill('headings-vendor@example.test');
  await page.getByRole('button', { name: 'Create link' }).click();
  const link = await page.getByRole('textbox', { name: 'Invitation link' }).inputValue();

  const context = await browser.newContext();
  const vendor = await context.newPage();
  await vendor.goto(link);
  await vendor.getByLabel('Password', { exact: true }).fill('headings-vendor-password');
  await vendor.getByLabel('Repeat the password').fill('headings-vendor-password');
  await vendor.getByRole('button', { name: 'Set password and join' }).click();
  await expect(vendor.getByText('Nothing for you yet')).toBeVisible();
  await expectTitled(vendor, 'Your jobs');
  await vendor.goto('/#/payments');
  await expectTitled(vendor, 'Your payments');
  await vendor.goto('/#/account');
  await expectTitled(vendor, 'Account');

  // No screen offers a job yet: the API does. The newest vendor on the roster is ours.
  const offered = await page.evaluate(async () => {
    const headers = {
      authorization: `Bearer ${localStorage.getItem('cat-tool.session')}`,
      'content-type': 'application/json',
    };
    const roster = (await (await fetch('/api/vendors', { headers })).json()) as {
      vendors: Array<{ accountId: number }>;
    };
    const accountId = Math.max(...roster.vendors.map((v) => v.accountId));
    const res = await fetch('/api/assignments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project: 'e2e-headings-job',
        channel: 'direct',
        vendors: [accountId],
        instructions: 'Keep the headings short.',
      }),
    });
    return res.status;
  });
  expect(offered).toBe(201);

  // With a job in the feed its groups are the sections; the title is read and not drawn.
  await vendor.goto('/#/');
  await expect(vendor.getByRole('heading', { name: /Needs your answer/ })).toBeVisible();
  await expectTitled(vendor, 'Your jobs');
  await vendor.getByRole('link', { name: /e2e-headings-job/ }).click();
  await expect(vendor.getByRole('heading', { name: 'Instructions' })).toBeVisible();
  await expectTitled(vendor, /^e2e-headings-job /);
  await context.close();
});
