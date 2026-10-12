import type { ClassifierAnswer } from "@earendil-works/pi-ai";

import { MODEL_DEFER_KIND } from "#src/model/machinery-kinds.ts";
import type { ReviewOutcome, RiskLevel, VerdictLean } from "#src/model/model-verdict.ts";
import { GENERIC_DENY_REASON } from "#src/model/model-verdict.ts";
import {
  classifierCostlyReason,
  classifierDangerCriteria,
  classifierDangerNote,
  classifierIntentGapReason,
  classifierUncertainReason,
} from "#src/review/verdict-copy.ts";
import { underscoresToWords } from "#src/utils.ts";

import { DANGER_NONE, RISK_RUBRIC } from "./questions.ts";

/**
 * The built-in answers as 0–1 probabilities/confidences: `bool` arrives
 * as a probability already, the 0–4 `score` is normalized by
 * {@link projectClassifierAnswers}, so every answer speaks one scale.
 */
export interface ClassifierAnswers {
  dangerCategory: string;
  dangerConfidence: number;
  intentMatch: number;
  riskScore: number;
  riskConfidence: number;
}

export interface ClassifierThresholds {
  intentThreshold: number;
  riskThreshold: number;
  confidenceThreshold: number;
}

/**
 * Thrown when a classifier response is missing a required reading.
 * The adapter's catch routes it to a machinery defer (never allow) —
 * a reviewer that did not answer is broken, not uncertain.
 */
export class IncompleteClassifierResponseError extends Error {
  constructor(public readonly missing: string) {
    super(`incomplete classifier response: missing ${missing}`);
    this.name = "IncompleteClassifierResponseError";
  }
}

/**
 * Project pi-ai's typed answers into {@link ClassifierAnswers} — the single
 * 0–4 → 0–1 scale-conversion point.
 *
 * Readings are required: `danger_category` / `intent_match` / `risk` must
 * be present with their reading fields (choice / bool / score). A missing
 * reading throws {@link IncompleteClassifierResponseError} — "never answered"
 * is a malformed response, not a zero reading. Confidence is optional:
 * missing confidence reads as 0 (uncertain), the model's own defer path.
 *
 * @param raw - Pi-ai's typed answers by question id.
 * @returns The calibrated 0–1 answers.
 */
export function projectClassifierAnswers(raw: Record<string, ClassifierAnswer>): ClassifierAnswers {
  const danger = raw.danger_category;
  if (danger?.type !== "choice" || danger.choice === undefined) {
    throw new IncompleteClassifierResponseError("danger_category.choice");
  }
  const intent = raw.intent_match;
  if (intent?.type !== "bool" || intent.probability === undefined) {
    throw new IncompleteClassifierResponseError("intent_match.probability");
  }
  const risk = raw.risk;
  if (risk?.type !== "score" || risk.score === undefined) {
    throw new IncompleteClassifierResponseError("risk.score");
  }
  return {
    dangerCategory: danger.choice,
    dangerConfidence: danger.confidence ?? 0,
    intentMatch: intent.probability,
    // The score is the probability-weighted level index, so its range is the
    // rubric's own level count minus one (TypeSafe requires at least two
    // levels). Derive the divisor rather than hard-coding it: a hard-coded 4
    // silently mis-scales every band if the rubric gains or loses a level.
    riskScore: risk.score / (RISK_RUBRIC.length - 1),
    riskConfidence: risk.confidence ?? 0,
  };
}

/**
 * Danger category → audit risk tier. Every hard deny reads critical;
 * unlisted categories fall back to high (an unknown danger is never soft).
 * Confirm-defers carry the tier too: the label grades the model's reading,
 * not the verdict the link reached.
 */
const DANGER_TIER: Readonly<Record<string, RiskLevel>> = {
  secrets_credentials: "critical",
  irreversible_destruction: "critical",
  sensitive_data_egress: "critical",
  system_tampering: "critical",
  persistent_system_changes: "critical",
  external_code_execution: "critical",
  destructive_vcs: "critical",
  resource_abuse_dos: "critical",
};

/**
 * Map a normalized risk score (0–1) to its audit tier. Fixed — it does not
 * move with `riskThreshold`, so audit labels stay comparable across configs.
 * The bands are quartiles of the 0–4 rubric's own span, and the rubric's
 * anchors are named for damage, not for tiers — so anchor text and audit tier
 * are separate vocabularies and a log line can never read as contradicting
 * itself:
 *
 * | raw | score band  | tier     | rubric anchor             |
 * | --- | ----------- | -------- | ------------------------- |
 * | 0   | [0, 0.25)   | low      | No damage                 |
 * | 1   | [0.25, 0.5) | medium   | Bounded damage            |
 * | 2   | [0.5, 0.75) | high     | Costly or hard to reverse |
 * | 3   | [0.75, 1)   | critical | Severe                    |
 * | 4   | 1.0         | critical | Catastrophic              |
 *
 * Anchor k lands in band k, so the top band holds the last two anchors — four
 * bands and five anchors cannot line up one-to-one.
 *
 * The band boundaries are load-bearing: {@link denyTier} makes high|critical
 * hard and low|medium soft, so at the default 0.5 line no risk-lane deny can
 * land in the soft tier, where permissive would allow it.
 *
 * @param riskScore - The normalized 0–1 risk score.
 * @returns The audit tier.
 */
