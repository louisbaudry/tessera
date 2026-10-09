/**
 * The owner's vendors (backlog #111; `vendor-spec.md` §3, the #111 note): who is on
 * their roster, and the invitations that put someone there. An invitation makes a
 * one-time link that the owner passes on themselves: the server has no mail sender,
 * and the link is shown once, in the response that created it, because only its hash
 * is kept. A lost link is replaced by inviting the address again.
 */
import { useCallback, useState, type FormEvent } from 'react';

import { api, type InvitationView } from './api.js';
import { formatDeadline } from './jobs.js';
import {
  canWithdraw,
  inviteLink,
  inviteProblem,
  INVITATION_STATUS_LABEL,
  INVITATION_TTL_DAYS,
} from './invitations.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function Vendors() {
  // Bumped after a write, which is part of each list's key: the lists are read
  // again from the server instead of patched, so what shows is what is stored.
  const [version, setVersion] = useState(0);
  const [fresh, setFresh] = useState<{ email: string; link: string } | null>(null);
  return (
    <div className="page vendors">
      <h2>Vendors</h2>
      <Invite
        onInvited={(email, link) => {
          setFresh({ email, link });
          setVersion((v) => v + 1);
        }}
      />
      {fresh && <FreshLink email={fresh.email} link={fresh.link} />}
      <Invitations key={`i${version}`} onChanged={() => setVersion((v) => v + 1)} />
      <Roster key={`r${version}`} />
    </div>
  );
}

function Invite({ onInvited }: { onInvited: (email: string, link: string) => void }) {
  const action = useAction();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const problem = inviteProblem(email);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem !== null) return;
    const done = await action.run((token) =>
      api.invite(token, {
        email,
        ...(name.trim() === '' ? {} : { displayName: name.trim() }),
      }),
    );
    if (done) {
      onInvited(done.invitation.email, inviteLink(window.location, done.token));
      setEmail('');
      setName('');
    }
  };

  return (
    <form className="panel form" onSubmit={(e) => void submit(e)}>
      <h3>Invite a vendor</h3>
      <p className="muted">
        Enter the address of someone you work with. You get a link to pass on, valid for{' '}
        {INVITATION_TTL_DAYS} days and good for one use: whoever opens it sets a password
        and joins your roster.
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
        <span>
          Name on your roster <span className="muted">(optional)</span>
        </span>
        <input
          type="text"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
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
    <section className="panel fresh-link" aria-label="New invitation link">
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
          aria-label="Invitation link"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </section>
  );
}

function Invitations({ onChanged }: { onChanged: () => void }) {
  const list = useLoad(
    useCallback((token, signal) => api.invitations(token, signal), []),
  );
  if (list.state === 'loading') return <p className="muted">Loading{'…'}</p>;
  if (list.state === 'error') return <p className="error">{list.message}</p>;
  const { invitations } = list.data;
  if (invitations.length === 0) return null;
  return (
    <section className="list" aria-label="Invitations">
      <h3>Invitations</h3>
      <table className="ledger" aria-label="Invitations">
        <thead>
          <tr>
            <th>Address</th>
            <th>Name</th>
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
  );
}

function InvitationLine({
  invitation,
  onChanged,
}: {
  invitation: InvitationView;
  onChanged: () => void;
}) {
  const action = useAction();
  const withdraw = async () => {
    const done = await action.run((token) => api.revokeInvitation(token, invitation.id));
    if (done) onChanged();
  };
  return (
    <tr>
      <td>{invitation.email}</td>
      <td>{invitation.displayName ?? '—'}</td>
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

function Roster() {
  const roster = useLoad(
    useCallback((token, signal) => api.rosterVendors(token, signal), []),
  );
  if (roster.state !== 'done') return null;
  const { vendors } = roster.data;
  return (
    <section className="list" aria-label="Your vendors">
      <h3>
        Your vendors <span className="muted">{vendors.length}</span>
      </h3>
      {vendors.length === 0 ? (
        <p className="muted">No one on your roster yet. Invite someone above.</p>
      ) : (
        <ul>
          {vendors.map((v) => (
            <li key={v.accountId}>
              <span>{v.displayName ?? `Vendor #${v.accountId}`}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
