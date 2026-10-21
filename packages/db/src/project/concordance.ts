/**
 * Concordance across a project's memories (`v1-spec.md` §6.1b; issue #170).
 *
 * `retrieveConcordance` answers for one `.ctm`; this reads every enabled
 * memory the project has attached, in `tm_ref` priority order, and stops at
 * the limit. A hit names its memory by position in that order, never by slug,
 * id or path: the owner's names often carry a client's (`GET
 * /api/projects/:name/resources` hides them for the same reason).
 *
 * Read-only: it writes no row and no audit event.
 */

import { CONCORDANCE_LIMIT, type ConcordanceSide } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { retrieveConcordance, type ConcordanceHit } from '../tm/concordance.js';
import { getProject, ProjectError } from './project.js';
import { attachTms, detachTms, listTmRefs, tmAlias } from './tm-refs.js';

export interface ProjectConcordanceParams {
  readonly text: string;
  readonly side: ConcordanceSide;
  /** Hits returned across all memories, at most. Defaults to {@link CONCORDANCE_LIMIT}. */
  readonly limit?: number;
}

export interface ProjectConcordanceHit extends ConcordanceHit {
  /** Position of the memory in the project's priority order, from 1. */
  readonly memory: number;
}

export interface ProjectConcordance {
  readonly hits: ProjectConcordanceHit[];
  /** True when more units hold the phrase than `limit` shows. */
  readonly more: boolean;
  /** How many enabled memories were searched; 0 means none are attached. */
  readonly searched: number;
}

/**
 * The units of the project's attached memories that hold the phrase on the
 * chosen side of the project's language pair. Memories are searched in
 * priority order and the first ones fill the limit, so a base memory ranked
 * below a client's never crowds it out.
 *
 * Attaches and detaches the memories itself (idempotent), so the project
 * connection ends as it began.
 */
export function searchConcordance(
  db: Database.Database,
  params: ProjectConcordanceParams,
): ProjectConcordance {
  const project = getProject(db);
  if (!project) throw new ProjectError('not a project database');
  const limit = params.limit ?? CONCORDANCE_LIMIT;
  const refs = listTmRefs(db);
  const attached = attachTms(db, refs);
  try {
    const hits: ProjectConcordanceHit[] = [];
    let more = false;
    for (const [i, ref] of attached.entries()) {
      // Once the limit is spent a memory is asked for one hit, only to learn
      // whether there are more than are shown.
      const room = Math.max(limit - hits.length, 1);
      const found = retrieveConcordance(
        db,
        {
          srcLang: project.srcLang,
          tgtLang: project.tgtLang,
          text: params.text,
          side: params.side,
          limit: room,
        },
        { schema: tmAlias(ref.id) },
      );
      if (hits.length >= limit) {
        if (found.hits.length > 0) more = true;
      } else {
        for (const hit of found.hits) hits.push({ ...hit, memory: i + 1 });
        if (found.more) more = true;
      }
      if (more) break;
    }
    return { hits, more, searched: attached.length };
  } finally {
    detachTms(db, refs);
  }
}
