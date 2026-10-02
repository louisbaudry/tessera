/**
 * The colour theme (backlog #35). The viewer's choice is `system`
 * (follow the OS, the default), `light` or `dark`; what the page wears
 * is always one of the last two, set as `data-theme` on the root so
 * `styles.css` has a single dark block, not a media query repeating it.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

/** A stored value back to a choice; anything unrecognised is `system`. */
export function parseThemeChoice(raw: string | null): ThemeChoice {
  return CHOICES.find((c) => c === raw) ?? 'system';
}

/** The toggle's next stop: system → light → dark → system. */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  return CHOICES[(CHOICES.indexOf(choice) + 1) % CHOICES.length]!;
}

/** What the page wears, given the choice and whether the OS prefers dark. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}

const QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** Put the resolved theme on the root element. */
export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice, systemPrefersDark());
}

/** Re-apply when the OS flips while the choice is `system`; returns the unsubscribe. */
export function followSystem(getChoice: () => ThemeChoice): () => void {
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia(QUERY);
  } catch {
    return () => {};
  }
  const onChange = () => {
    if (getChoice() === 'system') applyTheme('system');
  };
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
