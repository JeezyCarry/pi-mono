/**
 * Shared test constants for both review-engine suites (chat and classifier).
 * Anything that pins a convention the two lanes hold in common lives here, so
 * the wording standard cannot drift between suites.
 */

/**
 * The shared exclusion pattern for the positive-inclusion convention: each
 * alternative keeps its own word boundaries, and the spaces inside an
 * alternative become whitespace runs, so a reflow-split exclusion ("is"
 * followed by a newline then "not") still trips it. Both lanes test against
 * this one set.
 */
const EXCLUSION_SHAPE = "is not|are not|never|not this|excluding|rather than|instead of";
export const EXCLUSION = new RegExp(
  `\\b(?:${EXCLUSION_SHAPE.split("|")
    .map((phrase) => phrase.replace(/ /g, "\\s+"))
    .join("|")})\\b`,
  "i",
);
