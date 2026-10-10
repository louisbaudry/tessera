/**
 * Links a translation memory or glossary to a client, so they can download
 * it from the portal (backlog #162, portal-v0-spec.md §9). A command-line
 * job, not an HTTP endpoint, on purpose: the path is typed by the operator
 * who owns the file, and nothing a request sends is ever a path.
 *
 *   pnpm --filter @cat-tool/portal-server run link-client-resource -- link <client-id> tm|glossary <absolute-path>
 *   pnpm --filter @cat-tool/portal-server run link-client-resource -- unlink <client-id> tm|glossary
 *   pnpm --filter @cat-tool/portal-server run link-client-resource -- list <client-id>
 *
 * Link only a file that is that client's alone. A client takes the whole
 * file; a base memory shared with other clients must never be linked.
 */
import { isAbsolute } from 'node:path';

import {
  ClientResourceError,
  getClient,
  linkClientResource,
  listClientResources,
  openPortalDb,
  unlinkClientResource,
} from '@cat-tool/db';
import { isClientResourceKind, type AuditActor } from '@cat-tool/portal-core';

import { loadConfig } from './config.js';

const OPERATOR: AuditActor = {
  actor: { kind: 'system', name: 'link-client-resource' },
  label: null,
};

const USAGE =
  'usage: link-client-resource link <client-id> tm|glossary <absolute-path>\n' +
  '       link-client-resource unlink <client-id> tm|glossary\n' +
  '       link-client-resource list <client-id>';

// `pnpm run <script> -- <args>` forwards the `--` itself (CLAUDE.md, gotchas).
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [command, clientArg, kindArg, pathArg] = args;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const clientId = Number(clientArg);
if (!command || !Number.isInteger(clientId) || clientId < 1) fail(USAGE);

const db = openPortalDb(loadConfig().dbPath);
try {
  const client = getClient(db, clientId);
  if (!client) fail(`no client #${clientId}`);

  if (command === 'list') {
    const links = listClientResources(db, clientId);
    if (links.length === 0) console.log(`client #${clientId} has nothing linked`);
    for (const l of links) console.log(`${l.kind}\t${l.name}\t${l.path}`);
  } else if (command === 'link' || command === 'unlink') {
    if (!kindArg || !isClientResourceKind(kindArg)) fail(USAGE);
    if (command === 'link') {
      if (!pathArg || !isAbsolute(pathArg)) fail(`${USAGE}\n(the path must be absolute)`);
      const link = linkClientResource(db, {
        actor: OPERATOR,
        clientId,
        kind: kindArg,
        path: pathArg,
      });
      console.log(
        `linked ${link.kind} "${link.name}" to client #${clientId} <${client.email}>`,
      );
    } else {
      unlinkClientResource(db, { actor: OPERATOR, clientId, kind: kindArg });
      console.log(`unlinked ${kindArg} from client #${clientId}`);
    }
  } else {
    fail(USAGE);
  }
} catch (err) {
  if (err instanceof ClientResourceError) fail(err.message);
  throw err;
} finally {
  db.close();
}
