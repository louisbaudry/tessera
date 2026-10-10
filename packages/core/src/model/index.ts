/**
 * The browser-safe part of `@cat-tool/core`, as `@cat-tool/core/model`
 * (backlog #29): the token model and the tag rules, which the SPA's
 * editor applies at runtime — which tags are hidden, what a valid target
 * is — rather than holding a second copy of them. Nothing here imports
 * anything but itself: `model/` is the base layer (CLAUDE.md), and the
 * lint config keeps it that way, so this entry can never pull
 * `node:crypto` or the DOCX filter into a bundle. The rest of `core` is
 * still type-only in the SPA.
 */
export * from './token.js';
export * from './tags.js';
export * from './hidden-tags.js';
export * from './words.js';
export * from './lang.js';
export * from './slug.js';
export * from './segment.js';
export * from './csv.js';
