#!/usr/bin/env node
/**
 * PreToolUse hook for code repos: warn before commercial or confidential
 * material is written into the repo (shared/CODING.md, "Commercial and
 * confidential material"). Copy it to `.claude/hooks/commercial-guard.js` and
 * merge `commercial-guard.json` into the repo's `.claude/settings.json`.
 *
 * Reads the hook's JSON from stdin. When the text a tool is about to write (a
 * file inside the repo, a commit or tag message, a `gh pr`/`gh issue` command,
 * or a GitHub MCP write to this same repository) holds a marker, it answers
 * `permissionDecision: "ask"` with the markers found, so the person sees a
 * warning and decides. It never blocks by itself and never edits the input.
 *
 * A repo may add its own markers in `.claude/commercial-markers.txt`, one
 * case-insensitive regular expression per line (`#` starts a comment), for
 * example the name of the private repository that holds its business notes.
 * Keep that file out of a public repo if a marker would itself reveal
 * something.
 *
 * A keyword check, never a guarantee: a price in words, or a customer named
 * without any marker, passes. The session still owns the rule.
 *
 * @module commercial-guard
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Markers of commercial or confidential material, each with a label. */
const MARKERS = [
  [/\b(customer|client|prospect)-\d{2}\b/i, 'a customer key'],
  [/\bprospect(s|ive customer|ive client)?\b/i, 'a prospect'],
  [/\b(pricing|price list|price point|per[- ]seat|per[- ]user per month|subscription fee|licen[cs]e fee)\b/i, 'pricing'],
  // `$1` and `$2` are shell and regex variables, so a dollar needs two digits.
  [/(€|£)\s?\d|\$\s?\d{2,}|\b\d[\d,.]*\s?(€|eur|euros?|usd|dollars?|gbp)\b/i, 'an amount of money'],
  // Not "invoice" or "margin": common in trade data and CSS.
  [/\b(revenue|mrr|arr|quote for|discount|billing)\b/i, 'sales figures or billing'],
  [/\b(go-to-market|sales pipeline|deal size|letter of intent|term sheet)\b/i, 'go-to-market'],
  [/\b(nda|non-disclosure|confidential(ity)? agreement|pilot agreement|master services agreement|statement of work)\b/i, 'a contract'],
  [/\b(trade secret|patent (filing|search|application))\b/i, 'IP strategy'],
  [/\b(strictly confidential|internal only|do not distribute)\b/i, 'a confidentiality marking'],
];

/** Files that must name the markers to do their job. */
const EXEMPT = [
  path.join('.claude', 'hooks', 'commercial-guard.js'),
  path.join('.claude', 'commercial-markers.txt'),
];

/**
 * The repo's own markers from `.claude/commercial-markers.txt`, if any.
 * A line that is not a valid regular expression is skipped.
 * @param {string} root the repository root
 * @returns {Array<[RegExp, string]>}
 */
function repoMarkers(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, '.claude', 'commercial-markers.txt'), 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).flatMap((l) => {
    try { return [[new RegExp(l, 'i'), 'a marker this repo lists']]; } catch { return []; }
  });
}

/**
 * The markers found in a text.
 * @param {string} text
 * @param {Array<[RegExp, string]>} [extra] the repo's own markers
 * @returns {string[]} labels, once each, in list order
 */
function findMarkers(text, extra = []) {
  if (!text) return [];
  const labels = [...MARKERS, ...extra].filter(([re]) => re.test(text)).map(([, label]) => label);
  return [...new Set(labels)];
}

/**
 * This repository's name on GitHub, read from `.git/config`'s origin URL,
 * else the folder's name.
 * @param {string} root
 * @returns {string}
 */
function repoName(root) {
  try {
    const cfg = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
    if (m) return path.basename(m[1]).replace(/\.git$/, '');
  } catch { /* not a checkout, or a worktree: fall through */ }
  return path.basename(root);
}

/**
 * What a tool is about to write into this repo, or null when it writes
 * nothing here (a read, a path outside the repo, another repository).
 * @param {object} input the hook's JSON
 * @param {string} root the repository root
 * @returns {string|null}
 */
function textToCheck(input, root) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const file = ti.file_path || ti.notebook_path || '';
    const rel = path.relative(root, path.resolve(root, file));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (EXEMPT.includes(rel)) return null;
    const edits = Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string).join('\n') : '';
    return [ti.content, ti.new_string, ti.new_source, edits].filter(Boolean).join('\n');
  }
  if (tool === 'Bash') {
    const cmd = ti.command || '';
    return /\bgit\s+(commit|tag)\b|\bgh\s+(pr|issue)\b/.test(cmd) ? cmd : null;
  }
  if (tool.startsWith('mcp__github__')) {
    if (ti.repo && ti.repo !== repoName(root)) return null;
    return [ti.title, ti.body, ti.content, ti.message, ti.commit_message,
      ...(Array.isArray(ti.files) ? ti.files.map((f) => f.content) : [])]
      .filter((v) => typeof v === 'string').join('\n') || null;
  }
  return null;
}

/**
 * The hook's answer, or null to let the tool run without a word.
 * @param {object} input the hook's JSON
 * @param {string} root the repository root
 * @returns {object|null}
 */
function decide(input, root) {
  const found = findMarkers(textToCheck(input, root), repoMarkers(root));
  if (found.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason:
        `Possible commercial or confidential material about to go into this code repo (${found.join(', ')}). ` +
        'Business matters belong in the private repository the repo\'s CLAUDE.md names for them. ' +
        'Allow only if this is product text that names nothing commercial.',
    },
  };
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const out = decide(input, root);
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  });
}

module.exports = { findMarkers, textToCheck, decide, repoName, repoMarkers, MARKERS };
