/**
 * Recorded segment exceptions and when they propose a change to an entry
 * (smart-glossary-spec.md §6; backlog #110). A translator who uses an
 * acceptable alternative in one segment is making an exception; recording it
 * (`segment_exception`) leaves the preference alone. When the same
 * alternative has been recorded for this many distinct segments since the
 * preference last changed, the Terms tab proposes making it the preferred
 * one, and a person confirms.
 *
 * **Provisional, like `RATE_TIERS`:** three is a first guess at "enough that
 * it is a pattern, not one translator's taste", with no real data behind it.
 * It is one constant so changing it changes one place; the count is derived
 * from the log each time (`db/glossary/exceptions.ts`), never stored.
 */
export const EXCEPTION_PROPOSAL_MIN = 3;
