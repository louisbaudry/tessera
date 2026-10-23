/**
 * A tenant's staff and how people join them (backlog #206, `planning/tenant-spec.md` D5,
 * §6). An admin lists the staff, invites by a one-time link, withdraws a link, changes a
 * role and removes someone; every one of these is `staff` in `tenantRoleAllows`, so a pm
 * is refused (403) and a vendor, who has no tenant, is refused too.
 *
 * The invitee opens and accepts a staff link **without a session**, on paths of their own
 * (`OPEN_STAFF_INVITATION_PATH`, `ACCEPT_STAFF_INVITATION_PATH`) beside the vendor ones,
 * because the two links make different accounts and must not share a route that decides
 * between them. As with a vendor's, the link is shown to the admin to pass on and never
 * mailed (no new outbound flow), and its token travels in a body and a `#` fragment.
 * What the link attaches to is the tenant and role in its row: the request names neither.
 *
 * Which tenant a request acts on is the session's, never the request's (D6): `tenant`
 * is `tenantFor(req, 'staff')`, so the role check and the tenant lookup are one call.
 */

import {
  generateSessionToken,
  hashPassword,
  isTenantRole,
  type AuditActor,
} from '@cat-tool/core';
import {
  acceptStaffInvitation,
  changeTenantRole,
  createAccountSession,
  createStaffInvitation,
  EmailTakenError,
  InvitationUnusableError,
  LastAdminError,
  listStaffInvitations,
  listTenantStaff,
  NoSuchMemberError,
  openStaffInvitation,
  peekStaffInvitationTenant,
  removeTenantStaff,
  revokeStaffInvitation,
  StaffInvitationError,
  type Account,
  type openPlatformDb,
  type StaffInvitation,
  type Tenant,
} from '@cat-tool/db';
import { passwordProblem } from '@cat-tool/vendor-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

type Platform = ReturnType<typeof openPlatformDb>;

/** The two routes a staff invitee uses before they have a session. */
export const OPEN_STAFF_INVITATION_PATH = '/api/staff-invitations/open';
export const ACCEPT_STAFF_INVITATION_PATH = '/api/staff-invitations/accept';

export interface StaffRouteDeps {
  readonly platform: Platform;
  readonly account: (req: FastifyRequest) => Account;
  /** The session's tenant if its role may manage staff; null for a vendor; throws for a pm. */
  readonly tenant: (req: FastifyRequest) => Tenant | null;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
}

/** What an admin sees of a staff invitation: never the token, which only the creating response carries. */
const invitationView = (i: StaffInvitation) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  status: i.status,
  createdAt: i.createdAt,
  expiresAt: i.expiresAt,
  acceptedAt: i.acceptedAt,
  revokedAt: i.revokedAt,
});

const NOT_VALID = { error: 'this invitation link is not valid' };

/** A whole-number path parameter, or 0 (which names nothing). */
const idOf = (raw: string): number => (/^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : 0);

