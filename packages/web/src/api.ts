/**
 * The server's JSON surface (v1-spec.md §2.5), typed from `core`'s
 * models. The SPA never sees anything but `/api/`.
 */
import type { Project, QaIssue, QaRule, Segment, Token } from '@cat-tool/core';

import type { ImportJob } from './import-job.js';

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
    /** JSON, or a `FormData` sent as multipart (an upload). */
    body?: unknown;
    signal?: AbortSignal;
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const form = init.body instanceof FormData ? init.body : null;
  // The browser sets a multipart body's content type, boundary included.
  if (init.body !== undefined && !form) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers,
    body: form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
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

/** One of the account's memories (`v1-spec.md` §7.5): its slug, never its path. */
export interface MemorySummary {
  readonly slug: string;
  readonly uuid: string;
  readonly name: string;
  readonly langs: readonly string[];
  readonly units: number;
  readonly createdAt: string;
}

/**
 * A memory attached to a project. `tm` is null for one attached from
 * outside the account's memories (by the CLI), which the API never
 * shows by path.
 */
export interface TmRefView {
  readonly id: number;
  readonly tm: string | null;
  readonly priority: number;
  readonly writeTarget: boolean;
  readonly enabled: boolean;
}

/** What a pre-translate run did (`v1-spec.md` §6.1). */
export interface PretranslateSummary {
  readonly exact: number;
  readonly tagdiff: number;
  readonly propagated: number;
  readonly unmatched: number;
  readonly skipped: number;
}

/** What a merge or split changed (`v1-spec.md` §7.4). */
export interface Restructured {
  /** The segments now standing in place of the ones asked about, in order. */
  segments: Segment[];
  /** Segment ids that no longer exist. */
  removed: number[];
  rerun: number[];
  issues: QaIssue[];
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
  /** A new project; `writeTm` is the memory it confirms into, created if new. */
  createProject: (
    token: string,
    body: {
      name: string;
      title: string;
      srcLang: string;
      tgtLang: string;
      writeTm?: string;
    },
  ) => call<ProjectSummary>('/api/projects', token, { method: 'POST', body }),
  /** One DOCX into a project, exactly the CLI's `add-file`. */
  addFile: (token: string, name: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return call<{ file: FileSummary; locked: number }>(`${project(name)}/files`, token, {
      method: 'POST',
      body: form,
    });
  },
  memories: (token: string, signal?: AbortSignal) =>
    call<MemorySummary[]>('/api/tms', token, { signal }),
  /** An empty memory. */
  createMemory: (token: string, name: string) =>
    call<MemorySummary & { warnings: string[] }>('/api/tms', token, {
      method: 'POST',
      body: { name },
    }),
  /**
   * A memory imported from a `.tmx` or `.sdltm`: answers at once with the
   * job doing it (backlog #16a), which `importJob` follows and `cancelImport` stops.
   */
  importMemory: (token: string, name: string, file: File) => {
    const form = new FormData();
    form.append('name', name); // before the file: the server reads it first
    form.append('file', file, file.name);
    return call<{ job: ImportJob }>('/api/tms', token, { method: 'POST', body: form });
  },
  /** The account's jobs, running first: how an import still going is found again. */
  jobs: (token: string, signal?: AbortSignal) =>
    call<{ jobs: ImportJob[] }>('/api/jobs', token, { signal }),
  importJob: (token: string, id: string, signal?: AbortSignal) =>
    call<ImportJob>(`/api/jobs/${id}`, token, { signal }),
  /** Asks the server to stop it; the job is `running` until it has. */
  cancelImport: (token: string, id: string) =>
    call<ImportJob>(`/api/jobs/${id}`, token, { method: 'DELETE' }),
  projectMemories: (token: string, name: string, signal?: AbortSignal) =>
    call<{ refs: TmRefView[] }>(`${project(name)}/tms`, token, { signal }),
  attachMemory: (token: string, name: string, tm: string, writeTarget: boolean) =>
    call<{ refs: TmRefView[] }>(`${project(name)}/tms`, token, {
      method: 'POST',
      body: { tm, writeTarget },
    }),
  /** The whole consultation order, first consulted first. */
  orderMemories: (token: string, name: string, order: readonly number[]) =>
    call<{ refs: TmRefView[] }>(`${project(name)}/tms`, token, {
      method: 'PUT',
      body: { order },
    }),
  setWriteMemory: (token: string, name: string, refId: number) =>
    call<{ refs: TmRefView[] }>(`${project(name)}/tms/${refId}/write-target`, token, {
      method: 'POST',
    }),
  detachMemory: (token: string, name: string, refId: number) =>
    call<{ refs: TmRefView[] }>(`${project(name)}/tms/${refId}`, token, {
      method: 'DELETE',
    }),
  pretranslate: (token: string, name: string) =>
    call<PretranslateSummary>(`${project(name)}/pretranslate`, token, { method: 'POST' }),
  segments: (token: string, name: string, fileId: number, signal?: AbortSignal) =>
    call<FileSegments>(`${project(name)}/files/${fileId}/segments`, token, { signal }),
  qaIssues: (token: string, name: string, fileId: number, signal?: AbortSignal) =>
    call<{ issues: QaIssue[] }>(`${project(name)}/files/${fileId}/qa-issues`, token, {
      signal,
    }),
  /**
   * Sets a finding aside, or counts it again (backlog #33) — named by its
   * segment and rule, which a QA rerun keeps; its row id is not.
   */
  setQaDismissed: (
    token: string,
    name: string,
    segmentId: number,
    rule: QaRule,
    dismissed: boolean,
  ) =>
    call<{ issue: QaIssue }>(
      `${project(name)}/segments/${segmentId}/qa-issues/${rule}`,
      token,
      {
        method: 'PUT',
        body: { dismissed },
      },
    ),
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
  /**
   * Splits a segment at a plain-text offset of its source (§7.4). The
   * answer lists the segments now standing and the ones gone.
   */
  split: (
    token: string,
    name: string,
    segmentId: number,
    body: { offset: number; baseUpdatedAt: string | undefined },
  ) =>
    call<Restructured>(`${project(name)}/segments/${segmentId}/split`, token, {
      method: 'POST',
      body,
    }),
  /** Merges a segment with the next one of its paragraph (§7.4). */
  merge: (
    token: string,
    name: string,
    segmentId: number,
    body: { baseUpdatedAt: string | undefined; nextBaseUpdatedAt: string | undefined },
  ) =>
    call<Restructured>(`${project(name)}/segments/${segmentId}/merge`, token, {
      method: 'POST',
      body,
    }),
  /** Resolves once every write sent so far, and any it set off, has settled. */
  settled: async (): Promise<void> => {
    while (writes.size > 0) await Promise.allSettled([...writes]);
  },
};
