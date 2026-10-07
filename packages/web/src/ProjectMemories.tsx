/**
 * The memories a project consults, in order, and the one it confirms
 * into (v1-spec.md §7.5): attach, move, choose the write memory, detach,
 * and pre-translate from them. Every change is one server call answered
 * with the whole list, which replaces the one shown.
 */
import { useCallback, useState } from 'react';

import { api, type PretranslateSummary, type TmRefView } from './api.js';
import {
  thresholdChoice,
  thresholdText,
  type FuzzyThresholdView,
} from './fuzzy-threshold.js';
import { formatRoute } from './route.js';
import { moved } from './tm-order.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function ProjectMemories({ project }: { project: string }) {
  const loaded = useLoad(
    useCallback(
      (token, signal) =>
        Promise.all([
          api.projectMemories(token, project, signal),
          api.memories(token, signal),
          api.fuzzyThreshold(token, project, signal),
        ]),
      [project],
    ),
  );
  // What the last change answered, over what was loaded. Keyed by
  // project where it is rendered, so it never outlives its project.
  const [changed, setChanged] = useState<readonly TmRefView[] | null>(null);
  const action = useAction();
  const [attach, setAttach] = useState('');
  const [ran, setRan] = useState<PretranslateSummary | null>(null);
  // The fuzzy threshold: what the last save answered, and what is being typed.
  const [saved, setSaved] = useState<FuzzyThresholdView | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [fuzzyError, setFuzzyError] = useState<string | null>(null);

  if (loaded.state === 'loading')
    return <p className="muted">Loading memories{'\u2026'}</p>;
  if (loaded.state === 'error') return <p className="error">{loaded.message}</p>;

  const [{ refs: initial }, memories, loadedThreshold] = loaded.data;
  const fuzzy = saved ?? loadedThreshold;
  const refs = changed ?? initial;
  const ids = refs.map((r) => r.id);
  const attached = new Set(refs.map((r) => r.tm));
  const attachable = memories.filter((m) => !attached.has(m.slug));
  const choice = attachable.some((m) => m.slug === attach)
    ? attach
    : (attachable[0]?.slug ?? '');

  const change = async (write: (token: string) => Promise<{ refs: TmRefView[] }>) => {
    const answer = await action.run(write);
    if (answer) setChanged(answer.refs);
  };

  // Saves what was typed (or the off box), if it says something new.
  const saveThreshold = async (text: string, off: boolean) => {
    const parsed = thresholdChoice(text, off, fuzzy);
    if (!parsed.ok) {
      setFuzzyError(parsed.message);
      return;
    }
    setFuzzyError(null);
    const view = await action.run((t) =>
      api.setFuzzyThreshold(t, project, parsed.choice),
    );
    if (view) {
      setSaved(view);
      setTyped(null);
    }
  };
  const fuzzyOff = fuzzy.threshold === null;

  return (
    <section className="panel">
      <h2>Memories</h2>
      {refs.length === 0 ? (
        <p className="muted">No memory attached.</p>
      ) : (
        <ol className="memories">
          {refs.map((ref, i) => (
            <li key={ref.id}>
              <span className="memory-name">
                {ref.tm ?? (
                  <span className="muted">(attached outside your memories)</span>
                )}
              </span>
              <label className="write-target">
                <input
                  type="radio"
                  name="write-target"
                  checked={ref.writeTarget}
                  disabled={action.busy}
                  onChange={() =>
                    void change((t) => api.setWriteMemory(t, project, ref.id))
                  }
                />
                write
              </label>
              <span className="actions">
                <button
                  type="button"
                  className="link"
                  aria-label="Consult earlier"
                  disabled={action.busy || i === 0}
                  onClick={() => {
                    const order = moved(ids, ref.id, -1);
                    if (order) void change((t) => api.orderMemories(t, project, order));
                  }}
                >
                  {'\u2191'}
                </button>
                <button
                  type="button"
                  className="link"
                  aria-label="Consult later"
                  disabled={action.busy || i === refs.length - 1}
                  onClick={() => {
                    const order = moved(ids, ref.id, 1);
                    if (order) void change((t) => api.orderMemories(t, project, order));
                  }}
                >
                  {'\u2193'}
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={action.busy}
                  onClick={() => void change((t) => api.detachMemory(t, project, ref.id))}
                >
                  Detach
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {refs.length > 0 && !refs.some((r) => r.writeTarget) && (
        <p className="warning">
          No write memory: confirming a segment is refused until one is chosen.
        </p>
      )}
      <p className="hint">
        Consulted top first; on a tie between two exact matches the higher one wins.
      </p>

      {attachable.length > 0 ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (choice !== '')
              void change((t) =>
                api.attachMemory(t, project, choice, !refs.some((r) => r.writeTarget)),
              );
          }}
        >
          <select value={choice} onChange={(e) => setAttach(e.target.value)}>
            {attachable.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.slug} ({m.units.toLocaleString()} units
                {m.langs.length > 0 ? `, ${m.langs.join(' ')}` : ''})
              </option>
            ))}
          </select>
          <button type="submit" disabled={action.busy}>
            Attach
          </button>
        </form>
      ) : (
        <p className="muted">Every memory you have is attached.</p>
      )}
      <p className="hint">
        <a href={formatRoute({ screen: 'tms' })}>Create or import a memory</a>
      </p>

      <div className="inline-form">
        <button
          type="button"
          disabled={action.busy || refs.length === 0}
          onClick={() =>
            void action.run((t) => api.pretranslate(t, project)).then((s) => setRan(s))
          }
        >
          Pre-translate
        </button>
        {ran && (
          <span className="muted" role="status">
            {ran.exact} exact, {ran.tagdiff} with different tags (draft), {ran.fuzzy}{' '}
            fuzzy (draft), {ran.propagated} propagated, {ran.unmatched} unmatched,{' '}
            {ran.skipped} skipped
          </span>
        )}
      </div>
      <div className="inline-form">
        <label>
          Fuzzy matches from{' '}
          <input
            type="number"
            inputMode="numeric"
            min={fuzzy.min}
            max={fuzzy.max}
            disabled={action.busy || fuzzyOff}
            value={typed ?? thresholdText(fuzzy)}
            placeholder={String(fuzzy.default)}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => typed !== null && void saveThreshold(typed, false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typed !== null) void saveThreshold(typed, false);
            }}
          />{' '}
          %
        </label>
        <label>
          <input
            type="checkbox"
            checked={fuzzyOff}
            disabled={action.busy}
            onChange={(e) => void saveThreshold('', e.target.checked)}
          />{' '}
          Off
        </label>
        <span className="muted">
          Below this a match is not written into a segment; empty is the default (
          {fuzzy.default}).
        </span>
      </div>
      {(fuzzyError ?? action.error) && (
        <p className="error" role="alert">
          {fuzzyError ?? action.error}
        </p>
      )}
    </section>
  );
}
