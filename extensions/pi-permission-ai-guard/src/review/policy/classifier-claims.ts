/**
 * The classifier lane's model claims.
 *
 * The lane's four-axis answers become {@link ModelClaim}s that may only tighten
 * the deterministic base tier (`factTier`). Over-claiming is safe (it costs an
 * ask); under-claiming cannot release, because the base already came from code.
 *
 * Confidence travels with each claim so the core applies the same floor the
 * four axes do: a positive reading below the floor is unresolved, never
 * trusted. This is why the signature takes the readings' confidences.
 */

import type {
  BanReading,
  EffectReading,
  IntentReading,
  TargetReading,
} from "#src/review/axes/verdict.ts";
import { atOrAboveFloor, DEFAULT_CONFIDENCE_THRESHOLD } from "#src/review/confidence-floor.ts";
import type { CommandFacts } from "#src/review/request/command-facts.ts";

import type { ModelClaim, PolicyConcept, Presence } from "./concepts.ts";
import { insideScope } from "./fact-tier.ts";

/** The four-axis readings with the confidence of each. */
export interface ClassifierReadings {
  readonly ban: BanReading;
  readonly banConfidence: number;
  readonly effect: EffectReading;
  readonly effectConfidence: number;
  readonly target: TargetReading;
  readonly targetConfidence: number;
  readonly intent: IntentReading;
  readonly intentConfidence: number;
  /** Whether the trusted record carries an anchor. */
  readonly hasAnchor: boolean;
}

const min = (a: number, b: number): number => (a < b ? a : b);

/**
 * Build the classifier lane's claims for one request.
 *
 * @param readings - The four-axis readings and their confidences.
 * @param facts - The deterministic command facts.
 * @param threshold - The confidence floor (see {@link DEFAULT_CONFIDENCE_THRESHOLD}). An
 *   untrusted effect reading becomes an `unreadable_action` claim, so the core defers even if
 *   the caller forgets `laneUnresolved`.
 * @returns The claims, tighten-only.
 */
export function classifierClaims(
  readings: ClassifierReadings,
  facts: CommandFacts,
  threshold = DEFAULT_CONFIDENCE_THRESHOLD,
): ModelClaim[] {
  const { ban, banConfidence, effect, effectConfidence, target, targetConfidence } = readings;
  const out: ModelClaim[] = [];
  const claim = (concept: PolicyConcept, presence: Presence, confidence?: number): void => {
    out.push(confidence === undefined ? { concept, presence } : { concept, presence, confidence });
  };
  // The release gate reads the intent axis: only a trusted `requested` names
  // the action. A missing anchor, or any other intent, leaves it unresolved.
  if (readings.hasAnchor) {
    claim(
      "authorization_anchor",
      readings.intent === "requested" ? "confirmed" : "unknown",
      readings.intentConfidence,
    );
  }
  const byTarget = min(effectConfidence, targetConfidence);

  if (ban === "forbids") claim("human_ban", "confirmed", banConfidence);
  else if (ban === "unestablished") claim("human_ban", "unknown", banConfidence);

  if (effect === "cannot_determine" || !atOrAboveFloor(effectConfidence, threshold)) {
    // A guess about the action is not evidence. The claim's confidence is a
    // code-level statement about the reading, not a model number, so it is
    // trusted and the core defers without a lean.
    claim("unreadable_action", "confirmed", 1);
    return out;
  }

  if (target === "credential_material" && effect === "read") {
    claim("credential_exposure", "confirmed", byTarget);
  }
  if (target === "credential_material" && (effect === "modify" || effect === "send_out")) {
    claim("credential_egress", "confirmed", byTarget);
  }

  if (effect === "delete") {
    if (facts.namedBuildOutput) {
      // Regenerable output: the base already reads it free; nothing to raise.
    } else if (
      facts.pathScope === "unknown" ||
      (facts.recursive && facts.pathScope === "outside")
    ) {
      claim("unbounded_deletion", "confirmed", effectConfidence);
    } else {
      claim("ordinary_deletion", "confirmed", effectConfidence);
    }
  } else if (effect === "read") {
    if (facts.network === "restricted")
      claim("restricted_network_read", "confirmed", effectConfidence);
    else if (
      !facts.publicSystemPath &&
      (facts.pathScope === "outside" || facts.pathScope === "unknown")
    ) {
      claim("outside_workspace_read", "confirmed", effectConfidence);
    }
  } else if (effect === "modify") {
    const inside = insideScope(facts);
    const plain = (target === "ordinary_files" || target === "none") && inside;
    const workspaceVcs = target === "vcs_history" && !facts.rewritesHistory && inside;
    if (plain || workspaceVcs) claim("workspace_modification", "confirmed", effectConfidence);
    else claim("other_action", "confirmed", effectConfidence);
  } else {
    claim("other_action", "confirmed", effectConfidence);
  }

  return out;
}
