/**
 * The account screen's logic (issue #317, `planning/sso-spec.md` D3, D7, §2a), pure so it is
 * tested in node: what the policy form sends, what is wrong with it before it is sent, and when an
 * unlink button can work. The server checks every one of these again; this only saves a round trip.
 */
import type { SsoPolicyView } from './api.js';

/** The policy form as typed: a blank lock is no lock. */
export interface PolicyDraft {
  readonly requireSso: boolean;
  readonly microsoftTid: string;
  readonly googleHd: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** The form filled from what is stored. */
export function draftOf(policy: SsoPolicyView): PolicyDraft {
  return {
    requireSso: policy.requireSso,
    microsoftTid: policy.microsoftTid ?? '',
    googleHd: policy.googleHd ?? '',
  };
}

/** What the form sends: trimmed, a blank lock as `null`. */
export function policyOf(draft: PolicyDraft): SsoPolicyView {
  const tid = draft.microsoftTid.trim();
  const hd = draft.googleHd.trim();
  return {
    requireSso: draft.requireSso,
    microsoftTid: tid === '' ? null : tid,
    googleHd: hd === '' ? null : hd,
  };
}

/** Why the form cannot be sent as it is, or `null`. */
export function policyProblem(draft: PolicyDraft): string | null {
  const { microsoftTid, googleHd } = policyOf(draft);
  if (microsoftTid !== null && !GUID.test(microsoftTid)) {
    return 'A Microsoft directory id looks like 6f1b2c3d-1111-4222-8333-944455556666.';
  }
  if (googleHd !== null && (googleHd.length > 253 || !HOST.test(googleHd))) {
    return 'A Google Workspace domain looks like example.org.';
  }
  return null;
}

/**
 * Whether removing one linked sign-in leaves a way in: a password, or another link. Mirrors the
 * server's refusal (`LastWayInError`) so the button says so instead of failing when clicked.
 * `hasPassword` is unknown to the page for now, so it is passed as what the server last said.
 */
export function canUnlink(linkCount: number, hasPassword: boolean): boolean {
  return hasPassword || linkCount > 1;
}
