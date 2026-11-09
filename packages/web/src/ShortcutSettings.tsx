/**
 * The editor's keys, listed and changeable (issue #193): one row per action with its
 * key, "Change" to wait for the next key press, "Reset" for one action and "Reset
 * all". Kept in this browser (`saveShortcuts`), never on the server, and read by the
 * grid when it opens, so a change applies from the next time a file is opened. The
 * rules, and what a key press means while waiting, are `shortcut-settings.ts`'s.
 */
import { useEffect, useState } from 'react';

import { loadShortcuts, saveShortcuts } from './prefs.js';
import {
  allDefault,
  captureOutcome,
  resetAction,
  shortcutRows,
} from './shortcut-settings.js';
import { resetBindings, SHORTCUT_TITLES, type ShortcutAction } from './shortcuts.js';

export function ShortcutSettings() {
  const [bindings, setBindings] = useState(loadShortcuts);
  // The action waiting for its next key press, and the last thing worth telling the person.
  const [listening, setListening] = useState<ShortcutAction | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (listening === null) return;
    // Capture phase and prevented, so the key chosen never also acts on the page
    // (Tab would move focus, Ctrl+K would open the browser's search).
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const outcome = captureOutcome(bindings, listening, e);
      if (outcome.kind === 'wait') return;
      setListening(null);
      if (outcome.kind === 'cancel') {
        setNote(null);
      } else if (outcome.kind === 'refused') {
        setNote({ text: outcome.reason, error: true });
      } else {
        setBindings(outcome.bindings);
        saveShortcuts(outcome.bindings);
        setNote({
          text: `${SHORTCUT_TITLES[listening]} saved. It applies when you next open a file.`,
          error: false,
        });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, bindings]);

  const reset = (action: ShortcutAction) => {
    const out = resetAction(bindings, action);
    if (out.ok) {
      setBindings(out.bindings);
      saveShortcuts(out.bindings);
      setNote({
        text: `${SHORTCUT_TITLES[action]} is back to its default.`,
        error: false,
      });
    } else {
      setNote({ text: out.reason, error: true });
    }
  };

  const resetAll = () => {
    const fresh = resetBindings();
    setBindings(fresh);
    saveShortcuts(fresh);
    setListening(null);
    setNote({ text: 'Every key is back to its default.', error: false });
  };

  return (
    <section className="shortcuts">
      <h3>Editor keys</h3>
      <p className="muted">
        Kept in this browser only. A key needs Ctrl, Alt or Meta, and the browser&apos;s
        and editor&apos;s own keys (copy, paste, undo, Esc) cannot be taken.
      </p>
      <table>
        <thead>
          <tr>
            <th>Action</th>
            <th>Key</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shortcutRows(bindings).map((row) => (
            <tr key={row.action}>
              <td>{row.title}</td>
              <td>
                {listening === row.action ? (
                  <em>Press the new key{'…'} (Esc to cancel)</em>
                ) : (
                  <>
                    <kbd>{row.keys}</kbd>
                    {row.alias !== null && (
                      <span className="muted"> or {row.alias} on a Mac</span>
                    )}
                  </>
                )}
              </td>
              <td className="actions">
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Change the key for ${row.title}`}
                  aria-pressed={listening === row.action}
                  onClick={() => {
                    setNote(null);
                    setListening(listening === row.action ? null : row.action);
                  }}
                >
                  {listening === row.action ? 'Cancel' : 'Change'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Reset the key for ${row.title}`}
                  disabled={row.isDefault}
                  onClick={() => reset(row.action)}
                >
                  Reset
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <button
          type="button"
          className="secondary"
          disabled={allDefault(bindings)}
          onClick={resetAll}
        >
          Reset all
        </button>
      </p>
      <div role={note?.error ? 'alert' : 'status'}>
        {note && <p className={note.error ? 'error' : undefined}>{note.text}</p>}
      </div>
    </section>
  );
}
