/**
 * The audit action vocabulary and each action's `detail` shape
 * (`planning/audit-spec.md` §2.2). One list per database, so each file's
 * `CHECK (action IN (...))` is generated from the list of actions that
 * can happen in that file — the way `qa_issue.rule` is generated from
 * `QA_RULES`. Adding an action is a migration that widens a CHECK: an
 * action nobody declared is a write path nobody reviewed.
 */

import type { Origin, SegmentStatus } from '../model/segment.js';
import type { Token } from '../model/token.js';

export const PROJECT_AUDIT_ACTIONS = [
  'segment.target_set',
  'segment.confirmed',
  'segment.locked',
  'segment.unlocked',
  'segment.baseline',
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
  // platform.sqlite / portal.sqlite: shapes fixed by backlog #57/#58.
  'auth.login': null;
  'auth.login_failed': null;
  'auth.logout': null;
  'account.created': null;
  'authorization.granted': null;
  'authorization.revoked': null;
  'project.created': null;
  'project.deleted': null;
  'file.downloaded': null;
  'file.delivered': null;
}
