/**
 * Per-viewer display preferences, in `localStorage` like the session
 * token (`session.ts`) and for the same reason it may fail: storage can
 * be absent or throw, and then the preference lasts as long as the page.
 */

import { parseThemeChoice, type ThemeChoice } from './theme.js';

const FULL_TAGS = 'cat-tool.fullTags';

/** Whether chips show their formatting in words (v1-spec.md §7.2). */
export function loadFullTags(): boolean {
  try {
    return localStorage.getItem(FULL_TAGS) === '1';
  } catch {
    return false;
  }
}

export function saveFullTags(on: boolean): void {
  try {
    if (on) localStorage.setItem(FULL_TAGS, '1');
    else localStorage.removeItem(FULL_TAGS);
  } catch {
    // Not persisted; the toggle still works for this page.
  }
}

const QA_PANEL = 'cat-tool.qaPanel';

/** Whether the grid's QA panel is open (backlog #33). */
export function loadQaPanel(): boolean {
  try {
    return localStorage.getItem(QA_PANEL) === '1';
  } catch {
    return false;
  }
}

export function saveQaPanel(open: boolean): void {
  try {
    if (open) localStorage.setItem(QA_PANEL, '1');
    else localStorage.removeItem(QA_PANEL);
  } catch {
    // Not persisted; the panel still opens for this page.
  }
}

const GLOSSARY_PANEL = 'cat-tool.glossaryPanel';

/** Whether the grid's glossary panel is open (backlog #43b). */
export function loadGlossaryPanel(): boolean {
  try {
    return localStorage.getItem(GLOSSARY_PANEL) === '1';
  } catch {
    return false;
  }
}

export function saveGlossaryPanel(open: boolean): void {
  try {
    if (open) localStorage.setItem(GLOSSARY_PANEL, '1');
    else localStorage.removeItem(GLOSSARY_PANEL);
  } catch {
    // Not persisted; the panel still opens for this page.
  }
}

const THEME = 'cat-tool.theme';

/** The colour theme choice (backlog #35); `system` when none is stored. */
export function loadTheme(): ThemeChoice {
  try {
    return parseThemeChoice(localStorage.getItem(THEME));
  } catch {
    return 'system';
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME);
    else localStorage.setItem(THEME, choice);
  } catch {
    // Not persisted; the theme still applies for this page.
  }
}
