/**
 * The editor's Resources panel (backlog #114; issue #181): what the project
 * consults, in one place beside the grid, so a translator does not leave the
 * editor to find out which memories and glossaries are attached, in what order,
 * and which one is written to. Read-only: attaching, ordering and switching are
 * the project screen's (`manage`), and the panel links there. On another
 * account's project (a vendor's job) it shows the same order and flags with
 * rows named by position and no link, because the owner's names are not the
 * grantee's to see (backlog #124). What each row says is `resources.ts`'s.
 */
import { useCallback } from 'react';

import { api } from './api.js';
import { parseProjectKey } from './project-key.js';
import {
  anonymousRows,
  glossaryRows,
  memoryRows,
  resourceSummary,
  type ResourceRow,
} from './resources.js';
import { formatRoute } from './route.js';
import { useLoad } from './use-load.js';

export function ResourcesPanel({ project }: { project: string }) {
  // Another account's project (a vendor's job) shows the same panel without names
  // and without the link to a page the grantee cannot manage (backlog #124).
  if (parseProjectKey(project).owner !== null) return <GranteePanel project={project} />;
  return <OwnerPanel project={project} />;
}

function GranteePanel({ project }: { project: string }) {
  const loaded = useLoad(
    useCallback(
      (token, signal) => api.projectResources(token, project, signal),
      [project],
    ),
  );
  return (
    <aside className="resources-panel" aria-label="Resources">
      {loaded.state === 'loading' && <p className="muted rp-pad">Loading{'…'}</p>}
      {loaded.state === 'error' && <p className="error rp-pad">{loaded.message}</p>}
      {loaded.state === 'done' && (
        <Body
          project={project}
          memories={anonymousRows(loaded.data.memories, 'Memory')}
          glossaries={anonymousRows(loaded.data.glossaries, 'Glossary')}
          manage={false}
        />
      )}
    </aside>
  );
}

function OwnerPanel({ project }: { project: string }) {
  const loaded = useLoad(
    useCallback(
      (token, signal) =>
        Promise.all([
          api.projectMemories(token, project, signal),
          api.projectGlossaries(token, project, signal),
        ]),
      [project],
    ),
  );
  return (
    <aside className="resources-panel" aria-label="Resources">
      {loaded.state === 'loading' && <p className="muted rp-pad">Loading{'…'}</p>}
      {loaded.state === 'error' && <p className="error rp-pad">{loaded.message}</p>}
      {loaded.state === 'done' && (
        <Body
          project={project}
          memories={memoryRows(loaded.data[0].refs)}
          glossaries={glossaryRows(loaded.data[1].refs)}
          manage
        />
      )}
    </aside>
  );
}

function Body({
  project,
  memories,
  glossaries,
  manage,
}: {
  project: string;
  memories: readonly ResourceRow[];
  glossaries: readonly ResourceRow[];
  /** Whether to link to the project page: only its owner can manage anything there. */
  manage: boolean;
}) {
  return (
    <div className="rp-pad">
      <p className="muted">{resourceSummary(memories.length, glossaries.length)}</p>
      <Group title="Memories" rows={memories} empty="No memory attached." />
      <Group title="Glossaries" rows={glossaries} empty="No glossary attached." />
      {manage && (
        <p>
          <a href={formatRoute({ screen: 'project', project })}>
            Manage on the project page
          </a>
        </p>
      )}
    </div>
  );
}

function Group({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: readonly ResourceRow[];
  empty: string;
}) {
  return (
    <section className="rp-group" aria-label={title}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ol>
          {rows.map((row) => (
            <li key={row.id} className={row.enabled ? undefined : 'rp-off'}>
              <span className="rp-name">{row.name}</span>
              {row.badges.map((badge) => (
                <span key={badge} className="chip">
                  {badge}
                </span>
              ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
