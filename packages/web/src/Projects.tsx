/**
 * The project and file lists: open, nothing else (v1-spec.md §7.1).
 * Creating projects, uploading files and attaching TMs is backlog #32's
 * management UI.
 */
import { useCallback } from 'react';

import { api } from './api.js';
import { formatRoute } from './route.js';
import { useLoad } from './use-load.js';

export function Projects() {
  const projects = useLoad(
    useCallback((token, signal) => api.projects(token, signal), []),
  );
  if (projects.state === 'loading')
    return <p className="muted">Loading projects{'\u2026'}</p>;
  if (projects.state === 'error') return <p className="error">{projects.message}</p>;
  if (projects.data.length === 0) {
    return <p className="muted">No projects yet.</p>;
  }
  return (
    <section className="list">
      <h2>Projects</h2>
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
    </section>
  );
}

export function ProjectFiles({ name }: { name: string }) {
  const detail = useLoad(
    useCallback((token, signal) => api.project(token, name, signal), [name]),
  );
  if (detail.state === 'loading')
    return <p className="muted">Loading project{'\u2026'}</p>;
  if (detail.state === 'error') return <p className="error">{detail.message}</p>;
  const { project, files } = detail.data;
  return (
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
    </section>
  );
}
