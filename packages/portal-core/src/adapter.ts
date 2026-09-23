/**
 * Production adapter seam (portal-v0-spec.md §1).
 *
 * A `translation_order` is a business object; how it actually gets
 * translated is behind this interface. v0 ships exactly one
 * implementation, `ManualProductionAdapter`, which is a deliberate no-op —
 * production happens outside the system (Trados/DeepL by hand) and
 * finishes with an admin uploading finished files through the existing
 * delivery flow. A future `CatToolProductionAdapter` implements the same
 * interface once the CAT tool (Ring 0) is ready; nothing about the order
 * model, pricing, or notifications changes.
 */
export interface ProductionAdapter {
  readonly name: string;
}

/** v0's only adapter: production is entirely manual, outside this system. */
export class ManualProductionAdapter implements ProductionAdapter {
  readonly name = 'manual';
}
