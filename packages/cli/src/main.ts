#!/usr/bin/env node
/**
 * `cat-tool` — the headless driver (v1-spec.md §2.4; backlog #25).
 *
 * Everything lives in `cli.ts` so a test can run a whole job through
 * `runCli` without spawning a process; this file only binds it to the
 * real process.
 */

import { runCli } from './cli.js';

process.exitCode = runCli(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
