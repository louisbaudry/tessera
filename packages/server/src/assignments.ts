/**
 * The assignment routes (vendor-spec.md §4, §6 and the #48 implementation
 * note): the owner offers a project to one vendor or posts it to a pool;
 * a vendor claims, accepts or declines. Routes on this server, not a
 * second one (§6): the vendor and the owner share the process, the
 * session and the editor.
 *
 * Each route is a repository call with HTTP around it. The lifecycle's
 * rules are `vendor-core`'s and the move is `db`'s `moveAssignment`;
 * nothing here decides what a transition means.
 *
 * A vendor addresses the owner's roster as a project is addressed
 * (`?owner=<account id>`, backlog #45). A vendor who is not on that roster,
 * or not eligible for that assignment, gets the same 404 as an assignment
 * that does not exist.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { isSlug, type AuditActor } from '@cat-tool/core';
import {
  AssignmentAccessError,
  AssignmentConflictError,
  acceptAssignment,
  analyseTierWords,
  claimAssignment,
  createDirectOffer,
  createVendorFile,
  declineAssignment,
  getAccountById,
  getAssignment,
  getAssignmentAnalysis,
  getVendor,
  getVendorByAccount,
  grantProjectAuthorization,
  listAssignmentEvents,
  listPoolMembers,
  type openPlatformDb,
  openProjectDb,
  openVendorFile,
  postToPool,
  VendorError,
  type Account,
  type Assignment,
} from '@cat-tool/db';
import {
  AssignmentPartyError,
  InvalidAssignmentTransitionError,
} from '@cat-tool/vendor-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { projectPath, vendorsPath } from './storage.js';

type Roster = ReturnType<typeof openVendorFile>;
type Platform = ReturnType<typeof openPlatformDb>;

export interface AssignmentRouteDeps {
  readonly storageRoot: string;
  readonly platform: Platform;
  /** The session's account. */
  readonly owner: (req: FastifyRequest) => Account;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
}

const GENERATOR = 'cat-tool/server';

/** The words of a project by match tier, read once and closed. */
function analyseProject(path: string) {
  const project = openProjectDb(path);
  try {
    return analyseTierWords(project);
  } finally {
    project.close();
  }
}

/** `404 no such assignment`: what a missing assignment, a missing roster and a stranger all get. */
const noSuch = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'no such assignment' });

