/**
 * The `.ctm` layer's error type.
 *
 * Its own module rather than `index.ts`'s, so a module that `index.ts`
 * re-exports (`import-sdltm.ts`) can throw it without importing its own
 * barrel back — a cycle that works until the day module evaluation order
 * changes underneath it.
 */
export class TmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmError';
  }
}
