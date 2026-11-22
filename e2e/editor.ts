/**
 * What the editor's functional tests share: signing in and opening a file of a project made
 * for one test, so no test relies on a project another created.
 */
import { fileURLToPath } from 'node:url';

import { expect, type Page } from '@playwright/test';

const FIXTURE = fileURLToPath(
  new URL('../fixtures/docx/prose-short.docx', import.meta.url),
);

/** The account serve.mjs created before the server started (playwright.config.ts). */
export function account(): { email: string; password: string } {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error('E2E_EMAIL and E2E_PASSWORD are not set');
  return { email, password };
}

/** Signs in through the login form and waits for the projects screen. */
export async function signIn(page: Page): Promise<void> {
  const { email, password } = account();
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Title')).toBeVisible();
}

/** Makes a project named `slug` holding the one fixture file, and stays on its page. */
export async function makeProject(page: Page, slug: string): Promise<void> {
  await page.getByLabel('Title').fill(`Keyboard ${slug}`);
  await page.getByLabel('Name its address').fill(slug);
  await page.getByLabel('Source language').fill('en');
  await page.getByLabel('Target language').fill('de');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${slug}$`));
  await page.locator('input[type=file]').first().setInputFiles(FIXTURE);
  await expect(page.getByRole('link', { name: 'prose-short.docx' })).toBeVisible();
}

/** Signs in and opens the one file of a project made for this test. */
export async function openEditor(page: Page, slug: string): Promise<void> {
  await signIn(page);
  await makeProject(page, slug);
  await page.getByRole('link', { name: 'prose-short.docx' }).click();
  // The row group, not the table's name: the test of the name is one test, not all of them.
  await expect(page.getByRole('rowgroup')).toBeVisible();
}

/** ProseMirror undoes a caret moved in the first 200 ms after it takes focus (CLAUDE.md). */
export const EDITOR_SETTLE_MS = 250;
