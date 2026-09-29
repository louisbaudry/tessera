/**
 * The server's JSON surface (v1-spec.md §2.5), typed from `core`'s
 * models. The SPA never sees anything but `/api/`.
 */
import type { Project, QaIssue, Segment, Token } from '@cat-tool/core';

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

/** Writes still on their way, which signing out waits for (`settled`). */
const writes = new Set<Promise<unknown>>();

async function call<T>(
  path: string,
  token: string | null,
  init: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
    // Outlives the page, for a save sent as it goes away; unlike a
    // beacon it can carry the Authorization header.
    keepalive: init.keepalive,
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
  /**
   * One segment's target: what the translator placed (§7.2), over the
   * version of the segment the page last saw — or, with no version (left
   * out of the JSON), over whatever is stored. The server decides the rest.
   */
  saveTarget: (
    token: string,
    name: string,
    segmentId: number,
    body: { targetTokens: readonly Token[]; baseUpdatedAt: string | undefined },
    options: { keepalive?: boolean } = {},
  ) => {
    const write = call<{
      segment: Segment;
      changed: boolean;
      rerun: number[];
      issues: QaIssue[];
    }>(`${project(name)}/segments/${segmentId}`, token, {
      method: 'PUT',
      body,
      keepalive: options.keepalive,
    });
    writes.add(write);
    void write.catch(() => undefined).finally(() => writes.delete(write));
    return write;
  },
  /**
   * Confirms a segment as stored, over the version the page last saw
   * (v1-spec.md §7.3). Answered like a save; `changed` is false when it
   * was already confirmed.
   */
  confirm: (
    token: string,
    name: string,
    segmentId: number,
    body: { baseUpdatedAt: string | undefined },
  ) => {
    const write = call<{
      segment: Segment;
      changed: boolean;
      rerun: number[];
      issues: QaIssue[];
    }>(`${project(name)}/segments/${segmentId}/confirm`, token, {
      method: 'POST',
      body,
    });
    writes.add(write);
    void write.catch(() => undefined).finally(() => writes.delete(write));
    return write;
  },
  /** Resolves once every write sent so far, and any it set off, has settled. */
  settled: async (): Promise<void> => {
    while (writes.size > 0) await Promise.allSettled([...writes]);
  },
};
