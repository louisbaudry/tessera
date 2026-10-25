/**
 * What the tenant audit screen shows of an event (backlog #211, `planning/audit-spec.md`
 * §3.1): a sentence for each action, who did it and what it was about. Pure, so it is
 * proved in node. The log holds ids and states only, by its own rule, so the screen can
 * only name a thing by its id (a project by its name, which the log keeps in the subject).
 */
import type { PlatformAuditAction } from '@cat-tool/core';

/** One event as `GET /api/audit` returns it. */
export interface AuditEventView {
  readonly id: number;
  readonly at: string;
  readonly actor: string;
  readonly actorLabel: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly detail: unknown;
}

/** A `Record` over core's union, so a platform action added there fails this typecheck until it is worded here. */
export const ACTION_LABEL: Record<PlatformAuditAction, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'A sign-in was refused',
  'auth.logout': 'Signed out',
  'account.created': 'An account was created',
  'authorization.granted': 'Access to a project was granted',
  'authorization.revoked': 'Access to a project was withdrawn',
  'project.created': 'A project was created',
  'project.deleted': 'A project was deleted',
  'file.downloaded': 'A file was downloaded',
  'invitation.created': 'An invitation was created',
  'invitation.accepted': 'An invitation was accepted',
  'invitation.revoked': 'An invitation was withdrawn',
  'client_engine.changed': 'A client’s engine setting changed',
  'tenant.created': 'The organisation was created',
  'tenant.renamed': 'The organisation was renamed',
  'tenant.member_added': 'Someone joined the staff',
  'tenant.member_removed': 'Someone was removed from the staff',
  'tenant.role_changed': 'A staff role changed',
  'tenant.audit_exported': 'This log was exported by the operator',
  'auth.sso_login': 'Signed in with Microsoft or Google',
  'auth.sso_login_failed': 'A Microsoft or Google sign-in was refused',
  'account.sso_linked': 'A Microsoft or Google account was linked',
  'account.sso_unlinked': 'A Microsoft or Google account was unlinked',
  'tenant.slug_set': 'The organisation’s web address was set',
};

const isKnown = (action: string): action is PlatformAuditAction => action in ACTION_LABEL;

/** The sentence for an action; an action this build does not know is shown as it is, never hidden. */
export const actionLabel = (action: string): string =>
  isKnown(action) ? ACTION_LABEL[action] : action;

/** Who did it: the label written at the time, else the actor's own id (`account:3`, `cli:root`). */
export const whoLabel = (event: Pick<AuditEventView, 'actor' | 'actorLabel'>): string =>
  event.actorLabel !== null && event.actorLabel !== '' ? event.actorLabel : event.actor;

/**
 * What it was about, in words: a project by its name (the log's subject is
 * `t<tenant>/<name>`, or the older `<account>/<name>`; the prefix is an id nobody needs), anything
 * else by its kind and id. `null` when the event names no subject.
 */
export function aboutLabel(
  event: Pick<AuditEventView, 'subjectType' | 'subjectId'>,
): string | null {
  const { subjectType, subjectId } = event;
  if (subjectId === null) return null;
  if (subjectType === 'project')
    return `Project ${subjectId.slice(subjectId.indexOf('/') + 1)}`;
  if (subjectType === 'client') return `Client ${subjectId}`;
  return `${subjectType} #${subjectId}`;
}