export function registerAssignmentRoutes(
  app: FastifyInstance,
  deps: AssignmentRouteDeps,
): void {
  const { storageRoot, platform } = deps;

  /** Opens an owner's roster, or null if they have none. */
  function openRoster(ownerAccount: Account): Roster | null {
    const path = vendorsPath(storageRoot, ownerAccount);
    return existsSync(path) ? openVendorFile(path) : null;
  }

  /** Opens the roster, creating the file the first time an owner needs it. */
  function openOrCreateRoster(ownerAccount: Account): Roster {
    const path = vendorsPath(storageRoot, ownerAccount);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      return createVendorFile(path, { generator: GENERATOR });
    }
    return openVendorFile(path);
  }

  /** What the owner sees: the whole assignment, its pool by account id and its history. */
  function ownerView(roster: Roster, a: Assignment) {
    const accountOf = (vendorId: number) =>
      getVendor(roster, vendorId)?.accountId ?? null;
    return {
      ...vendorView(a),
      analysis: getAssignmentAnalysis(roster, a.id),
      vendorAccountId: a.vendorId === null ? null : accountOf(a.vendorId),
      eligible: listPoolMembers(roster, a.id).map(accountOf),
      events: listAssignmentEvents(roster, a.id).map((e) => ({
        from: e.from,
        to: e.to,
        by: e.actorLabel ?? e.actor,
        note: e.note,
        at: e.at,
      })),
    };
  }

  /** What a vendor sees: the job, never another person's address or the history. */
  function vendorView(a: Assignment) {
    return {
      id: a.id,
      project: a.projectName,
      channel: a.channel,
      status: a.status,
      deadline: a.deadline,
      instructions: a.instructions,
      reopenedFrom: a.reopenedFrom,
    };
  }

  /** The owner named by `?owner=`, or null if it is not a valid account. */
  function ownerParam(req: FastifyRequest): Account | null {
    const asked = (req.query as { owner?: unknown } | undefined)?.owner;
    if (typeof asked !== 'string' || !/^[1-9]\d{0,14}$/.test(asked)) return null;
    return getAccountById(platform, Number(asked));
  }

  function mapError(err: unknown, reply: FastifyReply) {
    if (err instanceof AssignmentAccessError) return noSuch(reply);
    if (
      err instanceof InvalidAssignmentTransitionError ||
      err instanceof AssignmentPartyError ||
      err instanceof AssignmentConflictError
    ) {
      return reply.code(409).send({ error: err.message });
    }
    if (err instanceof VendorError) return reply.code(400).send({ error: err.message });
    throw err;
  }

  // The owner offers a project: to one vendor (`channel: "direct"`, one
  // account in `vendors`) or to a pool (`"pool"`, one or more). The
  // vendors are named by account id and must be on the owner's roster.
  app.post<{
    Body: {
      project?: unknown;
      channel?: unknown;
      vendors?: unknown;
      deadline?: unknown;
      instructions?: unknown;
    };
  }>('/api/assignments', async (req, reply) => {
    const me = deps.owner(req);
    const body = req.body ?? {};
    const { project, channel, vendors, deadline, instructions } = body;
    if (typeof project !== 'string' || !isSlug(project)) {
      return reply.code(400).send({ error: 'project must be a project name' });
    }
    if (channel !== 'direct' && channel !== 'pool') {
      return reply.code(400).send({ error: 'channel must be "direct" or "pool"' });
    }
    if (
      !Array.isArray(vendors) ||
      !vendors.every((v) => Number.isSafeInteger(v) && (v as number) > 0)
    ) {
      return reply.code(400).send({ error: 'vendors must be a list of account ids' });
    }
    if (channel === 'direct' && vendors.length !== 1) {
      return reply.code(400).send({ error: 'a direct offer names exactly one vendor' });
    }
    for (const [field, value] of [
      ['deadline', deadline],
      ['instructions', instructions],
    ] as const) {
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return reply.code(400).send({ error: `${field} must be text` });
      }
    }
    if (!existsSync(projectPath(storageRoot, me, project))) {
      return reply.code(404).send({ error: `no project named "${project}"` });
    }

    const roster = openOrCreateRoster(me);
    try {
      const vendorIds: number[] = [];
      for (const accountId of vendors as number[]) {
        const entry = getVendorByAccount(roster, accountId);
        if (!entry) {
          return reply
            .code(400)
            .send({ error: `account #${accountId} is not on your roster` });
        }
        vendorIds.push(entry.id);
      }
      const job = {
        projectName: project,
        deadline: (deadline as string | null | undefined) ?? null,
        instructions: (instructions as string | null | undefined) ?? null,
        // The project's words by tier as they stand now, frozen with the offer
        // (backlog #116): a tier cannot be read from a segment later.
        analysis: analyseProject(projectPath(storageRoot, me, project)),
        actor: deps.sessionActor(req),
      };
      const assignment =
        channel === 'direct'
          ? createDirectOffer(roster, { ...job, vendorId: vendorIds[0]! })
          : postToPool(roster, { ...job, vendorIds });
      return reply.code(201).send({ assignment: ownerView(roster, assignment) });
    } catch (err) {
      return mapError(err, reply);
    } finally {
      roster.close();
    }
  });

  // One assignment. The owner (no `?owner`, or their own id) sees all of
  // it on their roster; a vendor (`?owner=<the owner's id>`) sees the job
  // if it is theirs or they are in its pool.
  app.get<{ Params: { id: string } }>('/api/assignments/:id', async (req, reply) => {
    const me = deps.owner(req);
    const id = /^[1-9]\d{0,14}$/.test(req.params.id) ? Number(req.params.id) : 0;
    const asked = (req.query as { owner?: unknown } | undefined)?.owner;
    const ownerAccount = asked === undefined ? me : ownerParam(req);
    if (!ownerAccount || id === 0) return noSuch(reply);
    const roster = openRoster(ownerAccount);
    if (!roster) return noSuch(reply);
    try {
      const assignment = getAssignment(roster, id);
      if (!assignment) return noSuch(reply);
      if (ownerAccount.id === me.id) {
        return { assignment: ownerView(roster, assignment) };
      }
      const vendor = getVendorByAccount(roster, me.id);
      const mine =
        vendor !== null &&
        (assignment.vendorId === vendor.id ||
          listPoolMembers(roster, assignment.id).includes(vendor.id));
      return mine ? { assignment: vendorView(assignment) } : noSuch(reply);
    } finally {
      roster.close();
    }
  });

  /** A vendor's answer: claim, accept or decline, on the roster `?owner=` names. */
  function vendorMove(
    verb: 'claim' | 'accept' | 'decline',
    move: typeof claimAssignment,
  ): void {
    app.post<{ Params: { id: string }; Body: { note?: unknown } | undefined }>(
      `/api/assignments/:id/${verb}`,
      async (req, reply) => {
        const me = deps.owner(req);
        const ownerAccount = ownerParam(req);
        const id = /^[1-9]\d{0,14}$/.test(req.params.id) ? Number(req.params.id) : 0;
        if (!ownerAccount || id === 0 || ownerAccount.id === me.id) return noSuch(reply);
        const note = req.body?.note;
        if (note !== undefined && note !== null && typeof note !== 'string') {
          return reply.code(400).send({ error: 'note must be text' });
        }
        const roster = openRoster(ownerAccount);
        if (!roster) return noSuch(reply);
        try {
          const vendor = getVendorByAccount(roster, me.id);
          if (!vendor) return noSuch(reply);
          const assignment = move(roster, {
            assignmentId: id,
            vendorId: vendor.id,
            note: (note as string | null | undefined) ?? null,
            actor: deps.sessionActor(req),
          });
          if (verb === 'accept') {
            // Accepting opens the editor: the grant of #45. Two files, so not
            // one transaction: the move is committed, the grant is idempotent
            // and follows (vendor-spec §4, #48 note).
            grantProjectAuthorization(platform, {
              accountId: me.id,
              project: { accountId: ownerAccount.id, name: assignment.projectName },
              scope: 'assigned_translator',
              actor: deps.sessionActor(req),
            });
          }
          return { assignment: vendorView(assignment) };
        } catch (err) {
          return mapError(err, reply);
        } finally {
          roster.close();
        }
      },
    );
  }

  vendorMove('claim', claimAssignment);
  vendorMove('accept', acceptAssignment);
  vendorMove('decline', declineAssignment);
}
