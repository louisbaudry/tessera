/**
 * Alternatives recorded often enough to propose making them preferred (backlog
 * #110, smart-glossary-spec.md §6). Each is evidence the translators have
 * been using another acceptable rendering; accepting one is a person's ruling
 * and the only thing that moves the preference. Nothing here is stored: the
 * server counts the log each time it is asked.
 */
import { useCallback } from 'react';

import { api } from './api.js';
import { proposalText } from './glossary-panel.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function GlossaryProposals({
  project,
  revision,
  onAccepted,
}: {
  project: string;
  /** Bumped when something that changes the proposals was written. */
  revision: number;
  onAccepted: () => void;
}) {
  const load = useLoad(
    useCallback(
      (token, signal) => api.glossaryProposals(token, project, signal),
      // `revision` is not read inside: bumping it is what asks again.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [project, revision],
    ),
  );
  const action = useAction();
  if (load.state !== 'done' || load.data.proposals.length === 0) return null;

  return (
    <section className="gp-proposals" aria-label="Proposed changes">
      <h3>Proposed changes</h3>
      <ul>
        {load.data.proposals.map((p) => (
          <li key={`${p.termId}:${p.lang}:${p.chosen}`}>
            <span>
              <strong>{p.term ?? `Term ${p.termId}`}</strong> {proposalText(p)}
            </span>
            <button
              type="button"
              disabled={action.busy}
              onClick={async () => {
                const done = await action.run((token) =>
                  api.acceptProposal(token, project, {
                    termId: p.termId,
                    lang: p.lang,
                    chosen: p.chosen,
                  }),
                );
                if (done) onAccepted();
              }}
            >
              Make preferred
            </button>
          </li>
        ))}
      </ul>
      {action.error && <p className="error">{action.error}</p>}
    </section>
  );
}