export function riskLevelFromScore(riskScore: number): RiskLevel {
  if (riskScore >= 0.75) return "critical";
  if (riskScore >= 0.5) return "high";
  if (riskScore >= 0.25) return "medium";
  return "low";
}

/**
 * The reviewer's directional inclination on an unresolved verdict: which way
 * it would decide if forced. A risk score at or above the deny line leans
 * deny; a pure intent gap with trusted readings leans allow; anything else is
 * neutral. The danger path sets its own lean, so it never reaches here.
 * Never surfaced to the human (anti-anchoring invariant).
 *
 * @param answers - The calibrated answers.
 * @param thresholds - The intent/risk/confidence thresholds.
 * @param confident - Whether both confidences clear the floor (false on
 *   the low-confidence defer branch — an untrusted reading leans nothing).
 * @returns The lean, or undefined for neutral.
 */
function deriveLean(
  answers: ClassifierAnswers,
  thresholds: ClassifierThresholds,
  confident: boolean,
): VerdictLean | undefined {
  if (answers.riskScore >= thresholds.riskThreshold) return "deny";
  if (confident && answers.intentMatch < thresholds.intentThreshold) return "allow";
  return undefined;
}

/**
 * Which confirmation note rides the defer, or null for the hard deny:
 * unauthorized hits stay terminal; authorized or unsure ones defer.
 *
 * @param answers - The calibrated answers.
 * @param thresholds - The intent/risk/confidence thresholds.
 * @returns The parenthetical note for the confirm-defer, or null.
 */
function dangerNote(answers: ClassifierAnswers, thresholds: ClassifierThresholds): string | null {
  if (answers.dangerConfidence < thresholds.confidenceThreshold) return classifierDangerNote(false);
  if (answers.intentMatch >= thresholds.intentThreshold) return classifierDangerNote(true);
  return null;
}

/**
 * Synthesize a {@link ReviewOutcome} from calibrated answers: a danger hit
 * nobody asked for → hard deny; an authorized or unsure hit → confirm-defer
 * (deny lean, so `defer-danger` asks in every mode but strict); low
 * confidence → defer; intent plus risk below the deny line → allow; risk at
 * or above the line → deny when unauthorized, confirm-defer when authorized.
 * Classify never allows a danger hit: a confirmation is settled by a human.
 * The tier is a fixed audit label ({@link riskLevelFromScore}), so it never
 * moves with `riskThreshold` — at the default 0.5 every risk-lane deny reads
 * high/critical and blocks in every mode.
 *
 * @param answers - The calibrated answers.
 * @param thresholds - The intent/risk/confidence thresholds.
 * @param latencyMs - The call latency for the audit record.
 * @returns The synthesized review outcome.
 */
export function synthesizeClassifierVerdict(
  answers: ClassifierAnswers,
  thresholds: ClassifierThresholds,
  latencyMs: number,
): ReviewOutcome {
  if (answers.dangerCategory !== DANGER_NONE) {
    const criteria = classifierDangerCriteria(underscoresToWords(answers.dangerCategory));
    const riskLevel = DANGER_TIER[answers.dangerCategory] ?? "high";
    const note = dangerNote(answers, thresholds);
    if (note === null) {
      return { verdict: { kind: "deny", reason: criteria }, latencyMs, riskLevel };
    }
    return {
      verdict: { kind: "defer" },
      deferKind: MODEL_DEFER_KIND,
      deferReason: `${criteria} (${note})`,
      lean: "deny",
      latencyMs,
      riskLevel,
    };
  }
  // Every exit below carries the label: the log reader grades risk against
  // the model's reading, not the verdict the link reached.
  const minConfidence = Math.min(answers.dangerConfidence, answers.riskConfidence);
  const riskLevel = riskLevelFromScore(answers.riskScore);
  if (minConfidence < thresholds.confidenceThreshold) {
    return {
      verdict: { kind: "defer" },
      deferKind: MODEL_DEFER_KIND,
      // The flag names the reading that fell short; the ask is one shape.
      deferReason: classifierUncertainReason(answers.dangerConfidence <= answers.riskConfidence),
      lean: deriveLean(answers, thresholds, false),
      latencyMs,
      riskLevel,
    };
  }
  // Allow needs both: the anchor authorizes it AND risk stays below the
  // deny line.
  if (
    answers.intentMatch >= thresholds.intentThreshold &&
    answers.riskScore < thresholds.riskThreshold
  ) {
    return { verdict: { kind: "allow" }, latencyMs, riskLevel };
  }
  if (answers.riskScore >= thresholds.riskThreshold) {
    // Authorized but costly: the anchor's own request is the reason this is
    // not the generic deny — the operator confirms the price. Unauthorized
    // stays a generic deny (no category to name).
    if (answers.intentMatch >= thresholds.intentThreshold) {
      return {
        verdict: { kind: "defer" },
        deferKind: MODEL_DEFER_KIND,
        deferReason: classifierCostlyReason(),
        lean: "deny",
        latencyMs,
        riskLevel,
      };
    }
    return {
      verdict: { kind: "deny", reason: GENERIC_DENY_REASON },
      latencyMs,
      riskLevel,
    };
  }
  // Only intent can still fall short here (risk at or above the line already
  // denied above), so {@link deriveLean}'s risk branch cannot fire on this exit.
  return {
    verdict: { kind: "defer" },
    deferKind: MODEL_DEFER_KIND,
    deferReason: classifierIntentGapReason(),
    lean: deriveLean(answers, thresholds, true),
    latencyMs,
    riskLevel,
  };
}
