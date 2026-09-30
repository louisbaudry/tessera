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
] as const;

export const PORTAL_AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'file.downloaded',
  'file.delivered',
  'order.priced',
  'order.price_baseline',
] as const;

export type ProjectAuditAction = (typeof PROJECT_AUDIT_ACTIONS)[number];
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];
export type PortalAuditAction = (typeof PORTAL_AUDIT_ACTIONS)[number];
export type AuditAction = ProjectAuditAction | PlatformAuditAction | PortalAuditAction;

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
  };
  /** The digest of the document produced — what exactly left. */
  'project.exported': { readonly sha256: string };
  'project.setting_changed': {
    readonly key: string;
    readonly from: JsonValue;
    readonly to: JsonValue;
  };
  'ai.requested': AiProvenance;
  // platform.sqlite (backlog #57, spec §2.5). Nothing personal in a
  // detail: it is hashed, so erasure could never reach it.
  'auth.login': null;
  /** Kept in the log, never told apart in the HTTP response. */
  'auth.login_failed': { readonly reason: 'unknown_email' | 'wrong_password' };
  'auth.logout': null;
  'account.created': null;
  'authorization.granted': null;
  'authorization.revoked': null;
  'project.created': null;
  'project.deleted': null;
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
}

/** An order's price and the word count it was computed from (spec §2.6). */
export interface OrderPrice {
  readonly word_count: number;
  readonly price: number;
}
