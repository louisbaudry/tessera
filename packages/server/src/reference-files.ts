/**
 * Reference files of a project (`v1-spec.md` §7.9; issue #203): a list, a
 * download, an upload and a removal.
 *
 * The owner attaches (`manage`); anyone with a grant opens (`read`). What each
 * is told differs on purpose: the owner sees a file's name, someone working on
 * the project sees only the label the owner chose for them, or none, because a
 * name may carry a client's and the client is not the translator's to know (the
 * reason memories are shown by position, backlog #124). The name is never sent
 * to a grantee, rather than hidden by the page.
 *
 * Nothing here takes a path: a file is a row in the project's own database, and
 * its id means nothing in any other project. The bytes are served with the type
 * `core` read from their signature, never one the upload claimed.
 */

import {
  attachmentDisposition,
  REFERENCE_MAX_BYTES,
  type AuditActor,
  type ProjectAction,
} from '@cat-tool/core';
import {
  addReferenceFile,
  getReferenceFile,
  listReferenceFiles,
  ReferenceFileError,
  removeReferenceFile,
  type Tenant,
  type openProjectDb,
  type ReferenceFile,
} from '@cat-tool/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ReferenceFileRouteDeps {
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
  /** The session's own account id: the owner is who the project belongs to. */
  /** The session's tenant, or null for an account with none (a vendor). */
  readonly tenantId: (req: FastifyRequest) => number | null;
  readonly openProject: (
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
    action: ProjectAction,
  ) => { db: ReturnType<typeof openProjectDb>; path: string; tenant: Tenant } | null;
}

/** What the owner is told of a file. */
const ownerView = (f: ReferenceFile) => ({
  id: f.id,
  name: f.name,
  label: f.label,
  mediaType: f.mediaType,
  size: f.size,
  addedAt: f.addedAt,
});

/** What someone working on the project is told: no name, no date. */
const workerView = (f: ReferenceFile) => ({
  id: f.id,
  label: f.label,
  mediaType: f.mediaType,
  size: f.size,
});

const STATUS: Record<ReferenceFileError['reason'], number> = {
  empty: 400,
  label: 400,
  type: 415,
  too_big: 413,
  too_many: 409,
};

export function registerReferenceFileRoutes(
  app: FastifyInstance,
  deps: ReferenceFileRouteDeps,
): void {
  app.get<{ Params: { name: string } }>(
    '/api/projects/:name/reference-files',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'read');
      if (!opened) return reply;
      try {
        const isOwner = opened.tenant.id === deps.tenantId(req);
        const files = listReferenceFiles(opened.db);
        return { files: files.map(isOwner ? ownerView : workerView) };
      } finally {
        opened.db.close();
      }
    },
  );

  // The bytes. `nosniff` and a fixed type from the five `core` accepts, so the
  // browser never decides what a file is; `no-store` because it may be a client's.
  app.get<{ Params: { name: string; id: string } }>(
    '/api/projects/:name/reference-files/:id/content',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'read');
      if (!opened) return reply;
      try {
        const id = Number(req.params.id);
        const found = Number.isInteger(id) ? getReferenceFile(opened.db, id) : null;
        if (!found) return reply.code(404).send({ error: 'no such reference file' });
        // A grantee's download must not carry the owner's file name either.
        const isOwner = opened.tenant.id === deps.tenantId(req);
        const extension =
          found.file.mediaType === 'application/pdf'
            ? 'pdf'
            : found.file.mediaType.slice(6);
        return reply
          .header('content-type', found.file.mediaType)
          .header(
            'content-disposition',
            attachmentDisposition(
              isOwner ? found.file.name : `reference-${found.file.id}.${extension}`,
            ).replace(/^attachment/, 'inline'),
          )
          .header('x-content-type-options', 'nosniff')
          .header('cache-control', 'private, no-store')
          .send(Buffer.from(found.data));
      } finally {
        opened.db.close();
      }
    },
  );

  // One file per request, multipart: an optional `label` field first, then the
  // file. The size limit is the stream's, so an oversize body is cut off as it
  // arrives, not read whole and then refused.
  app.post<{ Params: { name: string } }>(
    '/api/projects/:name/reference-files',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      try {
        const part = await req.file({ limits: { fileSize: REFERENCE_MAX_BYTES + 1 } });
        if (!part) return reply.code(400).send({ error: 'a file part is required' });
        let bytes: Buffer;
        try {
          bytes = await part.toBuffer();
        } catch {
          return reply.code(413).send({
            error: `a reference file is at most ${REFERENCE_MAX_BYTES / (1024 * 1024)} MB`,
          });
        }
        const labelField = part.fields['label'];
        const label =
          labelField && !Array.isArray(labelField) && labelField.type === 'field'
            ? String(labelField.value)
            : null;
        try {
          const added = addReferenceFile(opened.db, {
            name: part.filename,
            label,
            bytes,
            actor: deps.sessionActor(req),
          });
          return reply.code(201).send({ file: ownerView(added) });
        } catch (err) {
          if (err instanceof ReferenceFileError) {
            return reply.code(STATUS[err.reason]).send({ error: err.message });
          }
          throw err;
        }
      } finally {
        opened.db.close();
      }
    },
  );

  app.delete<{ Params: { name: string; id: string } }>(
    '/api/projects/:name/reference-files/:id',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      try {
        const id = Number(req.params.id);
        const removed =
          Number.isInteger(id) &&
          removeReferenceFile(opened.db, id, { actor: deps.sessionActor(req) });
        if (!removed) return reply.code(404).send({ error: 'no such reference file' });
        return { files: listReferenceFiles(opened.db).map(ownerView) };
      } finally {
        opened.db.close();
      }
    },
  );
}
