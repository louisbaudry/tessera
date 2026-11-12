/**
 * The first functional slice: signing in and making a project, through the
 * screens a translator or a PM uses, on the real server. Each test starts from
 * the same fresh database (serve.mjs), and the tests run in order on one server.
 */
import { expect, type Page, test } from '@playwright/test';

/** The account serve.mjs created before the server started (playwright.config.ts). */
function account(): { email: string; password: string } {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error('E2E_EMAIL and E2E_PASSWORD are not set');
  return { email, password };
}

/** Signs in through the login form, as a person does. */
async function signIn(page: Page): Promise<void> {
  const { email, password } = account();
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test('a wrong password is refused, and the right one opens the projects', async ({
  page,
}) => {
  const { email, password } = account();
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(`${password}-wrong`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tessera' })).toBeVisible();

  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});

test('a project is created and then listed and opened', async ({ page }) => {
  await signIn(page);

  await page.getByLabel('Title').fill('E2E first project');
  await page.getByLabel('Name its address').fill('e2e-first-project');
  await page.getByLabel('Source language').fill('en');
  await page.getByLabel('Target language').fill('de');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/#\/p\/e2e-first-project$/);

  await page.goto('/#/');
  await expect(page.getByRole('link', { name: 'E2E first project' })).toBeVisible();
  await page.getByRole('link', { name: 'E2E first project' }).click();
  await expect(page).toHaveURL(/#\/p\/e2e-first-project$/);
});
