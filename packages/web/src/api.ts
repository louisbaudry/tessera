/**
 * The server's JSON surface (v1-spec.md §2.5), typed from `core`'s
 * models. The SPA never sees anything but `/api/`.
 */
import type { Project, QaIssue, Segment } from '@cat-tool/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Account {
  readonly id: number;
  readonly email: string;
  readonly createdAt: string;
}

export interface ProjectSummary {
  readonly name: string;
  readonly project: Project | null;
  readonly fileCount: number;
}

export interface FileSummary {
  readonly id: number;
  readonly relPath: string;
  readonly importedAt: string;
  readonly segmentCount: number;
}

export interface ProjectDetail {
  readonly name: string;
  readonly project: Project;
  readonly files: readonly FileSummary[];
}

export interface FileSegments {
  readonly file: FileSummary;
  readonly segments: readonly Segment[];
}

async function call<T>(
  path: string,
  token: string | null,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Not JSON; the status line will do.
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

const project = (name: string) => `/api/projects/${encodeURIComponent(name)}`;

export const api = {
  login: (email: string, password: string) =>
    call<{ token: string; expiresAt: string; account: Account }>('/api/login', null, {
      method: 'POST',
      body: { email, password },
    }),
  logout: (token: string) => call<{ ok: true }>('/api/logout', token, { method: 'POST' }),
  me: (token: string, signal?: AbortSignal) =>
    call<Account>('/api/me', token, { signal }),
  projects: (token: string, signal?: AbortSignal) =>
    call<ProjectSummary[]>('/api/projects', token, { signal }),
  project: (token: string, name: string, signal?: AbortSignal) =>
    call<ProjectDetail>(project(name), token, { signal }),
  segments: (token: string, name: string, fileId: number, signal?: AbortSignal) =>
    call<FileSegments>(`${project(name)}/files/${fileId}/segments`, token, { signal }),
  qaIssues: (token: string, name: string, fileId: number, signal?: AbortSignal) =>
    call<{ issues: QaIssue[] }>(`${project(name)}/files/${fileId}/qa-issues`, token, {
      signal,
    }),
};
