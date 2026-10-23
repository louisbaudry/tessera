/**
 * A tenant invites a vendor (backlog #111, #205; `vendor-spec.md` §3, the #111 note).
 * Its staff list, create and withdraw invitations behind the login gate, and the
 * invitee opens and accepts a link **without a session**, which is why those two are
 * the only public paths besides login (`PUBLIC_PATHS`, app.ts). A vendor who already
 * has an account joins by signing in and posting the link to `/api/invitations/join`
 * (backlog #187), behind the gate: the session is what proves who is joining.
 *
 * The link is shown to the inviting staff member to pass on, not mailed: this server has no mail
 * sender (the SMTP service is `portal-server`'s), and sending would be a new outbound
 * data flow. The token travels in a request body and in the link's `#` fragment,
 * never in a path or query, so no access log or `Referer` header carries it.
 *
 * The invitee's account and roster-index row are one platform transaction
 * (`acceptInvitation`); the roster file's own entry is a second file no transaction
 * covers, so it is written after and mended against the invitations, never by
 * repeating a step: `bringRosterLevel` adds any accepted invitation's vendor the
 * roster lacks, after an accept and whenever the tenant lists its invitations.
 */

import {
  generateSessionToken,
  hashPassword,
  verifyPassword,
  type AuditActor,
} from '@cat-tool/core';
import {
  acceptInvitation,
  addVendor,
  createAccountSession,
  createInvitation,
  EmailTakenError,
  getAccountByEmail,
  getTenantById,
  getVendorByAccount,
  peekInvitationTenant,
  recordFailedLogin,
  joinInvitation,
  InvalidInvitationError,
  InvitationNotPendingError,
  InvitationRoleError,
  InvitationUnusableError,
  listAcceptedInvitations,
  listInvitations,
  NoSuchInvitationError,
  openInvitation,
  revokeInvitation,
  type Account,
  type Invitation,
  type openPlatformDb,
  type Tenant,
} from '@cat-tool/db';
import { passwordProblem } from '@cat-tool/vendor-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { openOrCreateRoster } from './roster.js';

type Platform = ReturnType<typeof openPlatformDb>;

/** The two routes an invitee uses before they have a session. */
export const OPEN_INVITATION_PATH = '/api/invitations/open';
export const ACCEPT_INVITATION_PATH = '/api/invitations/accept';
/** A vendor who already has an account joins a second tenant from that tenant's own host (D14). */
export const JOIN_SIGNIN_PATH = '/api/invitations/join-signin';

export interface InvitationRouteDeps {
  readonly storageRoot: string;
  readonly platform: Platform;
  /** The session's account: the person who invites, and who is the actor. */
  readonly account: (req: FastifyRequest) => Account;
  /** The session's tenant, or null for an account with none (a vendor). */
  readonly tenant: (req: FastifyRequest) => Tenant | null;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
  /** The actor a refused sign-in is logged under (the login route's own). */
  readonly loginGate: AuditActor;
}

