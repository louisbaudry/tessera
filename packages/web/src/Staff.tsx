/**
 * An admin's staff screen (backlog #210; `planning/tenant-spec.md` D5, §6): who works
 * for the tenant and in which role, and the one-time links that add someone. The link
 * is shown once, in the response that created it, and passed on by the admin: this
 * server has no mail sender, and only the link's hash is kept. A lost link is replaced
 * by inviting the address again. A pm never reaches this screen (the shell hides it and
 * the server refuses it), and the only admin cannot be demoted or removed, which the
 * row says rather than failing when clicked.
 */
import { useCallback, useState, type FormEvent } from 'react';

import type { TenantRole } from '@cat-tool/core';

import { api, type StaffInvitationView, type StaffMember } from './api.js';
import { formatDeadline } from './jobs.js';
import {
  canWithdraw,
  INVITATION_STATUS_LABEL,
  INVITATION_TTL_DAYS,
} from './invitations.js';
import {
  memberControls,
  STAFF_ROLE_HELP,
  STAFF_ROLE_LABEL,
  STAFF_ROLES,
  staffInviteLink,
  staffInviteProblem,
} from './staff.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function Staff() {
  // Bumped after a write, which is part of each list's key: the lists are read again
  // from the server instead of patched, so what shows is what is stored.
  const [version, setVersion] = useState(0);
  const [fresh, setFresh] = useState<{ email: string; link: string } | null>(null);
  const changed = () => setVersion((v) => v + 1);
  return (
    <div className="page staff">
      <h2>Staff</h2>
      <Invite
        onInvited={(email, link) => {
          setFresh({ email, link });
          changed();
        }}
      />
      {fresh && <FreshLink email={fresh.email} link={fresh.link} />}
      <StaffLists key={version} onChanged={changed} />
    </div>
  );
}

function Invite({ onInvited }: { onInvited: (email: string, link: string) => void }) {
  const action = useAction();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TenantRole>('pm');
  const problem = staffInviteProblem(email);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem !== null) return;
    const done = await action.run((token) => api.inviteStaff(token, { email, role }));
    if (done) {
      onInvited(done.invitation.email, staffInviteLink(window.location, done.token));
      setEmail('');
    }
  };

  return (
    <form className="panel form" onSubmit={(e) => void submit(e)}>
      <h3>Invite a colleague</h3>
      <p className="muted">
        Enter their address and choose a role. You get a link to pass on, valid for{' '}
        {INVITATION_TTL_DAYS} days and good for one use: whoever opens it sets a password
        and joins your staff.
      </p>
      <label>
        Email
        <input
          type="email"
          value={email}
          required
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as TenantRole)}>
          {STAFF_ROLES.map((r) => (
            <option key={r} value={r}>
              {STAFF_ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">{STAFF_ROLE_HELP[role]}</p>
      <div className="actions">
        <button type="submit" disabled={action.busy || problem !== null}>
          Create link
        </button>
        {email !== '' && problem && <span className="muted">{problem}</span>}
        {action.error && <span className="error">{action.error}</span>}
      </div>
    </form>
  );
}

/** The link, once. Closing it or inviting again forgets it: it is not stored anywhere readable. */
function FreshLink({ email, link }: { email: string; link: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard permission: the box below can be selected by hand.
    }
  };
  return (
    <section className="panel fresh-link" aria-label="New staff link">
      <h3>Link for {email}</h3>
      <p className="muted">
        Copy it now and send it yourself. It is not shown again; if it is lost, invite the
        address again.
      </p>
      <div className="copy-row">
        <input
          type="text"
          readOnly
          value={link}
          aria-label="Staff link"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </section>
  );
}

function StaffLists({ onChanged }: { onChanged: () => void }) {
  const list = useLoad(useCallback((token, signal) => api.staff(token, signal), []));
  if (list.state === 'loading') return <p className="muted">Loading{'…'}</p>;
  if (list.state === 'error') return <p className="error">{list.message}</p>;
  const { staff, invitations } = list.data;
  return (
    <>
      <section className="list" aria-label="Your staff">
        <h3>
          Your staff <span className="muted">{staff.length}</span>
        </h3>
        <table className="ledger" aria-label="Your staff">
          <thead>
            <tr>
              <th>Address</th>
              <th>Role</th>
              <th>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => (
              <MemberLine
                key={member.accountId}
                staff={staff}
                member={member}
                onChanged={onChanged}
              />
            ))}
          </tbody>
        </table>
      </section>
      {invitations.length > 0 && (
        <section className="list" aria-label="Staff invitations">
          <h3>Invitations</h3>
          <table className="ledger" aria-label="Staff invitations">
            <thead>
              <tr>
                <th>Address</th>
                <th>Role</th>
                <th>Status</th>
                <th>Sent</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invitations.map((i) => (
                <InvitationLine key={i.id} invitation={i} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function MemberLine({
  staff,
  member,
  onChanged,
}: {
  staff: readonly StaffMember[];
  member: StaffMember;
  onChanged: () => void;
}) {
  const action = useAction();
  const controls = memberControls(staff, member);
  const setRole = async (role: TenantRole) => {
    const done = await action.run((token) =>
      api.changeStaffRole(token, member.accountId, role),
    );
    if (done) onChanged();
  };
  const remove = async () => {
    const who = member.you ? 'yourself' : member.email;
    if (
      !window.confirm(
        `Remove ${who} from your staff? ${member.you ? 'You' : 'They'} will be signed out at once.`,
      )
    ) {
      return;
    }
    const done = await action.run((token) => api.removeStaff(token, member.accountId));
    if (done) onChanged();
  };
  return (
    <tr>
      <td>
        {member.email}
        {member.you && <span className="muted"> (you)</span>}
      </td>
      <td>
        <select
          aria-label={`Role of ${member.email}`}
          value={member.role}
          disabled={action.busy || !controls.canDemote}
          onChange={(e) => void setRole(e.target.value as TenantRole)}
        >
          {STAFF_ROLES.map((r) => (
            <option key={r} value={r}>
              {STAFF_ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </td>
      <td className="when">{formatDeadline(member.addedAt)}</td>
      <td>
        <button
          type="button"
          className="link"
          disabled={action.busy || !controls.canRemove}
          onClick={() => void remove()}
        >
          Remove
        </button>
        {controls.why && <span className="muted"> {controls.why}</span>}
        {action.error && <span className="error"> {action.error}</span>}
      </td>
    </tr>
  );
}

function InvitationLine({
  invitation,
  onChanged,
}: {
  invitation: StaffInvitationView;
  onChanged: () => void;
}) {
  const action = useAction();
  const withdraw = async () => {
    const done = await action.run((token) =>
      api.revokeStaffInvitation(token, invitation.id),
    );
    if (done) onChanged();
  };
  return (
    <tr>
      <td>{invitation.email}</td>
      <td>{STAFF_ROLE_LABEL[invitation.role]}</td>
      <td>
        <span className={`chip invite-${invitation.status}`}>
          {INVITATION_STATUS_LABEL[invitation.status]}
        </span>
        {invitation.status === 'pending' && (
          <span className="muted"> until {formatDeadline(invitation.expiresAt)}</span>
        )}
      </td>
      <td className="when">{formatDeadline(invitation.createdAt)}</td>
      <td>
        {canWithdraw(invitation.status) && (
          <button
            type="button"
            className="link"
            disabled={action.busy}
            onClick={() => void withdraw()}
          >
            Withdraw
          </button>
        )}
        {action.error && <span className="error">{action.error}</span>}
      </td>
    </tr>
  );
}
