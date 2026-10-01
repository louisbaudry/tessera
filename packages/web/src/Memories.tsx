/**
 * The account's memories (v1-spec.md §7.5): one `.ctm` each, shared by
 * every project that attaches it. Created empty, or imported whole from
 * a `.tmx` or Trados `.sdltm` the translator already has.
 */
import { slugify } from '@cat-tool/core/model';
import { useCallback, useState, type FormEvent } from 'react';

import { api } from './api.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function Memories() {
  const [version, setVersion] = useState(0);
  const memories = useLoad(
    // `version` reloads the list after a memory is made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useCallback((token, signal) => api.memories(token, signal), [version]),
  );
  return (
    <div className="page">
      <section className="list">
        <h2>Memories</h2>
        {memories.state === 'loading' && (
          <p className="muted">Loading memories{'\u2026'}</p>
        )}
        {memories.state === 'error' && <p className="error">{memories.message}</p>}
        {memories.state === 'done' &&
          (memories.data.length === 0 ? (
            <p className="muted">No memories yet.</p>
          ) : (
            <ul>
              {memories.data.map((m) => (
                <li key={m.slug}>
                  <span>{m.slug}</span>
                  <span className="muted">
                    {m.units.toLocaleString()} {m.units === 1 ? 'unit' : 'units'}
                    {m.langs.length > 0 ? ` \u00B7 ${m.langs.join(' ')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </section>
      <NewMemory onMade={() => setVersion((v) => v + 1)} />
    </div>
  );
}

function NewMemory({ onMade }: { onMade: () => void }) {
  const [name, setName] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  // A new file input after each memory made, so it shows none chosen.
  const [made, setMade] = useState(0);
  const action = useAction();
  // Null until edited: the name follows the file chosen.
  const slug = name ?? (file ? slugify(file.name.replace(/\.[^.]*$/, '')) : '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const memory = await action.run((token) =>
      api.createMemory(token, slug, file ?? undefined),
    );
    if (!memory) return;
    setWarnings(memory.warnings);
    setName(null);
    setFile(null);
    setMade((n) => n + 1);
    onMade();
  };

  return (
    <form className="panel form" onSubmit={(e) => void submit(e)}>
      <h2>New memory</h2>
      <label>
        Import from <span className="hint">optional: a .tmx or Trados .sdltm</span>
        <input
          type="file"
          accept=".tmx,.sdltm"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          key={made}
        />
      </label>
      <label>
        Name
        <input
          value={slug}
          onChange={(e) => setName(e.target.value)}
          pattern="[a-z0-9](?:[a-z0-9\-]{0,62}[a-z0-9])?"
          title="lowercase letters, digits and hyphens"
          required
        />
      </label>
      {action.error && (
        <p className="error" role="alert">
          {action.error}
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="warning">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div>
        <button type="submit" disabled={action.busy}>
          {action.busy
            ? file
              ? 'Importing\u2026'
              : 'Creating\u2026'
            : file
              ? 'Import'
              : 'Create empty memory'}
        </button>
      </div>
    </form>
  );
}
