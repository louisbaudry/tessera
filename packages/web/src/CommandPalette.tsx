/**
 * The editor's command palette (backlog #115; issue #175): `Ctrl+K` (Cmd+K on a
 * Mac) opens a box that finds any editor command by what it is called, so a
 * translator does not hunt the toolbar or remember a key. What a query finds and
 * how the highlight moves are `commands.ts`'s; what a command does is the grid's,
 * handed in as `run`. A dialog with a combobox over a listbox, so it is reachable
 * from the keyboard alone and named for a screen reader.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { clampActive, filterCommands, moveActive, type CommandInfo } from './commands.js';

export interface PaletteCommand extends CommandInfo {
  readonly run: () => void;
}

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: readonly PaletteCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const found = useMemo(() => filterCommands(commands, query), [commands, query]);
  const active = clampActive(highlighted, found.length);

  // Focus goes to the box on open, and back to where it was when the palette closes.
  useEffect(() => {
    const before = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  // The highlighted row stays in view while the arrow keys move it.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    // After the palette has handed focus back, so a command that moves focus wins.
    queueMicrotask(command.run);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted(moveActive(active, 1, found.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted(moveActive(active, -1, found.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(found[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={found[active] ? `${id}-${found[active].id}` : undefined}
          aria-label="Type a command"
          placeholder="Type a command"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlighted(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul id={`${id}-list`} role="listbox" aria-label="Commands" ref={listRef}>
          {found.map((command, i) => (
            <li
              key={command.id}
              id={`${id}-${command.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseMove={() => setHighlighted(i)}
              onClick={() => choose(command)}
            >
              <span>{command.title}</span>
              {command.hint && <kbd>{command.hint}</kbd>}
            </li>
          ))}
          {found.length === 0 && (
            <li className="palette-empty" role="presentation">
              No command matches.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
