/**
 * The editor's Resources panel (backlog #114; issue #181): what the project
 * consults, in one place beside the grid, so a translator does not leave the
 * editor to find out which memories and glossaries are attached, in what order,
 * and which one is written to. Read-only: attaching, ordering and switching are
 * the project screen's (`manage`), and the panel links there. On another
 * account's project (a vendor's job) it shows the same order and flags with
 * rows named by position and no link, because the owner's names are not the
 * grantee's to see (backlog #124). What each row says is `resources.ts`'s.
 *
 * Reference files (`v1-spec.md` §7.9, issue #203) sit under the two lists: the
 * owner attaches and removes them here, anyone with a grant opens them.
 */
import { useCallback, useState } from 'react';

import {
  api,
  ApiError,
  type OwnerReferenceFile,
  type WorkerReferenceFile,
} from './api.js';
import { parseProjectKey } from './project-key.js';
import {
  anonymousRows,
  glossaryRows,
  memoryRows,
  ownerReferenceRows,
  resourceSummary,
  workerReferenceRows,
  type ResourceRow,
} from './resources.js';
import { formatRoute } from './route.js';
import { useSession } from './session-context.js';
import { useLoad } from './use-load.js';

export function ResourcesPanel({ project }: { project: string }) {
  // Another account's project (a vendor's job) shows the same panel without names
  // and without the link to a page the grantee cannot manage (backlog #124).
  if (parseProjectKey(project).tenantId !== null)
    return <GranteePanel project={project} />;
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
      <ReferenceFiles project={project} manage={manage} />
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

/**
 * The project's reference files: opened from a `blob:` URL, because the bytes
 * need the bearer token a plain link cannot send. The owner also attaches (with
 * an optional label for whoever works on the project) and removes.
 */
function ReferenceFiles({ project, manage }: { project: string; manage: boolean }) {
  const { token, signOut } = useSession();
  const [version, setVersion] = useState(0);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loaded = useLoad(
    useCallback(
      (t, signal) => api.referenceFiles(t, project, signal),
      // `version` is how a change reloads the list.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [project, version],
    ),
  );

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return signOut();
    setProblem(err instanceof Error ? err.message : String(err));
  };

  const open = async (id: number) => {
    setProblem(null);
    // Opened before the fetch, in the click's own turn, so a pop-up blocker allows it.
    const tab = window.open('', '_blank');
    try {
      const url = URL.createObjectURL(await api.referenceFileBlob(token, project, id));
      if (tab) tab.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      tab?.close();
      fail(err);
    }
  };

  const add = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.addReferenceFile(token, project, file, label);
      setLabel('');
      setVersion((v) => v + 1);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    setBusy(true);
    setProblem(null);
    try {
      await api.removeReferenceFile(token, project, id);
      setVersion((v) => v + 1);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const rows =
    loaded.state !== 'done'
      ? []
      : manage
        ? ownerReferenceRows(loaded.data.files as OwnerReferenceFile[])
        : workerReferenceRows(loaded.data.files as WorkerReferenceFile[]);

  return (
    <section className="rp-group" aria-label="Reference files">
      <h3>Reference files</h3>
      {loaded.state === 'loading' && <p className="muted">Loading{'…'}</p>}
      {loaded.state === 'error' && <p className="error">{loaded.message}</p>}
      {loaded.state === 'done' &&
        (rows.length === 0 ? (
          <p className="muted">No reference file attached.</p>
        ) : (
          <ol>
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void open(row.id)}
                >
                  {row.title}
                </button>
                <span className="muted"> {row.detail}</span>
                {manage && (
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => void remove(row.id)}
                    aria-label={`Remove ${row.title}`}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ol>
        ))}
      {manage && (
        <div className="rp-add">
          <input
            type="text"
            value={label}
            maxLength={80}
            placeholder="Label for translators (optional)"
            aria-label="Label for translators"
            onChange={(e) => setLabel(e.target.value)}
          />
          <label className="file-button">
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.gif,.webp"
              disabled={busy}
              onChange={(e) => {
                void add(e.target.files);
                e.target.value = '';
              }}
            />
            Add a reference file{'…'}
          </label>
        </div>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
