/**
 * The one confidence floor both lanes read.
 *
 * The classifier axes and the claims adapters both treat a positive reading
 * below the floor as unresolved, and both must treat a missing or NaN
 * confidence the same way. The floor value and the comparison live here so the
 * two paths cannot drift; the threshold itself stays configurable per lane.
 */

/** The default confidence floor: a positive reading below this is unresolved. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Whether a confidence clears the floor.
 *
 * The floor is inclusive (`>=`, not `>`): a reading the model gave exactly the
 * threshold confidence is still a reading. A missing or NaN value never clears
 * it, so a broken confidence reads as `unknown`, never as a trusted positive.
 *
 * @param confidence - The reading's confidence (NaN when the wire omitted it).
 * @param threshold - The configured floor.
 * @returns True when the confidence is a real number at or above the floor.
 */
export function atOrAboveFloor(confidence: number | undefined, threshold: number): boolean {
  return confidence !== undefined && confidence >= threshold;
}
