/**
 * Per-viewer display preferences, in `localStorage` like the session
 * token (`session.ts`) and for the same reason it may fail: storage can
 * be absent or throw, and then the preference lasts as long as the page.
 */

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
