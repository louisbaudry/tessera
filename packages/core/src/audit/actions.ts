/**
 * The audit action vocabulary and each action's `detail` shape
 * (`planning/audit-spec.md` §2.2). One list per database: the actions
 * that can happen in that file. Each file's `CHECK (action IN (...))` is
 * a frozen snapshot of its list, written as a literal in the migration
 * that created it, never read from here (`db/migrate.ts`, backlog #64);
 * a guard test ties the newest snapshot to this list. Adding an action
 * is a migration that widens a CHECK: an action nobody declared is a
 * write path nobody reviewed.
 */

import type { ProjectScope, TenantRole } from '../auth/authorization.js';
import type { SsoFailure, SsoProvider } from '../auth/sso.js';
import type { QaRule } from '../model/qa.js';
import type { Origin, SegmentStatus } from '../model/segment.js';
import type { Token } from '../model/token.js';

export const PROJECT_AUDIT_ACTIONS = [
  'segment.target_set',
  'segment.confirmed',
  'segment.locked',
  'segment.unlocked',
  'segment.baseline',
  'segment.split',
  'segment.merged',
  'file.added',
  'project.pretranslate',
  'project.exported',
  'project.setting_changed',
  'qa.dismissed',
  'qa.reinstated',
  'draft.purged',
  'ai.requested',
  'tm.unit_edited',
  'tm.unit_retired',
  'project.replaced',
  'reference.added',
  'reference.removed',
] as const;

export const PLATFORM_AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'account.created',
  'authorization.granted',
  'authorization.revoked',
  'project.created',
  'project.deleted',
  'file.downloaded',
  'invitation.created',
  'invitation.accepted',
  'invitation.revoked',
  'client_engine.changed',
  'tenant.created',
  'tenant.renamed',
  'tenant.member_added',
  'tenant.member_removed',
  'tenant.role_changed',
  'tenant.audit_exported',
  'tenant.slug_set',
  'auth.sso_login',
  'auth.sso_login_failed',
  'account.sso_linked',
  'account.sso_unlinked',
] as const;

export const PORTAL_AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'file.downloaded',
  'file.delivered',
  'order.priced',
  'order.price_baseline',
  'resource.linked',
  'resource.unlinked',
  'resource.exported',
] as const;

/**
 * `vendors.ctv` (backlog #46, vendor-spec.md §5 note): the roster and what
 * the owner pays. A capacity toggle is not here on purpose (decision 8).
 */
export const VENDOR_AUDIT_ACTIONS = [
  'vendor.added',
  'vendor.profile_changed',
  'vendor.rate_set',
  'payables.exported',
  'webhook.created',
  'webhook.deleted',
  'webhook.reminder_changed',
  'client_pool.changed',
] as const;

export type ProjectAuditAction = (typeof PROJECT_AUDIT_ACTIONS)[number];
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];
export type PortalAuditAction = (typeof PORTAL_AUDIT_ACTIONS)[number];
export type VendorAuditAction = (typeof VENDOR_AUDIT_ACTIONS)[number];
export type AuditAction =
  ProjectAuditAction | PlatformAuditAction | PortalAuditAction | VendorAuditAction;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Where an AI-produced draft came from (spec §4). The prompt itself is
 * never recorded — it carries TM matches and glossary, i.e. client
 * content a second time — only the digest of the assembled input.
 */
export interface AiProvenance {
  /** e.g. `deepl`, `anthropic`. */
  readonly engine: string;
  /** The exact model id the engine reported. */
  readonly model: string;
  /** A named, versioned prompt template — never an inline string. */
  readonly prompt_version: string;
  readonly input_sha256: string;
}

/** A segment's state after a change: the state before is the previous event. */
export interface SegmentStateDetail {
  readonly status: SegmentStatus;
  readonly origin: Origin | null;
  readonly target_tokens: readonly Token[] | null;
  /** Present when the target was an accepted AI draft (spec §4). */
  readonly provenance?: AiProvenance;
}

