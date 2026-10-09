/**
 * An owner invites a vendor (backlog #111; `vendor-spec.md` §3, the #111 note).
 * The owner lists, creates and withdraws invitations behind the login gate, and the
 * invitee opens and accepts a link **without a session**, which is why those two are
 * the only public paths besides login (`PUBLIC_PATHS`, app.ts). A vendor who already
 * has an account joins by signing in and posting the link to `/api/invitations/join`
 * (backlog #187), behind the gate: the session is what proves who is joining.
 *
 * The link is shown to the owner to pass on, not mailed: this server has no mail
 * sender (the SMTP service is `portal-server`'s), and sending would be a new outbound
 * data flow. The token travels in a request body and in the link's `#` fragment,
 * never in a path or query, so no access log or `Referer` header carries it.
 *
 * The invitee's account and roster-index row are one platform transaction
 * (`acceptInvitation`); the roster file's own entry is a second file no transaction
 * covers, so it is written after and mended against the invitations, never by
 * repeating a step: `bringRosterLevel` adds any accepted invitation's vendor the
 * roster lacks, after an accept and whenever the owner lists their invitations.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { generateSessionToken, hashPassword, type AuditActor } from '@cat-tool/core';
import {
  acceptInvitation,
  addVendor,
  createAccountSession,
  createInvitation,
  createVendorFile,
  EmailTakenError,
  getAccountById,
  getVendorByAccount,
  joinInvitation,
  InvalidInvitationError,
  InvitationNotPendingError,
  InvitationRoleError,
  InvitationUnusableError,
  listAcceptedInvitations,
  listInvitations,
  NoSuchInvitationError,
  openInvitation,
  openVendorFile,
  revokeInvitation,
  type Account,
  type Invitation,
  type openPlatformDb,
} from '@cat-tool/db';
import { passwordProblem } from '@cat-tool/vendor-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { vendorsPath } from './storage.js';

type Platform = ReturnType<typeof openPlatformDb>;

/** The two routes an invitee uses before they have a session. */
export const OPEN_INVITATION_PATH = '/api/invitations/open';
export const ACCEPT_INVITATION_PATH = '/api/invitations/accept';

export interface InvitationRouteDeps {
  readonly storageRoot: string;
  readonly platform: Platform;
  /** The session's account. */
  readonly owner: (req: FastifyRequest) => Account;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
}

const GENERATOR = 'cat-tool/server';

/** What the owner sees of an invitation: never the token, which only the creating response carries. */
const invitationView = (i: Invitation) => ({
  id: i.id,
  email: i.email,
  displayName: i.displayName,
  status: i.status,
  createdAt: i.createdAt,
  expiresAt: i.expiresAt,
  acceptedAt: i.acceptedAt,
  revokedAt: i.revokedAt,
});

