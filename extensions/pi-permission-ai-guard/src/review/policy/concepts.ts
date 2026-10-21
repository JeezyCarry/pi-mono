/**
 * The protocol-independent policy vocabulary.
 *
 * The core has exactly two inputs, and they are cleanly separated by trust:
 *
 * - **`FactRuling`** — the deterministic base tier, computed from `CommandFacts` alone
 *   (`fact-tier.ts`). The code decides the baseline.
 * - **`ModelClaim[]`** — concepts a lane reads from the record. A claim may only **tighten** the base
 *   (raise danger); it can never open a release. So a model that misreads a safe command as
 *   dangerous costs an ask, never an allow.
 *
 * There is no per-item "fact/model source" to get wrong: the base is always
 * code, the claims are always the model.
 *
 * A concept is a domain word (what the action *is*); a `rowId` in
 * `src/review/axes/verdict.ts` is an audit identifier. They are not the same.
 */

/** How sure the model is that the concept is present. */
export type Presence = "confirmed" | "absent" | "unknown";

/**
 * The valid presences, derived from {@link Presence} (the single source of
 * truth). The type argument rejects a bad member at compile time; it cannot
 * catch an omission, so a new member has to be added here too.
 */
export const PRESENCES: ReadonlySet<string> = new Set<Presence>(["confirmed", "absent", "unknown"]);

/**
 * Type guard: is `value` one of the presences?
 *
 * @param value - The string to test.
 * @returns True if `value` is a valid presence (type-narrowed to `Presence`).
 */
export function isPresence(value: string): value is Presence {
  return PRESENCES.has(value);
}

/**
 * The ruling a concept carries when `confirmed`.
 *
 * - `block` — never released, not even by a named request (`critical`).
 * - `escalator` — a named request still asks (defer lean deny).
 * - `guard` — a named request releases it; otherwise ask leaning deny.
 * - `plain` — a named request releases it; otherwise ask leaning allow.
 * - `free` — allows, no anchor needed.
 * - `release` — the release gate (`authorization_anchor`) and the unreadable branch; not a tier of
 *   its own.
 */
export type ConceptRuling = "block" | "escalator" | "guard" | "plain" | "free" | "release";

/** Rulings that form a tier, strictest first. */
export type Tier = "block" | "escalator" | "unproven" | "guard" | "plain" | "free";

export const TIER_RANK: Readonly<Record<Tier, number>> = {
  block: 5,
  escalator: 4,
  unproven: 3,
  guard: 2,
  plain: 1,
  free: 0,
};

/** Closed set of policy concepts. See `docs/policy.md` (Part II, "Concepts"). */
export const POLICY_CONCEPTS = [
  "credential_exposure",
  "credential_egress",
  "data_egress",
  "artifact_publish",
  "environment_dump",
  "device_overwrite",
  "unbounded_deletion",
  "ordinary_deletion",
  "restricted_network_read",
  "outside_workspace_read",
  "persistence_install",
  "history_rewrite",
  "outward_listener",
  "regenerable_output",
  "public_system_read",
  "other_read",
  "workspace_modification",
  "other_action",
  "remote_code_execution",
  "resource_exhaustion",
  "system_tampering",
  "human_ban",
  "authorization_anchor",
  "unreadable_action",
] as const;

export type PolicyConcept = (typeof POLICY_CONCEPTS)[number];

export const CONCEPT_RULING: Readonly<Record<PolicyConcept, ConceptRuling>> = {
  credential_exposure: "block",
  credential_egress: "guard",
  data_egress: "escalator",
  artifact_publish: "block",
  environment_dump: "block",
  device_overwrite: "guard",
  unbounded_deletion: "block",
  ordinary_deletion: "guard",
  restricted_network_read: "guard",
  outside_workspace_read: "guard",
  persistence_install: "escalator",
  history_rewrite: "escalator",
  outward_listener: "escalator",
  regenerable_output: "free",
  public_system_read: "free",
  other_read: "free",
  workspace_modification: "plain",
  other_action: "guard",
  remote_code_execution: "escalator",
  resource_exhaustion: "escalator",
  system_tampering: "escalator",
  human_ban: "block",
  authorization_anchor: "release",
  unreadable_action: "release",
};

/** The deterministic base tier, computed from facts alone. */
export interface FactRuling {
  readonly tier: Tier;
  readonly concept: PolicyConcept;
}

/** A concept a lane reads from the record. Tighten-only. */
export interface ModelClaim {
  readonly concept: PolicyConcept;
  readonly presence: Presence;
  /** 0–1; gates positive readings only. Missing means "reported at all". */
  readonly confidence?: number;
}
