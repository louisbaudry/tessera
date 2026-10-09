/**
 * The server's JSON surface (v1-spec.md §2.5), typed from `core`'s
 * models. The SPA never sees anything but `/api/`.
 */
import type {
  AccountRole,
  Project,
  QaIssue,
  QaRule,
  Segment,
  Token,
} from '@cat-tool/core';
import type {
  AssignmentChannel,
  AssignmentStatus,
  CapacityStatus,
  CurrencyTotal,
  InvitationStatus,
  PaymentStatus,
  RateTier,
  VendorRecord,
} from '@cat-tool/vendor-core';

import type {
  ExceptionProposalView,
  MismatchList,
  SessionView,
} from './glossary-panel.js';
import type { FuzzyThresholdView } from './fuzzy-threshold.js';
import type { ImportJob } from './import-job.js';
import type { ScanJob } from './stale-scan.js';
import type { RateEntry } from './jobs.js';
import { parseProjectKey } from './project-key.js';

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
  /** What the account is: an owner has projects, a vendor has jobs (backlog #52a). */
  readonly role: AccountRole;
  readonly createdAt: string;
}

/** A job as the vendor sees it: no address, no history, no other vendor (`server/src/assignments.ts`). */
export interface VendorJob {
  readonly id: number;
  readonly project: string;
  readonly channel: AssignmentChannel;
  readonly status: AssignmentStatus;
  readonly deadline: string | null;
  readonly instructions: string | null;
  readonly reopenedFrom: number | null;
  readonly offeredAt: string;
}

/** One entry of the cross-owner feed: the job and whose it is (an account id). */
export interface FeedJob extends VendorJob {
  readonly owner: number;
}

export interface VendorFeed {
  readonly needsResponse: readonly FeedJob[];
  readonly claimable: readonly FeedJob[];
  readonly active: readonly FeedJob[];
  readonly delivered: readonly FeedJob[];
}

/** What locked at delivery (vendor-spec decision 10): the amount, and the lines it is made of. */
export interface LockedPayable {
  readonly lockedAt: string;
  readonly currency: string | null;
  readonly words: number;
  readonly totalMicros: number;
  /** False when a tier had words and no rate: the total leaves them out. */
  readonly complete: boolean;
  readonly lines: ReadonlyArray<{
    readonly tier: RateTier;
    readonly words: number;
    readonly rateMicros: number | null;
    readonly amountMicros: number;
  }>;
}

/** A vendor's capacity on one owner's roster (decision 8): null until they set one. */
export interface RosterCapacity {
  readonly owner: number;
  readonly status: CapacityStatus | null;
  readonly note: string | null;
  readonly setAt: string | null;
}

/** Opening an offer (vendor-spec §7): everything needed before answering, and no total. */
export interface OfferDetail {
  readonly assignment: VendorJob;
  readonly offer: {
    readonly analysis: {
      readonly at: string;
      readonly words: Readonly<Partial<Record<RateTier, number>>>;
      readonly totalWords: number;
    } | null;
    readonly source: {
      readonly segments: number;
      readonly preview: readonly string[];
    } | null;
    readonly payable: LockedPayable | null;
    readonly rateCard: readonly RateEntry[];
  };
}

/** One locked payable in the owner's pay run (`GET /api/payables`; backlog #112). */
export interface PayableRow {
  readonly assignment: number;
  readonly project: string;
  readonly vendorAccountId: number;
  /** What the owner calls the vendor; never an email address. */
  readonly vendor: string;
  /** Null when no tier had a rate. */
  readonly currency: string | null;
  readonly words: number;
  readonly totalMicros: number;
  /** False when a tier had words and no rate: the total leaves them out. */
  readonly complete: boolean;
  readonly lockedAt: string;
  readonly status: PaymentStatus;
  readonly paidOn: string | null;
  readonly daysToPay: number | null;
}