/** Which client's link, and of what: the whole of a link/unlink event's detail. */
export interface ClientResourceDetail {
  readonly client_id: number;
  readonly kind: 'tm' | 'glossary';
}

/** Each action's `detail`, stored as JSON in `audit_event.detail`. */
export interface AuditDetail {
  'segment.target_set': SegmentStateDetail;
  'segment.confirmed': {
    readonly tm_write: { readonly tu_uuid: string; readonly rev: number } | null;
  };
  'segment.locked': null;
  'segment.unlocked': null;
  /** What the segment was when recording began (spec §6) — never an invented author. */
  'segment.baseline': SegmentStateDetail;
  /**
   * One segment became two (v1-spec.md §7.4). The subject is the row that
   * kept its id — the first half; the second is a new row, named here.
   * Both states are as stored after the split.
   */
  'segment.split': {
    readonly new_segment_id: number;
    /** Plain-text offset into the source at which it was cut. */
    readonly offset: number;
    readonly first: SegmentStateDetail;
    readonly second: SegmentStateDetail;
  };
  /**
   * Two segments became one. The subject is the survivor (the first); the
   * second's row is gone, its history still in the log under its id.
   */
  'segment.merged': {
    readonly removed_segment_id: number;
    readonly state: SegmentStateDetail;
  };
  'file.added': { readonly rel_path: string; readonly sha256: string };
  'project.pretranslate': {
    readonly tm_refs: readonly string[];
    readonly counts: { readonly [outcome: string]: number };
    /** The fuzzy threshold the run used, or null when fuzzy was off (or the source unspaced). */
    readonly fuzzy_threshold?: number | null;
  };
  /** The digest of the document produced — what exactly left. */
  'project.exported': { readonly sha256: string };
  'project.setting_changed': {
    readonly key: string;
    readonly from: JsonValue;
    readonly to: JsonValue;
  };
  /**
   * A finding set aside, or set aside no longer (backlog #33). The subject
   * is its segment: a dismissal is kept per segment and rule, across every
   * rerun that finds the rule again (`replaceQaIssues`), so the issue's own
   * row id — new on each rerun — would name nothing a reader could find.
   */
  'qa.dismissed': { readonly rule: QaRule };
  'qa.reinstated': { readonly rule: QaRule };
  /**
   * A draft engine's unaccepted suggestions deleted because the client withdrew
   * its consent to that engine (backlog #137, `translation-engine-spec.md` D15).
   * The subject is the project. Logged only when something was deleted; the
   * withdrawal itself is `client_engine.changed` in `platform.sqlite`.
   */
  'draft.purged': {
    readonly engine: string;
    readonly count: number;
    readonly reason: 'consent_withdrawn';
  };
  'ai.requested': AiProvenance;
  /**
   * A translation in one of the project's memories corrected by the owner from
   * the concordance box (issue #151, `v1-spec.md` §6.1c). The subject is the
   * project: a `.ctm` has no log of its own. Never the text, which is client
   * content and could not be erased from a hashed detail; the old revision is in
   * the memory's `tuv_history`.
   */
  'tm.unit_edited': {
    /** The project's own `tm_ref.id`, never a path. */
    readonly tm_ref: number;
    readonly tu_uuid: string;
    readonly lang: string;
    readonly from_rev: number;
    readonly to_rev: number;
  };
  /**
   * One find-and-replace run over a project's targets (backlog #148b,
   * `v1-spec.md` §7.8): the batch parent of the `segment.target_set` events it
   * wrote, as `project.pretranslate` is. Never the pattern or the replacement,
   * which are the owner's own words and may carry a client's.
   */
  'project.replaced': {
    readonly regex: boolean;
    readonly case_sensitive: boolean;
    /** Segments written. */
    readonly segments: number;
    /** Matches replaced in them. */
    readonly matches: number;
    /** Segments skipped because they changed after the preview. */
    readonly stale: number;
    /** Segments skipped because they are locked. */
    readonly locked: number;
  };
  /**
   * A reference file attached to a project (issue #203, `v1-spec.md` §7.9).
   * Subject: the `reference_file` row. Never the name or the label, which may
   * carry a client's name into a field that cannot be erased.
   */
  'reference.added': {
    readonly media_type: string;
    readonly size: number;
    readonly sha256: string;
  };
  /** A reference file removed from a project; the row is gone, this is the trace. */
  'reference.removed': {
    readonly size: number;
    readonly sha256: string;
  };
  /** A unit tombstoned in one of the project's memories (`v1-spec.md` §6.1c). */
  'tm.unit_retired': {
    readonly tm_ref: number;
    readonly tu_uuid: string;
  };
  // platform.sqlite (backlog #57, spec §2.5). Nothing personal in a
  // detail: it is hashed, so erasure could never reach it.
  'auth.login': null;
  /** Kept in the log, never told apart in the HTTP response. */
  'auth.login_failed': {
    readonly reason: 'unknown_email' | 'wrong_password' | 'not_on_this_host';
  };
  'auth.logout': null;
  'account.created': null;
  /** A sign-in through a provider (`planning/sso-spec.md` D9): which one, never who it said. */
  'auth.sso_login': { readonly provider: SsoProvider };
  /** Told apart in the log, never in the response; no address, subject or claim. */
  'auth.sso_login_failed': {
    readonly provider: SsoProvider | null;
    readonly reason: SsoFailure;
  };
  /** Subject: the account. An identity at a provider was tied to it. */
  'account.sso_linked': { readonly provider: SsoProvider };
  'account.sso_unlinked': { readonly provider: SsoProvider };
  /**
   * Subject: the project. The grantee is an account id, installation-local
   * and not personal (audit-spec.md §2.5); `#45`.
   */
  'authorization.granted': {
    readonly grantee: number;
    readonly scope: ProjectScope;
  };
  'authorization.revoked': {
    readonly grantee: number;
    readonly scope: ProjectScope;
  };
  'project.created': null;
  'project.deleted': null;
  // An owner's invitation to a vendor (backlog #111). The invitation is the
  // subject. The invitee's email is in `vendor_invitation` and `account`, never
  // here: a detail is hashed, so erasure could not reach it.
  'invitation.created': null;
  /**
   * Both ids are installation-local and not personal. The actor is the new account,
   * or, with `existing`, a vendor who already had one and signed in to join (#187).
   * `tenant_id` since backlog #205; events written before it carry `owner_id` (the
   * founding account's id) instead, and keep it: a log is never rewritten.
   */
  'invitation.accepted': {
    readonly tenant_id: number;
    readonly account_id: number;
    readonly existing?: true;
  };
  /** `superseded` when a newer invitation to the same address replaced it. */
  'invitation.revoked': { readonly superseded: true } | null;
  /**
   * A client's consent to a draft engine, or its default engine, changed
   * (backlog #133, translation-engine-spec D4, D19). The subject is the
   * client, by the number the owner typed; `key` is `consent:<engine>` or
   * `default`. The client's name is never here: a detail is hashed.
   */
  'client_engine.changed': {
    readonly client_id: number;
    readonly key: string;
    readonly from: JsonValue;
    readonly to: JsonValue;
  };
  /**
   * A tenant and its first admin came into being (`planning/tenant-spec.md` D9,
   * backlog #204). The subject is the tenant. The tenant's name is a company's
   * and a detail is hashed, so erasure could never reach it: it is in `tenant`
   * only. A tenant made by the migration has no event, since nothing recorded
   * who made it and an author is never invented (`audit-spec.md` §6).
   */
  'tenant.created': null;
  /** The display name changed; the subject is the tenant, and neither name is here. */
  'tenant.renamed': null;
  /**
   * The operator set the tenant's slug, once (backlog #209, `tenant-spec.md` D14). The subject
   * is the tenant, and the slug is not here: it derives from a company's name, so like the name
   * it is in `tenant` only.
   */
  'tenant.slug_set': null;
  /**
   * Someone became staff of a tenant, in a role (backlog #206): the subject is the tenant,
   * the account an installation-local id. The address is in `account`, never here.
   */
  'tenant.member_added': { readonly account_id: number; readonly role: TenantRole };
  /** Someone stopped being staff; their sessions ended in the same transaction. */
  'tenant.member_removed': { readonly account_id: number };
  /** A staff member's role changed; both roles are here because the log is the history. */
  'tenant.role_changed': {
    readonly account_id: number;
    readonly from: TenantRole;
    readonly to: TenantRole;
  };
  /**
   * The operator exported a tenant's slice of this log (backlog #211, the offboarding
   * property of `tenant-spec.md` §6 invariant 7). The subject is the tenant; what left is a
   * count and the digest of the bytes, no event.
   */
  'tenant.audit_exported': { readonly events: number; readonly sha256: string };
  /** The file's id and name where it lives, and the digest of the bytes sent. */
  'file.downloaded': {
    readonly file_id: number;
    readonly name: string;
    readonly sha256: string;
  };
  // portal.sqlite (backlog #58, spec §2.6). A file the portal stores is
  // the subject itself (`source_file` / `delivered_file`, its row id).
  /** A translated file stored for the client: which order, and exactly what bytes. */
  'file.delivered': {
    readonly order_id: number;
    readonly name: string;
    readonly sha256: string;
  };
  /**
   * The count the admin confirmed and the total it priced to (backlog #63); for
   * an order a per-file minimum applies to, also each source file's confirmed
   * count by file id (portal-v0-spec.md §4b).
   */
  'order.priced': OrderPrice & { readonly files?: Readonly<Record<string, number>> };
  /** The price as it stood when portal v4 began recording (spec §6). */
  'order.price_baseline': OrderPrice;
  // A client's linked memory/glossary (backlog #162). The file's name is not
  // in a detail: it often is the client's name, and a detail is hashed.
  'resource.linked': ClientResourceDetail;
  'resource.unlinked': ClientResourceDetail;
  /** Which client took which kind, how many units or renderings, and the digest of the bytes sent. */
  'resource.exported': ClientResourceDetail & {
    readonly count: number;
    readonly sha256: string;
  };
  // vendors.ctv (backlog #46). A name or an address is never in a detail:
  // it is hashed, so erasure could not reach it.
  'vendor.added': null;
  /** Which parts of the profile changed, never what they changed to. */
  'vendor.profile_changed': {
    readonly changed: readonly ('display_name' | 'languages' | 'specialties')[];
  };
  /** A price, not a person: the entry as written to the rate card. */
  'vendor.rate_set': {
    readonly src_lang: string;
    readonly tgt_lang: string;
    readonly tier: string;
    readonly rate_micros: number;
    readonly currency: string;
    readonly effective_from: string;
  };
  /**
   * The payables CSV left the system (backlog #112). What went, not who it
   * was about: a row count and the digest of the bytes, no name or amount.
   */
  'payables.exported': { readonly rows: number; readonly sha256: string };
  /**
   * A webhook endpoint was registered or removed (backlog #125). The host only:
   * the path and query may carry a token, and the secret is never logged.
   */
  'webhook.created': { readonly host: string };
  'webhook.deleted': { readonly host: string };
  /** The owner's deadline-reminder lead in hours, before and after (backlog #125, issue #155). */
  'webhook.reminder_changed': { readonly from: number; readonly to: number };
  /**
   * A portal client's vendor pool changed (backlog #130, issue #156): which
   * roster entries (their vendor ids, never names) joined it and which left.
   */
  'client_pool.changed': {
    readonly client_id: number;
    readonly added: readonly number[];
    readonly removed: readonly number[];
  };
}

/** An order's price and the word count it was computed from (spec §2.6). */
export interface OrderPrice {
  readonly word_count: number;
  readonly price: number;
}