/** What the tenant's staff see of an invitation: never the token, which only the creating response carries. */
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

  /** Puts every vendor a tenant's accepted invitations made onto its roster file, once each. */
  function bringRosterLevel(tenant: Tenant): void {
    const accepted = listAcceptedInvitations(platform, tenant.id);
    if (accepted.length === 0) return;
    const roster = openOrCreateRoster(storageRoot, tenant);
    try {
      for (const { accountId, displayName, invitedBy } of accepted) {
        if (!getVendorByAccount(roster, accountId)) {
          // The staff member who sent the invitation vouched for the account, so they
          // are who added it: the tenant is not a person and cannot be an actor.
          const actor: AuditActor = {
            actor: { kind: 'account', id: invitedBy },
            label: null,
          };
          addVendor(roster, { accountId, displayName, actor });
        }
      }
    } finally {
      roster.close();
    }
  }

  app.get('/api/invitations', async (req) => {
    // No tenant (a vendor) has no invitations: an empty list, as an empty owner list was.
    const tenant = deps.tenant(req);
    if (!tenant) return { invitations: [] };
    bringRosterLevel(tenant);
    return { invitations: listInvitations(platform, tenant.id).map(invitationView) };
  });

  // Creates the link. Its token is in this response and nowhere else, ever again.
  app.post<{ Body: { email?: unknown; displayName?: unknown } | undefined }>(
    '/api/invitations',
    async (req, reply) => {
      const tenant = deps.tenant(req);
      // The refusal a vendor inviter always got, from the same rule (`InvalidInvitationError`).
      if (!tenant)
        return reply.code(400).send({ error: 'only an owner can invite a vendor' });
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
          tenantId: tenant.id,
          invitedBy: deps.account(req).id,
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
      const tenant = deps.tenant(req);
      if (!tenant) return reply.code(404).send({ error: 'no such invitation' });
      const id = /^[1-9]\d{0,14}$/.test(req.params.id) ? Number(req.params.id) : 0;
      try {
        const done = revokeInvitation(platform, {
          tenantId: tenant.id,
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
  /**
   * On a tenant's host (D14) a link made for another tenant is the same 404 as one that
   * does not exist: the page cannot be used to learn which tenant an unknown link belongs to.
   */
  const wrongHost = (req: FastifyRequest, token: string): boolean =>
    req.hostTenant !== null &&
    peekInvitationTenant(platform, token) !== req.hostTenant.id;

  // The address the link was made for, so the invitee knows which account they are
  // making. Any link that cannot be used, for any reason, is the same 404.
  app.post(OPEN_INVITATION_PATH, async (req, reply) => {
    const token = tokenOf(req.body);
    const opened =
      token === null || wrongHost(req, token) ? null : openInvitation(platform, token);
    return opened ?? reply.code(404).send(NOT_VALID);
  });

  // A vendor who already has an account joins the roster of the tenant that invited
  // them (backlog #187). Behind the login gate on purpose: the session is the proof
  // of who is joining, so a link alone never attaches anyone to an account. The
  // session's account must be the one whose address the owner invited, and a vendor's.
  app.post<{ Body: { token?: unknown } | undefined }>(
    '/api/invitations/join',
    async (req, reply) => {
      const token = tokenOf(req.body);
      if (token === null || wrongHost(req, token)) return reply.code(404).send(NOT_VALID);
      const me = deps.account(req);
      try {
        const { invitation } = joinInvitation(platform, { token, accountId: me.id });
        const tenant = getTenantById(platform, invitation.tenantId);
        if (tenant) bringRosterLevel(tenant);
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

  // A vendor who already has an account cannot hold a session on this tenant's host before
  // they are on its roster (D14), so the join cannot sit behind the gate there. The account's
  // own password, checked here exactly as login checks it, is the proof of who is joining, and
  // a failure is the login's own 401 and log line: the link alone still never attaches anyone.
  app.post<{
    Body: { token?: unknown; email?: unknown; password?: unknown } | undefined;
  }>(JOIN_SIGNIN_PATH, async (req, reply) => {
    const token = tokenOf(req.body);
    if (token === null || wrongHost(req, token)) return reply.code(404).send(NOT_VALID);
    const { email, password } = req.body ?? {};
    const account =
      typeof email === 'string' && email ? getAccountByEmail(platform, email) : null;
    const passwordOk =
      account !== null &&
      typeof password === 'string' &&
      password !== '' &&
      verifyPassword(password, account.passwordHash);
    if (!account || !passwordOk) {
      recordFailedLogin(platform, {
        actor: deps.loginGate,
        accountId: account?.id ?? null,
        reason: !account ? 'unknown_email' : 'wrong_password',
        ...(req.hostTenant ? { tenantId: req.hostTenant.id } : {}),
      });
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    try {
      const { invitation } = joinInvitation(platform, { token, accountId: account.id });
      const tenant = getTenantById(platform, invitation.tenantId);
      if (tenant) bringRosterLevel(tenant);
      const session = generateSessionToken();
      const { expiresAt } = createAccountSession(platform, account.id, session, {
        actor: { actor: { kind: 'account', id: account.id }, label: account.email },
        tenantId: invitation.tenantId,
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
      if (err instanceof InvitationRoleError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  // Sets the password once. On success the invitee is signed in: they land on the
  // vendor feed with the owner's roster entry already in place.
  app.post(ACCEPT_INVITATION_PATH, async (req, reply) => {
    const token = tokenOf(req.body);
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (token === null || wrongHost(req, token)) return reply.code(404).send(NOT_VALID);
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
      const tenant = getTenantById(platform, invitation.tenantId);
      if (tenant) bringRosterLevel(tenant);
      const session = generateSessionToken();
      const { expiresAt } = createAccountSession(platform, account.id, session, {
        actor: { actor: { kind: 'account', id: account.id }, label: account.email },
        tenantId: invitation.tenantId,
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
