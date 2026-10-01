/**
 * The project list and one project's screen (v1-spec.md §7.1, §7.5):
 * opening what exists, and since backlog #32 making it — a project with
 * the memory it confirms into, its documents, and the memories it
 * consults, in order.
 */
import { slugify } from '@cat-tool/core/model';
import { useCallback, useState, type FormEvent } from 'react';

import { api, ApiError } from './api.js';
import { ProjectMemories } from './ProjectMemories.js';
import { formatRoute } from './route.js';
import { useSession } from './session-context.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

/** A language tag as a person types one: `en`, `de-CH`, `zh-Hant-TW`. */
const LANG_PATTERN = '[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*';

export function Projects() {
  const projects = useLoad(
    useCallback((token, signal) => api.projects(token, signal), []),
  );
  if (projects.state === 'loading')
    return <p className="muted">Loading projects{'\u2026'}</p>;
  if (projects.state === 'error') return <p className="error">{projects.message}</p>;
  return (
    <div className="page">
      <section className="list">
        <h2>Projects</h2>
        {projects.data.length === 0 ? (
          <p className="muted">No projects yet.</p>
        ) : (
          <ul>
            {projects.data.map((p) => (
              <li key={p.name}>
                <a href={formatRoute({ screen: 'project', project: p.name })}>
                  {p.project?.name ?? p.name}
                </a>
                <span className="muted">
                  {p.project
                    ? `${p.project.srcLang} \u2192 ${p.project.tgtLang} \u00B7 `
                    : ''}
                  {p.fileCount} {p.fileCount === 1 ? 'file' : 'files'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <NewProject taken={projects.data.map((p) => p.name)} />
    </div>
  );
}

/**
 * A project is born with the memory it confirms into (§7.5): by default
 * a new one named after it, or any of the account's, or none.
 */
function NewProject({ taken }: { taken: readonly string[] }) {
  const memories = useLoad(
    useCallback((token, signal) => api.memories(token, signal), []),
  );
  const [title, setTitle] = useState('');
  // Null until edited: the name follows the title, and the memory the name.
  const [name, setName] = useState<string | null>(null);
  const [writeTm, setWriteTm] = useState<string | null>(null);
  const [srcLang, setSrcLang] = useState('');
  const [tgtLang, setTgtLang] = useState('');
  const action = useAction();

  const slug = name ?? slugify(title);
  const memory = writeTm ?? slug;
  const existing = memories.state === 'done' ? memories.data : [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const created = await action.run((token) =>
      api.createProject(token, {
        name: slug,
        title: title.trim() || slug,
        srcLang: srcLang.trim(),
        tgtLang: tgtLang.trim(),
        ...(memory.trim() === '' ? {} : { writeTm: memory.trim() }),
      }),
    );
    if (created) window.location.hash = formatRoute({ screen: 'project', project: slug });
  };

  return (
    <form className="panel form" onSubmit={(e) => void submit(e)}>
      <h2>New project</h2>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Name <span className="hint">its address and file name</span>
        <input
          value={slug}
          onChange={(e) => setName(e.target.value)}
          pattern="[a-z0-9](?:[a-z0-9\-]{0,62}[a-z0-9])?"
          title="lowercase letters, digits and hyphens"
          required
        />
        {taken.includes(slug) && <span className="error">already a project</span>}
      </label>
      <div className="pair">
        <label>
          Source language
          <input
            value={srcLang}
            onChange={(e) => setSrcLang(e.target.value)}
            placeholder="en"
            pattern={LANG_PATTERN}
            required
          />
        </label>
        <label>
          Target language
          <input
            value={tgtLang}
            onChange={(e) => setTgtLang(e.target.value)}
            placeholder="de"
            pattern={LANG_PATTERN}
            required
          />
        </label>
      </div>
      <label>
        Write memory{' '}
        <span className="hint">
          where confirmed segments go; a new name creates it, empty means none
        </span>
        <input
          value={memory}
          onChange={(e) => setWriteTm(e.target.value)}
          list="memory-names"
          pattern="[a-z0-9](?:[a-z0-9\-]{0,62}[a-z0-9])?"
        />
        <datalist id="memory-names">
          {existing.map((m) => (
            <option key={m.slug} value={m.slug} />
          ))}
        </datalist>
      </label>
      {action.error && (
        <p className="error" role="alert">
          {action.error}
        </p>
      )}
      <div>
        <button type="submit" disabled={action.busy || taken.includes(slug)}>
          {action.busy ? 'Creating\u2026' : 'Create project'}
        </button>
      </div>
    </form>
  );
}

export function ProjectFiles({ name }: { name: string }) {
  const [version, setVersion] = useState(0);
  const detail = useLoad(
    // `version` reloads the list after an upload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useCallback((token, signal) => api.project(token, name, signal), [name, version]),
  );
  if (detail.state === 'loading')
    return <p className="muted">Loading project{'\u2026'}</p>;
  if (detail.state === 'error') return <p className="error">{detail.message}</p>;
  const { project, files } = detail.data;
  return (
    <div className="page">
      <section className="list">
        <h2>
          {project.name}{' '}
          <span className="muted">
            {project.srcLang} {'\u2192'} {project.tgtLang}
          </span>
        </h2>
        {files.length === 0 ? (
          <p className="muted">No files in this project.</p>
        ) : (
          <ul>
            {files.map((f) => (
              <li key={f.id}>
                <a href={formatRoute({ screen: 'grid', project: name, fileId: f.id })}>
                  {f.relPath}
                </a>
                <span className="muted">{f.segmentCount.toLocaleString()} segments</span>
              </li>
            ))}
          </ul>
        )}
        <AddFiles project={name} onAdded={() => setVersion((v) => v + 1)} />
      </section>
      <ProjectMemories key={name} project={name} />
    </div>
  );
}

/** Documents in, one request each, in the order chosen (the CLI's `add-file`). */
function AddFiles({ project, onAdded }: { project: string; onAdded: () => void }) {
  const { token, signOut } = useSession();
  const [progress, setProgress] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

  const add = async (list: FileList | null) => {
    const chosen = list ? [...list] : [];
    if (chosen.length === 0) return;
    const failed: string[] = [];
    for (const [i, file] of chosen.entries()) {
      setProgress(`Adding ${i + 1} of ${chosen.length}\u2026`);
      try {
        await api.addFile(token, project, file);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return signOut();
        failed.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setProgress(null);
    setFailures(failed);
    onAdded();
  };

  return (
    <div className="add-files">
      <label className="file-button">
        <input
          type="file"
          accept=".docx"
          multiple
          disabled={progress !== null}
          onChange={(e) => {
            void add(e.target.files);
            e.target.value = '';
          }}
        />
        Add documents{'\u2026'}
      </label>
      {progress && <span className="muted">{progress}</span>}
      {failures.map((f) => (
        <p key={f} className="error" role="alert">
          Not added: {f}
        </p>
      ))}
    </div>
  );
}
