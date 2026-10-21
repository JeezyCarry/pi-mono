/**
 * The suspicion line — the total order every mode's cut lines are drawn on,
 * and the one geometry that places a rung in a band. Lives on its own so the
 * config contract (which must validate a custom mode's cut lines) and the
 * ladder table (which must read them) can both depend on it without a cycle
 * between them.
 */

/**
 * The reviewer-suspicion order — the total order the ladder is drawn on,
 * strictest last (ADR 0002). A `defer`'s rank is set by its lean (benign /
 * none / danger); a `deny`'s by its tier. Machinery failures are NOT on this
 * line: they are a separate axis (a failure to obtain a verdict, not a
 * suspicion), carried by each mode's `onReviewFailure` lane. A danger-leaned
 * defer sits above a soft deny: a mode that rejects at that rung never lets a
 * danger confirmation auto-flow into an allow.
 */
export const SUSPICION_ORDER = [
  "allow",
  "defer-benign",
  "defer-neutral",
  "defer-danger",
  "soft-deny",
  "hard-deny",
] as const;

export type Suspicion = (typeof SUSPICION_ORDER)[number];

/**
 * A suspicion rung's rank (higher = more suspicious).
 *
 * @param suspicion - A rung of the suspicion order.
 * @returns Its index in {@link SUSPICION_ORDER}.
 */
export function suspicionRank(suspicion: Suspicion): number {
  return SUSPICION_ORDER.indexOf(suspicion);
}

/**
 * A mode's two cut lines on the suspicion order: at or below the accept line
 * the mode auto-allows; at or above the reject line it auto-denies; between
 * them it asks (defers). The cut-line shape makes each mode's allow / ask /
 * deny bands contiguous (pinned by the contiguity test).
 */
export interface ModeCuts {
  /** At or below this rung the mode auto-allows (inclusive). */
  allowThrough: Suspicion;
  /** At or above this rung the mode auto-denies (inclusive). */
  denyFrom: Suspicion;
}

/**
 * Which band a mode's cuts put a rung in — the ladder's one geometry, used by
 * the verdict mapping and by the ask-band derivation, so the mapping and its
 * own invariants cannot disagree.
 *
 * @param cuts - The mode's two cut lines.
 * @param suspicion - The rung to place.
 * @returns `allow` at or below the accept line, `deny` at or above the reject
 *   line, `ask` between them (allow wins when the lines cross).
 */
export function suspicionBand(cuts: ModeCuts, suspicion: Suspicion): "allow" | "ask" | "deny" {
  const rank = suspicionRank(suspicion);
  if (rank <= suspicionRank(cuts.allowThrough)) return "allow";
  return rank >= suspicionRank(cuts.denyFrom) ? "deny" : "ask";
}

/**
 * Whether cuts leave no ask band at all: the accept line touches or passes
 * the reject line, so no rung lands between them.
 *
 * @param cuts - The mode's two cut lines.
 * @returns True when every rung maps to allow or deny, never to ask.
 */
export function hasNoAskBand(cuts: ModeCuts): boolean {
  return SUSPICION_ORDER.every((s) => suspicionBand(cuts, s) !== "ask");
}

/**
 * Whether two pairs of cut lines place every rung in the same band.
 *
 * @param left - One pair of cut lines.
 * @param right - The other pair.
 * @returns True when both draw the same allow / ask / deny bands.
 */
export function sameBands(left: ModeCuts, right: ModeCuts): boolean {
  return SUSPICION_ORDER.every((s) => suspicionBand(left, s) === suspicionBand(right, s));
}
