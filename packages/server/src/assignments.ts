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

import { isSlug, plainText, type AuditActor } from '@cat-tool/core';
import {
  AssignmentAccessError,
  AssignmentConflictError,
  acceptAssignment,
  addVendor,
  analyseTierWords,
  claimAssignment,
  createDirectOffer,
  createVendorFile,
  declineAssignment,
  getAccountById,
  getAssignment,
  getAssignmentAnalysis,
  getProfile,
  getVendor,
  getProject,
  getVendorByAccount,
  grantProjectAuthorization,
  listAssignmentEvents,
  listAssignments,
  listPoolMembers,
  listVendors,
  previewSource,
  type openPlatformDb,
  openProjectDb,
  openVendorFile,
  postToPool,
  ReviewBlockedError,
  reviewAssignment,
  revokeProjectAuthorization,
  setVendorRate,
  vendorRateHistory,
  vendorFeed,
  vendorRateCardAt,
  VendorError,
  type Account,
  type Assignment,
} from '@cat-tool/db';
import {
  AssignmentPartyError,
  InvalidAssignmentTransitionError,
  type RateTier,
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

/** What a vendor sees of the source before answering: a few segments, capped (vendor-spec §7, #50). */
const PREVIEW_SEGMENTS = 5;
const PREVIEW_CHARS = 300;

/** The project's pair and a capped source preview, or null if the project is gone. */
function readPreview(path: string) {
  if (!existsSync(path)) return null;
  const project = openProjectDb(path);
  try {
    const meta = getProject(project);
    const { segments, sample } = previewSource(project, PREVIEW_SEGMENTS);
    return {
      pair: meta ? { src: meta.srcLang, tgt: meta.tgtLang } : null,
      segments,
      sample: sample.map((seg) => {
        const text = plainText(seg.sourceTokens);
        return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
      }),
    };
  } finally {
    project.close();
  }
}

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
    if (err instanceof ReviewBlockedError) {
      return reply.code(409).send({ error: err.message, blocking: err.blocking });
    }
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

  // A vendor's job feed, on the roster `?owner=` names. The owner's own id is
  // not a vendor's feed (the owner's list is #51), and a roster the caller is
  // not on is the same 404.
  app.get('/api/assignments', async (req, reply) => {
    const me = deps.owner(req);
    // No `?owner`: the owner's own list (backlog #51), newest first.
    if ((req.query as { owner?: unknown } | undefined)?.owner === undefined) {
      const own = openRoster(me);
      if (!own) return { assignments: [] };
      try {
        return { assignments: listAssignments(own).map((a) => ownerView(own, a)) };
      } finally {
        own.close();
      }
    }
    const ownerAccount = ownerParam(req);
    if (!ownerAccount || ownerAccount.id === me.id) return noSuch(reply);
    const roster = openRoster(ownerAccount);
    if (!roster) return noSuch(reply);
    try {
      const vendor = getVendorByAccount(roster, me.id);
      if (!vendor) return noSuch(reply);
      const feed = vendorFeed(roster, vendor.id);
      return {
        needsResponse: feed.needsResponse.map(vendorView),
        claimable: feed.claimable.map(vendorView),
        active: feed.active.map(vendorView),
        delivered: feed.delivered.map(vendorView),
      };
    } finally {
      roster.close();
    }
  });

  // Opening an offer (vendor-spec §7, #50): what a vendor needs before
  // answering. Deliberately no total (decision 10): the tier words and the
  // vendor's own rate card are both here, and the sum is theirs to read.
  app.get<{ Params: { id: string } }>(
    '/api/assignments/:id/offer',
    async (req, reply) => {
      const me = deps.owner(req);
      const ownerAccount = ownerParam(req);
      const id = /^[1-9]\d{0,14}$/.test(req.params.id) ? Number(req.params.id) : 0;
      if (!ownerAccount || id === 0 || ownerAccount.id === me.id) return noSuch(reply);
      const roster = openRoster(ownerAccount);
      if (!roster) return noSuch(reply);
      try {
        const vendor = getVendorByAccount(roster, me.id);
        const assignment = getAssignment(roster, id);
        const mine =
          vendor !== null &&
          assignment !== null &&
          (assignment.vendorId === vendor.id ||
            listPoolMembers(roster, assignment.id).includes(vendor.id));
        if (!vendor || !assignment || !mine) return noSuch(reply);

        const preview = readPreview(
          projectPath(storageRoot, ownerAccount, assignment.projectName),
        );
        const analysis = getAssignmentAnalysis(roster, assignment.id);
        const card = vendorRateCardAt(roster, vendor.id, assignment.createdAt)
          .filter(
            (r) =>
              !preview?.pair ||
              (r.pair.src === preview.pair.src && r.pair.tgt === preview.pair.tgt),
          )
          .map((r) => ({
            src: r.pair.src,
            tgt: r.pair.tgt,
            tier: r.tier,
            rateMicros: r.rateMicros,
            currency: r.currency,
          }));
        return {
          assignment: vendorView(assignment),
          offer: {
            analysis: analysis
              ? {
                  at: analysis.at,
                  words: analysis.words,
                  totalWords: Object.values(analysis.words).reduce(
                    (n, w) => n + (w ?? 0),
                    0,
                  ),
                }
              : null,
            source: preview
              ? { segments: preview.segments, preview: preview.sample }
              : null,
            rateCard: card,
          },
        };
      } finally {
        roster.close();
      }
    },
  );

  // The owner's sign-off (backlog #51, vendor-spec §4): `delivered → reviewed`,
  // refused while the project has a blocking QA issue, and ending the vendor's
  // access to the project. Owner-only: it opens the caller's own roster, so a
  // vendor reaches nothing here.
  app.post<{ Params: { id: string }; Body: { note?: unknown } | undefined }>(
    '/api/assignments/:id/review',
    async (req, reply) => {
      const me = deps.owner(req);
      const id = /^[1-9]\d{0,14}$/.test(req.params.id) ? Number(req.params.id) : 0;
      if (id === 0) return noSuch(reply);
      const note = req.body?.note;
      if (note !== undefined && note !== null && typeof note !== 'string') {
        return reply.code(400).send({ error: 'note must be text' });
      }
      const roster = openRoster(me);
      if (!roster) return noSuch(reply);
      try {
        const assignment = getAssignment(roster, id);
        if (!assignment) return noSuch(reply);
        const path = projectPath(storageRoot, me, assignment.projectName);
        if (!existsSync(path)) {
          return reply.code(409).send({
            error: `the project "${assignment.projectName}" is gone: there is nothing to review the job against`,
          });
        }
        const project = openProjectDb(path);
        let reviewed: Assignment;
        try {
          reviewed = reviewAssignment(roster, project, {
            assignmentId: id,
            note: (note as string | null | undefined) ?? null,
            actor: deps.sessionActor(req),
          });
        } finally {
          project.close();
        }
        // The job is closed, so the translator's access to the editor ends. Two
        // files, so not one transaction: the move is committed, the revoke is
        // idempotent and follows (vendor-spec §4, #51 note).
        const vendor =
          reviewed.vendorId === null ? null : getVendor(roster, reviewed.vendorId);
        if (vendor) {
          revokeProjectAuthorization(platform, {
            accountId: vendor.accountId,
            project: { accountId: me.id, name: reviewed.projectName },
            actor: deps.sessionActor(req),
          });
        }
        return { assignment: ownerView(roster, reviewed) };
      } catch (err) {
        return mapError(err, reply);
      } finally {
        roster.close();
      }
    },
  );

  // --- the owner's roster (backlog #51): who they engage, and what they pay ---

  const accountParam = (raw: string): number =>
    /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : 0;

  const rateView = (r: ReturnType<typeof vendorRateHistory>[number]) => ({
    src: r.pair.src,
    tgt: r.pair.tgt,
    tier: r.tier,
    rateMicros: r.rateMicros,
    currency: r.currency,
    effectiveFrom: r.effectiveFrom,
  });

  // The roster: account id and display name, languages and specialties. Never an email.
  app.get('/api/vendors', async (req) => {
    const roster = openRoster(deps.owner(req));
    if (!roster) return { vendors: [] };
    try {
      return {
        vendors: listVendors(roster).map((v) => {
          const p = getProfile(roster, v.id)!;
          return {
            accountId: p.accountId,
            displayName: p.displayName,
            languages: p.languages,
            specialties: p.specialties,
          };
        }),
      };
    } finally {
      roster.close();
    }
  });

  app.post<{
    Body: {
      account?: unknown;
      displayName?: unknown;
      languages?: unknown;
      specialties?: unknown;
    };
  }>('/api/vendors', async (req, reply) => {
    const me = deps.owner(req);
    const { account, displayName, languages, specialties } = req.body ?? {};
    if (!Number.isSafeInteger(account) || (account as number) < 1) {
      return reply.code(400).send({ error: 'account must be an account id' });
    }
    if (
      displayName !== undefined &&
      displayName !== null &&
      typeof displayName !== 'string'
    ) {
      return reply.code(400).send({ error: 'displayName must be text' });
    }
    const pairs = languages === undefined ? [] : languages;
    if (
      !Array.isArray(pairs) ||
      !pairs.every(
        (p) =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as { src?: unknown }).src === 'string' &&
          typeof (p as { tgt?: unknown }).tgt === 'string',
      )
    ) {
      return reply.code(400).send({ error: 'languages must be a list of { src, tgt }' });
    }
    const tags = specialties === undefined ? [] : specialties;
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
      return reply.code(400).send({ error: 'specialties must be a list of text' });
    }
    // One answer for an account that does not exist and one that is not a vendor's:
    // an owner learns nothing about which ids are taken.
    const target = getAccountById(platform, account as number);
    if (!target || target.role !== 'vendor') {
      return reply
        .code(400)
        .send({ error: `account #${account} is not a vendor account` });
    }
    const roster = openOrCreateRoster(me);
    try {
      const vendor = addVendor(roster, {
        accountId: target.id,
        displayName: (displayName as string | null | undefined) ?? null,
        languages: pairs as Array<{ src: string; tgt: string }>,
        specialties: tags as string[],
        actor: deps.sessionActor(req),
      });
      const profile = getProfile(roster, vendor.id)!;
      return reply.code(201).send({
        vendor: {
          accountId: profile.accountId,
          displayName: profile.displayName,
          languages: profile.languages,
          specialties: profile.specialties,
        },
      });
    } catch (err) {
      return mapError(err, reply);
    } finally {
      roster.close();
    }
  });

  // A vendor's whole rate history, oldest first: a rate is a row, never an edit.
  app.get<{ Params: { accountId: string } }>(
    '/api/vendors/:accountId/rates',
    async (req, reply) => {
      const roster = openRoster(deps.owner(req));
      const accountId = accountParam(req.params.accountId);
      if (!roster || accountId === 0)
        return reply.code(404).send({ error: 'no such vendor' });
      try {
        const vendor = getVendorByAccount(roster, accountId);
        if (!vendor) return reply.code(404).send({ error: 'no such vendor' });
        return { rates: vendorRateHistory(roster, vendor.id).map(rateView) };
      } finally {
        roster.close();
      }
    },
  );

  // Adds a rate (`#46`'s rules: not before today, not before the newest for the same
  // pair and tier). A refusal is a 400 saying why.
  app.put<{
    Params: { accountId: string };
    Body: {
      src?: unknown;
      tgt?: unknown;
      tier?: unknown;
      rateMicros?: unknown;
      currency?: unknown;
      effectiveFrom?: unknown;
    };
  }>('/api/vendors/:accountId/rates', async (req, reply) => {
    const roster = openRoster(deps.owner(req));
    const accountId = accountParam(req.params.accountId);
    if (!roster || accountId === 0)
      return reply.code(404).send({ error: 'no such vendor' });
    try {
      const vendor = getVendorByAccount(roster, accountId);
      if (!vendor) return reply.code(404).send({ error: 'no such vendor' });
      const { src, tgt, tier, rateMicros, currency, effectiveFrom } = req.body ?? {};
      if (
        typeof src !== 'string' ||
        typeof tgt !== 'string' ||
        typeof tier !== 'string' ||
        typeof rateMicros !== 'number' ||
        typeof currency !== 'string' ||
        typeof effectiveFrom !== 'string'
      ) {
        return reply.code(400).send({
          error:
            'a rate needs src, tgt, tier, rateMicros (a number), currency and effectiveFrom (text)',
        });
      }
      const entry = setVendorRate(roster, {
        vendorId: vendor.id,
        pair: { src, tgt },
        tier: tier as RateTier,
        rateMicros,
        currency,
        effectiveFrom,
        actor: deps.sessionActor(req),
      });
      return reply.code(201).send({ rate: rateView(entry) });
    } catch (err) {
      return mapError(err, reply);
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
