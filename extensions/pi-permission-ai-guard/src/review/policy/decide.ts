/**
 * The shared decision core: one pure function from a deterministic base tier
 * plus a lane's model claims to a ruling.
 *
 * The base comes from `CommandFacts` (code) and is trusted. Model claims may
 * only **tighten** it — raise danger, or turn an unresolved concept into a
 * defer — never open a release. So a model's bad reading costs an ask, and a
 * release is always justified by code.
 *
 * The core is a **soft** ruling layer. Its `deny` is a policy deny that maps
 * through the ladder; it is never a hard deny. Hard-deny authority belongs to
 * the screen and upstream rules, which run outside and cannot be lifted.
 */

import type { RiskLevel } from "#src/model/model-verdict.ts";
import { atOrAboveFloor } from "#src/review/confidence-floor.ts";
import type { CommandFacts } from "#src/review/request/command-facts.ts";

import {
  CONCEPT_RULING,
  TIER_RANK,
  type FactRuling,
  type ModelClaim,
  type PolicyConcept,
  type Presence,
  type Tier,
} from "./concepts.ts";

/** The ruling core, before mode mapping. */
export interface PolicyRuling {
  readonly tier: Tier;
  readonly kind: "allow" | "defer" | "deny";
  readonly lean?: "allow" | "deny";
  readonly riskLevel?: RiskLevel;
  readonly decidedBy: PolicyConcept;
}

/**
 * A lane's completeness contract. A lane whose schema makes every reading
 * mandatory is complete by construction; a lane whose schema can omit a
 * concept must answer every applicable one, or its silence cannot be told
 * from "no danger".
 */
export type LaneCompleteness = "every-applicable-concept-answered" | "axes-are-mandatory";

export interface DecideInput {
  /** The deterministic base tier (from `factTier`). */
  readonly base: FactRuling;
  /** The lane's model claims. Tighten-only. */
  readonly claims: readonly ModelClaim[];
  /** Whether the trusted record carries an authorization anchor (code-set). */
  readonly hasTrustedAnchor: boolean;
  /**
   * The lane's primary reading is below the confidence floor. Required (not
   * optional): a lane that can be unresolved must say so, so a forgotten flag
   * is a compile error rather than a release.
   */
  readonly laneUnresolved: boolean;
  /** The lane's completeness contract. */
  readonly completeness: LaneCompleteness;
}

export interface DecideOptions {
  /**
   * Positive readings below this are not adopted. The default is the shared
   * `DEFAULT_CONFIDENCE_THRESHOLD` (0.5).
   */
  readonly confidenceThreshold: number;
  /** The facts, used only to derive the applicable concept set. */
  readonly facts: CommandFacts;
}

/**
 * The concepts a lane must positively address (`confirmed` or `absent`) for a
 * release to be complete, given the action's shape.
 *
 * This is the completeness contract: a message that omits one of these cannot
 * distinguish "no danger" from "not checked", so the core defers. The model-only danger concepts
 * (remote code execution, resource exhaustion, system tampering) are deliberately
 * not among the required set: there is no applicability fact for their shapes
 * yet, so the core gates on them only when the lane *confirms* one, and
 * otherwise rates the shape by its code effect like any other run. See the
 * inline note at step 8 for the one open gap this leaves.
 *
 * @param facts - The command's deterministic facts.
 * @returns The applicable concepts for the shape.
 */
function requiredConcepts(facts: CommandFacts): PolicyConcept[] {
  // A routine command is the project's own script: the code has already
  // identified the action, so no model-only hazard applies and the release is
  // facts-supported. Both lanes get the same answer.
  if (facts.routineDevCommand) return ["workspace_modification"];
  const effect = facts.commandEffect === "unknown" ? "run_program" : facts.commandEffect;
  switch (effect) {
    case "read":
      return ["credential_exposure", "restricted_network_read", "outside_workspace_read"];
    case "delete":
      return ["unbounded_deletion"];
    case "modify":
      return ["credential_egress"];
    default:
      return ["other_action", "data_egress"];
  }
}

