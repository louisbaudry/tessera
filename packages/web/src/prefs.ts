/**
 * Per-viewer display preferences, in `localStorage` like the session
 * token (`session.ts`) and for the same reason it may fail: storage can
 * be absent or throw, and then the preference lasts as long as the page.
 */

import {
  DEFAULT_BINDINGS,
  parseBindings,
  sameCombo,
  SHORTCUT_ACTIONS,
  serializeBindings,
  type Combo,
  type ShortcutAction,
} from './shortcuts.js';
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

const RESOURCES_PANEL = 'cat-tool.resourcesPanel';

/** Whether the grid's Resources panel is open (backlog #114). */
export function loadResourcesPanel(): boolean {
  try {
    return localStorage.getItem(RESOURCES_PANEL) === '1';
  } catch {
    return false;
  }
}

export function saveResourcesPanel(open: boolean): void {
  try {
    if (open) localStorage.setItem(RESOURCES_PANEL, '1');
    else localStorage.removeItem(RESOURCES_PANEL);
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

const SHORTCUTS = 'cat-tool.shortcuts';

/**
 * The editor's key bindings (issue #193): the stored set, or the defaults when
 * nothing is stored, storage is absent, or the stored set fails any rule
 * (`parseBindings` falls back as a whole).
 */
export function loadShortcuts(): Record<ShortcutAction, Combo> {
  try {
    return parseBindings(localStorage.getItem(SHORTCUTS)).bindings;
  } catch {
    return parseBindings(null).bindings;
  }
}

/** Keeps a changed set for this browser; the defaults are stored as no value at all. */
export function saveShortcuts(bindings: Readonly<Record<ShortcutAction, Combo>>): void {
  try {
    if (SHORTCUT_ACTIONS.every((a) => sameCombo(bindings[a], DEFAULT_BINDINGS[a]))) {
      localStorage.removeItem(SHORTCUTS);
    } else {
      localStorage.setItem(SHORTCUTS, serializeBindings(bindings));
    }
  } catch {
    // Not persisted; the keys still change for this page.
  }
}
