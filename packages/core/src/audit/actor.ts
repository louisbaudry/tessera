/**
 * The audit actor: who caused a change, as the `kind:id` string stored in
 * `audit_event.actor`. `planning/audit-spec.md` §2.1 — the grammar, and
 * what each kind is worth as an identity, are recorded there.
 *
 * Pure: the CLI and the server supply the facts (an OS user name, a
 * session's account id); `core` never asks the OS for anything.
 */

export const ACTOR_KINDS = ['account', 'admin', 'client', 'cli', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export type Actor =
  /** `platform.sqlite` `account.id` — an authenticated session. */
  | { readonly kind: 'account'; readonly id: number }
  /** `portal.sqlite` `admin_user.id` — an authenticated session. */
  | { readonly kind: 'admin'; readonly id: number }
  /** A portal order id: whoever holds the private link, not a person. */
  | { readonly kind: 'client'; readonly id: number }
  /** An OS user name, self-asserted — the CLI has no login. */
  | { readonly kind: 'cli'; readonly name: string }
  /** A named unattended job, e.g. `migration`. */
  | { readonly kind: 'system'; readonly name: string };

/**
 * Who caused a write, as every audited repository call takes it: the
 * principal, and the human-readable label snapshotted beside it into
 * `actor_label` (spec §2.1). `label` is required but nullable — a
 * `system:` job has none, and a caller has to say so rather than forget.
 */
export interface AuditActor {
  readonly actor: Actor;
  readonly label: string | null;
}

// One spelling per id: `account:03` and `account:3` would be two actors.
const ROW_ID = /^[1-9][0-9]*$/;
const JOB_NAME = /^[a-z][a-z0-9._-]*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function rowId(text: string): number | null {
  if (!ROW_ID.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

function validName(kind: 'cli' | 'system', name: string): boolean {
  if (kind === 'system') return JOB_NAME.test(name);
  return name.length > 0 && name.trim() === name && !CONTROL.test(name);
}

/** Parses a stored actor string; throws on anything that is not exactly one actor. */
export function parseActor(text: string): Actor {
  const colon = text.indexOf(':');
  const kind = colon < 0 ? text : text.slice(0, colon);
  const id = colon < 0 ? '' : text.slice(colon + 1);
  switch (kind) {
    case 'account':
    case 'admin':
    case 'client': {
      const n = rowId(id);
      if (n !== null) return { kind, id: n };
      break;
    }
    case 'cli':
    case 'system':
      if (validName(kind, id)) return { kind, name: id };
      break;
    default:
      throw new Error(`malformed actor ${JSON.stringify(text)}: unknown kind`);
  }
  throw new Error(`malformed actor ${JSON.stringify(text)}: bad ${kind} id`);
}

/** The stored string for `actor`; throws if it breaks the grammar `parseActor` enforces. */
export function formatActor(actor: Actor): string {
  const text = `${actor.kind}:${'id' in actor ? String(actor.id) : actor.name}`;
  parseActor(text); // one grammar, applied in one place
  return text;
}
