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

import type { ProjectScope } from '../auth/authorization.js';
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
  'ai.requested',
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
] as const;

export const PORTAL_AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'file.downloaded',
  'file.delivered',
  'order.priced',
  'order.price_baseline',
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
  'ai.requested': AiProvenance;
  // platform.sqlite (backlog #57, spec §2.5). Nothing personal in a
  // detail: it is hashed, so erasure could never reach it.
  'auth.login': null;
  /** Kept in the log, never told apart in the HTTP response. */
  'auth.login_failed': { readonly reason: 'unknown_email' | 'wrong_password' };
  'auth.logout': null;
  'account.created': null;
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
   */
  'invitation.accepted': {
    readonly owner_id: number;
    readonly account_id: number;
    readonly existing?: true;
  };
  /** `superseded` when a newer invitation to the same address replaced it. */
  'invitation.revoked': { readonly superseded: true } | null;
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
  /** The count the admin confirmed and the total it priced to (backlog #63). */
  'order.priced': OrderPrice;
  /** The price as it stood when portal v4 began recording (spec §6). */
  'order.price_baseline': OrderPrice;
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
}

/** An order's price and the word count it was computed from (spec §2.6). */
export interface OrderPrice {
  readonly word_count: number;
  readonly price: number;
}