export function registerStaffRoutes(app: FastifyInstance, deps: StaffRouteDeps): void {
  const { platform } = deps;

  app.get('/api/staff', async (req) => {
    // A vendor has no tenant and so no staff to list: empty, as every owner-only list is.
    const tenant = deps.tenant(req);
    if (!tenant) return { staff: [], invitations: [] };
    const me = deps.account(req).id;
    return {
      staff: listTenantStaff(platform, tenant.id).map((s) => ({
        ...s,
        you: s.accountId === me,
      })),
      invitations: listStaffInvitations(platform, tenant.id).map(invitationView),
    };
  });

  // Creates the link. Its token is in this response and nowhere else, ever again.
  app.post<{ Body: { email?: unknown; role?: unknown } | undefined }>(
    '/api/staff/invitations',
    async (req, reply) => {
      const tenant = deps.tenant(req);
      if (!tenant) return reply.code(403).send({ error: 'only an admin can do that' });
      const { email, role } = req.body ?? {};
      if (typeof email !== 'string')
        return reply.code(400).send({ error: 'email must be text' });
      if (typeof role !== 'string' || !isTenantRole(role)) {
        return reply.code(400).send({ error: 'role must be admin or pm' });
      }
      try {
        const { invitation, token } = createStaffInvitation(platform, {
          tenantId: tenant.id,
          invitedBy: deps.account(req).id,
          email,
          role,
          actor: deps.sessionActor(req),
        });
        return reply.code(201).send({ invitation: invitationView(invitation), token });
      } catch (err) {
        if (err instanceof StaffInvitationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/staff/invitations/:id/revoke',
    async (req, reply) => {
      const tenant = deps.tenant(req);
      if (!tenant) return reply.code(404).send({ error: 'no such invitation' });
      try {
        const done = revokeStaffInvitation(platform, {
          tenantId: tenant.id,
          id: idOf(req.params.id),
          actor: deps.sessionActor(req),
        });
        return { invitation: invitationView(done) };
      } catch (err) {
        // Another tenant's, a missing one and one already used are one answer.
        if (err instanceof StaffInvitationError) {
          return reply.code(404).send({ error: 'no such invitation' });
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { accountId: string }; Body: { role?: unknown } | undefined }>(
    '/api/staff/:accountId',
    async (req, reply) => {
      const tenant = deps.tenant(req);
      if (!tenant) return reply.code(404).send({ error: 'no such member' });
      const role = req.body?.role;
      if (typeof role !== 'string' || !isTenantRole(role)) {
        return reply.code(400).send({ error: 'role must be admin or pm' });
      }
      try {
        changeTenantRole(platform, {
          tenantId: tenant.id,
          accountId: idOf(req.params.accountId),
          role,
          actor: deps.sessionActor(req),
        });
        return { ok: true };
      } catch (err) {
        if (err instanceof NoSuchMemberError)
          return reply.code(404).send({ error: 'no such member' });
        if (err instanceof LastAdminError)
          return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );

  app.delete<{ Params: { accountId: string } }>(
    '/api/staff/:accountId',
    async (req, reply) => {
      const tenant = deps.tenant(req);
      if (!tenant) return reply.code(404).send({ error: 'no such member' });
      try {
        removeTenantStaff(platform, {
          tenantId: tenant.id,
          accountId: idOf(req.params.accountId),
          actor: deps.sessionActor(req),
        });
        return { ok: true };
      } catch (err) {
        if (err instanceof NoSuchMemberError)
          return reply.code(404).send({ error: 'no such member' });
        if (err instanceof LastAdminError)
          return reply.code(409).send({ error: err.message });
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

  // On a tenant's host (D14) a link made for another tenant is the same 404 as an unknown one.
  const wrongHost = (req: FastifyRequest, token: string): boolean =>
    req.hostTenant !== null &&
    peekStaffInvitationTenant(platform, token) !== req.hostTenant.id;

  // The address the link was made for. Any link that cannot be used is the same 404.
  app.post(OPEN_STAFF_INVITATION_PATH, async (req, reply) => {
    const token = tokenOf(req.body);
    const opened =
      token === null || wrongHost(req, token)
        ? null
        : openStaffInvitation(platform, token);
    return opened ?? reply.code(404).send(NOT_VALID);
  });

  // Sets the password once and signs the new staff member in.
  app.post(ACCEPT_STAFF_INVITATION_PATH, async (req, reply) => {
    const token = tokenOf(req.body);
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (token === null || wrongHost(req, token)) return reply.code(404).send(NOT_VALID);
    if (typeof password !== 'string')
      return reply.code(400).send({ error: 'password must be text' });
    const problem = passwordProblem(password);
    if (problem !== null) return reply.code(400).send({ error: problem });
    try {
      const { account } = acceptStaffInvitation(platform, {
        token,
        passwordHash: hashPassword(password),
      });
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