// A claim's presence after confidence gating. A `confirmed` reading needs an
// explicit confidence at or above the floor; a missing or low confidence is
// `unknown`, never trusted. This matches the four axes' floor.
function gated(claim: ModelClaim, threshold: number): Presence {
  if (claim.presence !== "confirmed") return claim.presence;
  // The floor is inclusive, so a reading exactly on it is still a reading.
  return atOrAboveFloor(claim.confidence, threshold) ? "confirmed" : "unknown";
}

// Merge a concept's claims into one presence. Contradictory readings
// (`confirmed` alongside `absent`) resolve to `unknown`, never to a release.
function mergePresences(
  claims: readonly ModelClaim[],
  threshold: number,
): Map<PolicyConcept, Presence> {
  const seen = new Map<PolicyConcept, Set<Presence>>();
  for (const claim of claims) {
    const set = seen.get(claim.concept) ?? new Set<Presence>();
    set.add(gated(claim, threshold));
    seen.set(claim.concept, set);
  }
  const merged = new Map<PolicyConcept, Presence>();
  for (const [concept, set] of seen) {
    const [only] = set;
    merged.set(concept, set.size === 1 && only ? only : "unknown");
  }
  return merged;
}

function isTier(ruling: string): ruling is Tier {
  return ruling in TIER_RANK;
}

/**
 * Decide one request.
 *
 * @param input - The base tier, the lane's claims, and the lane's contract.
 * @param options - Thresholds and the facts (for the applicable-concept set).
 * @returns The ruling (tier, kind, lean, risk level, deciding concept).
 */
export function decidePolicy(input: DecideInput, options: DecideOptions): PolicyRuling {
  const presence = mergePresences(input.claims, options.confidenceThreshold);
  const at = (concept: PolicyConcept): Presence => presence.get(concept) ?? "unknown";
  const confirmed = (concept: PolicyConcept): boolean => at(concept) === "confirmed";

  // The release gate: the trusted record must carry an anchor (code-set), AND
  // the lane must confirm `authorization_anchor` at or above the floor.
  const requested = input.hasTrustedAnchor && confirmed("authorization_anchor");

  // 1. A trusted recorded ban denies. `human_ban` is the lane's reading of the
  //    trusted instruction set, gated by the confidence floor like the ban
  //    axis; a below-floor reading is `unknown` and only defers.
  if (confirmed("human_ban")) {
    return { tier: "block", kind: "deny", riskLevel: "critical", decidedBy: "human_ban" };
  }
  if (presence.has("human_ban") && at("human_ban") !== "absent") {
    return { tier: "guard", kind: "defer", lean: "deny", decidedBy: "human_ban" };
  }

  // 2. An unresolved lane reading cannot be rated. A guess about the action is
  //    not evidence, so the core defers without a lean rather than trusting a
  //    tier the reading did not establish.
  if (input.laneUnresolved) {
    return { tier: input.base.tier, kind: "defer", decidedBy: input.base.concept };
  }

  // 3. The effective tier is the strictest of the base and the danger claims.
  const effective = strictestTier(input.base.tier, confirmedDangerTier(presence));
  if (effective === "block") {
    return {
      tier: "block",
      kind: "defer",
      lean: "deny",
      riskLevel: "critical",
      decidedBy: firstDanger(presence, "block") ?? input.base.concept,
    };
  }
  // 4. A block concept the record may hold, unresolved, defers leaning deny.
  const unresolved = firstUnresolvedDanger(presence);
  if (unresolved && CONCEPT_RULING[unresolved] === "block") {
    return { tier: "guard", kind: "defer", lean: "deny", decidedBy: unresolved };
  }

  // 5. An unreadable action defers without a lean.
  if (confirmed("unreadable_action")) {
    return { tier: "guard", kind: "defer", decidedBy: "unreadable_action" };
  }

  // 6. An unresolved guard/escalator danger defers leaning deny.
  if (unresolved) {
    return { tier: "guard", kind: "defer", lean: "deny", decidedBy: unresolved };
  }

  // 7. Escalator tier: a named request still asks.
  if (effective === "escalator") {
    return {
      tier: "escalator",
      kind: "defer",
      lean: "deny",
      decidedBy: firstDanger(presence, "escalator") ?? input.base.concept,
    };
  }

  // 8. A release requires completeness: the lane answered every applicable
  //    concept. Only the sparse chat schema can fail this.
  //
  //    NOTE: the model-only hazards (`remote_code_execution`,
  //    `resource_exhaustion`, `system_tampering`) are deliberately NOT in the
  //    required set. Whether they are *applicable* is a property of the shape
  //    the code must establish from the AST (a fetch segment feeding an
  //    execute segment, an unbounded spawn), not something a sparse reply can
  //    answer. Until that fact exists, a fetch-then-execute chain is rated by
  //    its code effect like any other run. This is the one open gap in the
  //    uniform release rule; it must not be closed by over-deferring every
  //    run/send shape.
  if (input.completeness === "every-applicable-concept-answered") {
    const missing = missingConcept(presence, options.facts);
    if (missing) return { tier: effective, kind: "defer", lean: "deny", decidedBy: missing };
  }

  // 9. An unproven action asks even on a named request: the request names what
  //    was asked, it does not prove the action is bounded.
  if (effective === "unproven") {
    return { tier: "unproven", kind: "defer", lean: "deny", decidedBy: input.base.concept };
  }

  if (effective === "guard") {
    const concept = firstDanger(presence, "guard") ?? input.base.concept;
    return requested
      ? { tier: "guard", kind: "allow", decidedBy: concept }
      : { tier: "guard", kind: "defer", lean: "deny", decidedBy: concept };
  }

  if (effective === "plain") {
    return requested
      ? { tier: "plain", kind: "allow", decidedBy: input.base.concept }
      : { tier: "plain", kind: "defer", lean: "allow", decidedBy: input.base.concept };
  }

  return { tier: "free", kind: "allow", decidedBy: input.base.concept };
}

