/**
 * `pnpm licenses:check` — fails when a production dependency carries a license
 * the policy in `license-policy.mjs` does not allow (issue #259). Needs
 * `pnpm install` first, because `pnpm licenses` reads `node_modules`.
 *
 * `license-policy.test.ts` runs the same check inside `pnpm test`, which is how
 * CI enforces it without a workflow of its own.
 */
import { execFileSync } from 'node:child_process';
import { checkLicenses } from './license-policy.mjs';

/**
 * Reads the production dependency licenses from pnpm.
 *
 * @returns {Record<string, Array<{ name: string, versions?: string[] }>>}
 * @throws When pnpm fails (typically no install) or prints something that is
 *   not JSON.
 */
export function readProductionLicenses() {
  const out = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkLicenses(readProductionLicenses());
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.name}@${v.versions.join(',')}: ${v.license}`);
    }
    console.error(
      `\n${violations.length} production package(s) outside the license policy.` +
        ' Replace them, or record an exception with its reason in scripts/license-policy.mjs.',
    );
    process.exit(1);
  }
  console.log('Production dependency licenses: all within policy.');
}