export function registerInvitationRoutes(
  app: FastifyInstance,
  deps: InvitationRouteDeps,
): void {
  const { storageRoot, platform } = deps;

  /** Puts every vendor an owner's accepted invitations made onto the roster file, once each. */
  function bringRosterLevel(ownerAccount: Account): void {
    const accepted = listAcceptedInvitations(platform, ownerAccount.id);
    if (accepted.length === 0) return;
    const path = vendorsPath(storageRoot, ownerAccount);
    if (!existsSync(path)) mkdirSync(dirname(path), { recursive: true });
    const roster = existsSync(path)
      ? openVendorFile(path)
      : createVendorFile(path, { generator: GENERATOR });
    try {
      // The owner vouched for these accounts, so the owner is who added them.
      const actor: AuditActor = {
        actor: { kind: 'account', id: ownerAccount.id },
        label: null,
      };
      for (const { accountId, displayName } of accepted) {
        if (!getVendorByAccount(roster, accountId)) {
          addVendor(roster, { accountId, displayName, actor });
        }
      }
    } finally {
      roster.close();
    }
  }

  app.get('/api/invitations', async (req) => {
    const me = deps.owner(req);
    bringRosterLevel(me);
    return { invitations: listInvitations(platform, me.id).map(invitationView) };
  });

  // Creates the link. Its token is in this response and nowhere else, ever again.
  app.post<{ Body: { email?: unknown; displayName?: unknown } | undefined }>(
    '/api/invitations',
    async (req, reply) => {
      const { email, displayName } = req.body ?? {};
      if (typeof email !== 'string') {
        return reply.code(400).send({ error: 'email must be text' });
      }
      if (
        displayName !== undefined &&
        displayName !== null &&
        typeof displayName !== 'string'
      ) {
        return reply.code(400).send({ error: 'displayName must be text' });
      }
      try {
        const { invitation, token } = createInvitation(platform, {
          ownerId: deps.owner(req).id,
          email,
          displayName: (displayName as string | null | undefined) ?? null,
          actor: deps.sessionActor(req),
        });
        return reply.code(201).send({ invitation: invitationView(invitation), token });
      } catch (err) {
        if (err instanceof InvalidInvitationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/invitations/:id/revoke',
    async (req, reply) => {
      const id = /^[1-9]\d{0,14}$/.test(req.params.id) ? Number(req.params.id) : 0;
      try {
        const done = revokeInvitation(platform, {
          ownerId: deps.owner(req).id,
          id,
          actor: deps.sessionActor(req),
        });
        return { invitation: invitationView(done) };
      } catch (err) {
        if (err instanceof NoSuchInvitationError) {
          return reply.code(404).send({ error: 'no such invitation' });
        }
        if (err instanceof InvitationNotPendingError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // --- the invitee, without a session ---------------------------------

  const tokenOf = (body: unknown): string | null => {
    const token = (body as { token?: unknown } | undefined)?.token;
    return typeof token === 'string' && token.length > 0 && token.length <= 200
      ? token
      : null;
  };
  const NOT_VALID = { error: 'this invitation link is not valid' };

  // The address the link was made for, so the invitee knows which account they are
  // making. Any link that cannot be used, for any reason, is the same 404.
  app.post(OPEN_INVITATION_PATH, async (req, reply) => {
    const token = tokenOf(req.body);
    const opened = token === null ? null : openInvitation(platform, token);
    return opened ?? reply.code(404).send(NOT_VALID);
  });

  // A vendor who already has an account joins the roster of the owner who invited
  // them (backlog #187). Behind the login gate on purpose: the session is the proof
  // of who is joining, so a link alone never attaches anyone to an account. The
  // session's account must be the one whose address the owner invited, and a vendor's.
  app.post<{ Body: { token?: unknown } | undefined }>(
    '/api/invitations/join',
    async (req, reply) => {
      const token = tokenOf(req.body);
      if (token === null) return reply.code(404).send(NOT_VALID);
      const me = deps.owner(req);
      try {
        const { invitation } = joinInvitation(platform, { token, accountId: me.id });
        const owner = getAccountById(platform, invitation.ownerId);
        if (owner) bringRosterLevel(owner);
        return reply.code(201).send({ ok: true });
      } catch (err) {
        if (err instanceof InvitationUnusableError)
          return reply.code(404).send(NOT_VALID);
        if (err instanceof InvitationRoleError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // Sets the password once. On success the invitee is signed in: they land on the
  // vendor feed with the owner's roster entry already in place.
  app.post(ACCEPT_INVITATION_PATH, async (req, reply) => {
    const token = tokenOf(req.body);
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (token === null) return reply.code(404).send(NOT_VALID);
    if (typeof password !== 'string') {
      return reply.code(400).send({ error: 'password must be text' });
    }
    const problem = passwordProblem(password);
    if (problem !== null) return reply.code(400).send({ error: problem });
    try {
      const { account, invitation } = acceptInvitation(platform, {
        token,
        passwordHash: hashPassword(password),
      });
      const owner = getAccountById(platform, invitation.ownerId);
      if (owner) bringRosterLevel(owner);
      const session = generateSessionToken();
      const { expiresAt } = createAccountSession(platform, account.id, session, {
        actor: { actor: { kind: 'account', id: account.id }, label: account.email },
      });
      return reply.code(201).send({
        token: session,
        expiresAt,
        account: {
          id: account.id,
          email: account.email,
          role: account.role,
          createdAt: account.createdAt,
        },
      });
    } catch (err) {
      if (err instanceof InvitationUnusableError) return reply.code(404).send(NOT_VALID);
      if (err instanceof EmailTakenError) {
        return reply.code(409).send({
          error: 'an account with this address already exists: sign in instead',
        });
      }
      throw err;
    }
  });
}