// The strictest tier among the confirmed danger claims.
function confirmedDangerTier(presence: Map<PolicyConcept, Presence>): Tier | undefined {
  let best: Tier | undefined;
  for (const [concept, p] of presence) {
    if (p !== "confirmed") continue;
    const ruling = CONCEPT_RULING[concept];
    if (!isTier(ruling) || TIER_RANK[ruling] < TIER_RANK.guard) continue;
    if (best === undefined || TIER_RANK[ruling] > TIER_RANK[best]) best = ruling;
  }
  return best;
}

function strictestTier(a: Tier, b: Tier | undefined): Tier {
  if (b === undefined) return a;
  return TIER_RANK[b] > TIER_RANK[a] ? b : a;
}

// The first confirmed concept with the given ruling, in claim order.
function firstDanger(
  presence: Map<PolicyConcept, Presence>,
  ruling: string,
): PolicyConcept | undefined {
  for (const [concept, p] of presence) {
    if (p === "confirmed" && CONCEPT_RULING[concept] === ruling) return concept;
  }
  return undefined;
}

// The first unresolved (`unknown`) guard/escalator/block concept.
function firstUnresolvedDanger(presence: Map<PolicyConcept, Presence>): PolicyConcept | undefined {
  for (const [concept, p] of presence) {
    if (p !== "unknown") continue;
    const ruling = CONCEPT_RULING[concept];
    if (ruling === "block" || ruling === "escalator" || ruling === "guard") return concept;
  }
  return undefined;
}

// The first applicable concept the lane did not answer (`confirmed`/`absent`).
function missingConcept(
  presence: Map<PolicyConcept, Presence>,
  facts: CommandFacts,
): PolicyConcept | undefined {
  for (const concept of requiredConcepts(facts)) {
    const p = presence.get(concept);
    if (p !== "confirmed" && p !== "absent") return concept;
  }
  return undefined;
}