export interface PayablesList {
  readonly payables: readonly PayableRow[];
  /** One per currency, never converted. */
  readonly totals: readonly CurrencyTotal[];
}

/** A vendor's own row in their payment record (`GET /api/vendor/payments`). */
export interface VendorPaymentRow {
  readonly owner: number;
  readonly assignment: number;
  readonly project: string;
  readonly currency: string | null;
  readonly words: number;
  readonly totalMicros: number;
  readonly complete: boolean;
  readonly lockedAt: string;
  readonly status: PaymentStatus;
  readonly paidOn: string | null;
  readonly daysToPay: number | null;
}

/** An owner's invitation as they see it: never the token, which only its creation returns. */
export interface InvitationView {
  readonly id: number;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: InvitationStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
}

/** The roster entry a pay-run filter picks from: an account id and a name, never an email. */
export interface RosterVendor {
  readonly accountId: number;
  readonly displayName: string;
}

/** A roster entry with the vendor's record: counts with their sample sizes, never a score (#123). */
export interface RosterEntry extends RosterVendor {
  readonly record: VendorRecord;
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

/**
 * A file the server answers with as text, saved by the browser under the name
 * the server gave it: the CSV link needs the session's token, which a plain
 * `<a href>` cannot carry.
 */
async function callText(
  path: string,
  token: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(path, {
    headers: { authorization: `Bearer ${token}` },
    signal,
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
  return res.text();
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
  readonly fuzzy: number;
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

/** A glossary attached to a project: its slug, never its path. */
export interface GlossaryRefView {
  readonly id: number;
  readonly glossary: string | null;
  readonly priority: number;
  readonly writeTarget: boolean;
  readonly enabled: boolean;
}

/**
 * `/api/projects/<name><suffix>`, with `?owner=` when the key names another
 * account's project (`project-key.ts`; backlog #45, #52). The query goes last,
 * after the suffix, which is why a path is built here and never by the caller.
 */
function projectUrl(key: string, suffix = ''): string {
  const { name, owner } = parseProjectKey(key);
  return `/api/projects/${encodeURIComponent(name)}${suffix}${owner === null ? '' : `?owner=${owner}`}`;
}

const glossaryUrl = (name: string, fileId: number) =>
  projectUrl(name, `/files/${fileId}/glossary/session`);

export const api = {
  login: (email: string, password: string) =>
    call<{ token: string; expiresAt: string; account: Account }>('/api/login', null, {
      method: 'POST',
      body: { email, password },
    }),
  logout: (token: string) => call<{ ok: true }>('/api/logout', token, { method: 'POST' }),
  /** The signed-in vendor's feed across every owner who engages them (backlog #52a). */
  vendorFeed: (token: string, signal?: AbortSignal) =>
    call<VendorFeed>('/api/vendor/feed', token, { signal }),
  offer: (token: string, owner: number, id: number, signal?: AbortSignal) =>
    call<OfferDetail>(`/api/assignments/${id}/offer?owner=${owner}`, token, { signal }),
  /** The vendor's capacity on every roster that lists them (backlog #54). */
  vendorCapacity: (token: string, signal?: AbortSignal) =>
    call<{ rosters: RosterCapacity[] }>('/api/vendor/capacity', token, { signal }),
  setCapacity: (
    token: string,
    owner: number,
    body: { status: CapacityStatus; note: string | null },
  ) =>
    call<RosterCapacity>(`/api/vendor/capacity?owner=${owner}`, token, {
      method: 'PUT',
      body,
    }),
  /** The vendor's job on a project they were granted, if any (backlog #53). */
  vendorJob: (token: string, owner: number, project: string, signal?: AbortSignal) =>
    call<{ id: number; status: string }>(
      `/api/vendor/job?owner=${owner}&project=${encodeURIComponent(project)}`,
      token,
      { signal },
    ),
  /** A vendor's answer to a job: claim, accept, decline, start or deliver (vendor-spec §4). */
  answerJob: (
    token: string,
    owner: number,
    id: number,
    verb: 'claim' | 'accept' | 'decline' | 'start' | 'deliver',
  ) =>
    call<{ assignment: VendorJob }>(
      `/api/assignments/${id}/${verb}?owner=${owner}`,
      token,
      {
        method: 'POST',
      },
    ),
  /** The owner's roster, for the pay run's vendor filter (backlog #113). */
  rosterVendors: (token: string, signal?: AbortSignal) =>
    call<{ vendors: RosterEntry[] }>('/api/vendors', token, { signal }),
  /** The owner's invitations, newest first (backlog #111). */
  invitations: (token: string, signal?: AbortSignal) =>
    call<{ invitations: InvitationView[] }>('/api/invitations', token, { signal }),
  /** Invites an address; the one-time link token is in this response and no other. */
  invite: (token: string, body: { email: string; displayName?: string }) =>
    call<{ invitation: InvitationView; token: string }>('/api/invitations', token, {
      method: 'POST',
      body,
    }),
  revokeInvitation: (token: string, id: number) =>
    call<{ invitation: InvitationView }>(`/api/invitations/${id}/revoke`, token, {
      method: 'POST',
      body: {},
    }),
  /** The address a link was made for (no session needed); a 404 for any link that cannot be used. */
  openInvitation: (inviteToken: string, signal?: AbortSignal) =>
    call<{ email: string }>('/api/invitations/open', null, {
      method: 'POST',
      body: { token: inviteToken },
      signal,
    }),
  /** Uses a link: sets the password once and returns the new vendor's session. */
  acceptInvitation: (inviteToken: string, password: string) =>
    call<{ token: string; expiresAt: string; account: Account }>(
      '/api/invitations/accept',
      null,
      { method: 'POST', body: { token: inviteToken, password } },
    ),
  /**
   * A vendor who already has an account joins the owner's roster from a link,
   * signed in as themselves (backlog #187): the session is the proof of who joins.
   */
  joinInvitation: (token: string, inviteToken: string) =>
    call<{ ok: true }>('/api/invitations/join', token, {
      method: 'POST',
      body: { token: inviteToken },
    }),
  /** The owner's pay run (backlog #112/#113); `query` is `payablesQuery` of the filters. */
  payables: (token: string, query: string, signal?: AbortSignal) =>
    call<PayablesList>(`/api/payables${query}`, token, { signal }),
  /** The same list as CSV text; the server records the export. */
  payablesCsv: (token: string, query: string, signal?: AbortSignal) =>
    callText(`/api/payables.csv${query}`, token, signal),
  /** Records that a locked payable was paid on `paidOn` (the day the money moved). */
  markPaid: (
    token: string,
    assignment: number,
    body: { paidOn: string; note?: string },
  ) =>
    call<{ payment: { status: PaymentStatus; paidOn: string | null } }>(
      `/api/assignments/${assignment}/payment`,
      token,
      { method: 'POST', body },
    ),
  /** Withdraws a payment record to correct it; the log keeps both events. */
  reopenPayment: (token: string, assignment: number) =>
    call<{ payment: { status: PaymentStatus } }>(
      `/api/assignments/${assignment}/payment/reopen`,
      token,
      { method: 'POST', body: {} },
    ),
  /** The signed-in vendor's payment record across every roster that lists them. */
  vendorPayments: (token: string, signal?: AbortSignal) =>
    call<{ payments: VendorPaymentRow[]; totals: CurrencyTotal[] }>(
      '/api/vendor/payments',
      token,
      { signal },
    ),
  me: (token: string, signal?: AbortSignal) =>
    call<Account>('/api/me', token, { signal }),
  projects: (token: string, signal?: AbortSignal) =>
    call<ProjectSummary[]>('/api/projects', token, { signal }),
  project: (token: string, name: string, signal?: AbortSignal) =>
    call<ProjectDetail>(projectUrl(name), token, { signal }),
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
    return call<{ file: FileSummary; locked: number }>(
      projectUrl(name, `/files`),
      token,
      {
        method: 'POST',
        body: form,
      },
    );
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
    call<{ jobs: Array<ImportJob | ScanJob> }>('/api/jobs', token, { signal }),
  /**
   * Starts the stale-work check of a memory against one of the account's glossaries
   * (backlog #122): answers at once with the job, which `scanJob` follows and
   * `cancelScan` stops.
   */
  startStaleScan: (
    token: string,
    tm: string,
    body: { glossary: string; srcLang: string; tgtLang: string },
  ) =>
    call<{ job: ScanJob }>(`/api/tms/${encodeURIComponent(tm)}/stale-scan`, token, {
      method: 'POST',
      body,
    }),
  scanJob: (token: string, id: string, signal?: AbortSignal) =>
    call<ScanJob>(`/api/jobs/${id}`, token, { signal }),
  cancelScan: (token: string, id: string) =>
    call<ScanJob>(`/api/jobs/${id}`, token, { method: 'DELETE' }),
  importJob: (token: string, id: string, signal?: AbortSignal) =>
    call<ImportJob>(`/api/jobs/${id}`, token, { signal }),
  /** Asks the server to stop it; the job is `running` until it has. */
  cancelImport: (token: string, id: string) =>
    call<ImportJob>(`/api/jobs/${id}`, token, { method: 'DELETE' }),
  projectMemories: (token: string, name: string, signal?: AbortSignal) =>
    call<{ refs: TmRefView[] }>(projectUrl(name, `/tms`), token, { signal }),
  attachMemory: (token: string, name: string, tm: string, writeTarget: boolean) =>
    call<{ refs: TmRefView[] }>(projectUrl(name, `/tms`), token, {
      method: 'POST',
      body: { tm, writeTarget },
    }),
  /** The whole consultation order, first consulted first. */
  orderMemories: (token: string, name: string, order: readonly number[]) =>
    call<{ refs: TmRefView[] }>(projectUrl(name, `/tms`), token, {
      method: 'PUT',
      body: { order },
    }),
  setWriteMemory: (token: string, name: string, refId: number) =>
    call<{ refs: TmRefView[] }>(projectUrl(name, `/tms/${refId}/write-target`), token, {
      method: 'POST',
    }),
  detachMemory: (token: string, name: string, refId: number) =>
    call<{ refs: TmRefView[] }>(projectUrl(name, `/tms/${refId}`), token, {
      method: 'DELETE',
    }),
  fuzzyThreshold: (token: string, name: string, signal?: AbortSignal) =>
    call<FuzzyThresholdView>(projectUrl(name, `/fuzzy-threshold`), token, { signal }),
  setFuzzyThreshold: (
    token: string,
    name: string,
    threshold: number | null | 'default',
  ) =>
    call<FuzzyThresholdView>(projectUrl(name, `/fuzzy-threshold`), token, {
      method: 'PUT',
      body: { threshold },
    }),
  pretranslate: (token: string, name: string) =>
    call<PretranslateSummary>(projectUrl(name, `/pretranslate`), token, {
      method: 'POST',
    }),
  segments: (token: string, name: string, fileId: number, signal?: AbortSignal) =>
    call<FileSegments>(projectUrl(name, `/files/${fileId}/segments`), token, { signal }),
  qaIssues: (token: string, name: string, fileId: number, signal?: AbortSignal) =>
    call<{ issues: QaIssue[] }>(projectUrl(name, `/files/${fileId}/qa-issues`), token, {
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
      projectUrl(name, `/segments/${segmentId}/qa-issues/${rule}`),
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
    }>(projectUrl(name, `/segments/${segmentId}`), token, {
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
    }>(projectUrl(name, `/segments/${segmentId}/confirm`), token, {
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
    call<Restructured>(projectUrl(name, `/segments/${segmentId}/split`), token, {
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
    call<Restructured>(projectUrl(name, `/segments/${segmentId}/merge`), token, {
      method: 'POST',
      body,
    }),
  // --- glossaries (smart-glossary-spec.md §5a; backlog #43a-c) -------
  glossaries: (token: string, signal?: AbortSignal) =>
    call<{ slug: string }[]>('/api/glossaries', token, { signal }),
  createGlossary: (token: string, name: string) =>
    call<{ slug: string }>('/api/glossaries', token, { method: 'POST', body: { name } }),
  projectGlossaries: (token: string, name: string, signal?: AbortSignal) =>
    call<{ refs: GlossaryRefView[] }>(projectUrl(name, `/glossaries`), token, { signal }),
  /** Attaches after the others; as the write target if asked. */
  attachGlossary: (token: string, name: string, glossary: string, writeTarget: boolean) =>
    call<{ refs: GlossaryRefView[] }>(projectUrl(name, `/glossaries`), token, {
      method: 'POST',
      body: { glossary, writeTarget },
    }),
  /** The file's held session, or null when none has been started. */
  glossarySession: async (
    token: string,
    name: string,
    fileId: number,
    signal?: AbortSignal,
  ): Promise<SessionView | null> => {
    try {
      return (
        await call<{ session: SessionView }>(glossaryUrl(name, fileId), token, { signal })
      ).session;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },
  /** Detection over the file; replaces a session already open for it. */
  startGlossarySession: (token: string, name: string, fileId: number) =>
    call<{ replaced: boolean; session: SessionView }>(glossaryUrl(name, fileId), token, {
      method: 'POST',
    }),
  /** `choose`, `propose`, `skip` or `reopen`: each answers with the whole session. */
  glossaryDecide: (
    token: string,
    name: string,
    fileId: number,
    action: 'choose' | 'propose' | 'skip' | 'reopen',
    body: Record<string, string>,
  ) =>
    call<{ session: SessionView }>(`${glossaryUrl(name, fileId)}/${action}`, token, {
      method: 'POST',
      body,
    }),
  commitGlossarySession: (token: string, name: string, fileId: number) =>
    call<{ written: number; session: SessionView }>(
      `${glossaryUrl(name, fileId)}/commit`,
      token,
      { method: 'POST' },
    ),
  discardGlossarySession: (token: string, name: string, fileId: number) =>
    call<{ session: SessionView }>(glossaryUrl(name, fileId), token, {
      method: 'DELETE',
    }),
  glossaryMismatches: (
    token: string,
    name: string,
    fileId: number,
    signal?: AbortSignal,
  ) =>
    call<MismatchList>(projectUrl(name, `/files/${fileId}/glossary/mismatches`), token, {
      signal,
    }),
  /** Records a mismatch row as a segment exception (backlog #110): evidence, never a ruling. */
  recordException: (
    token: string,
    name: string,
    fileId: number,
    segmentId: number,
    termId: number,
  ) =>
    call<{ ok: true }>(projectUrl(name, `/files/${fileId}/glossary/exceptions`), token, {
      method: 'POST',
      body: { segmentId, termId },
    }),
  glossaryProposals: (token: string, name: string, signal?: AbortSignal) =>
    call<{ glossary: string | null; proposals: ExceptionProposalView[] }>(
      projectUrl(name, '/glossary/proposals'),
      token,
      { signal },
    ),
  acceptProposal: (
    token: string,
    name: string,
    p: { termId: number; lang: string; chosen: string },
  ) =>
    call<{ ok: true }>(projectUrl(name, '/glossary/proposals/accept'), token, {
      method: 'POST',
      body: p,
    }),
  /** Resolves once every write sent so far, and any it set off, has settled. */
  settled: async (): Promise<void> => {
    while (writes.size > 0) await Promise.allSettled([...writes]);
  },
};
