import type { ClassifierAnswer } from "@earendil-works/pi-ai";

import type { ClassifierQuestionId } from "#src/config/config-schema.ts";
import { MODEL_DEFER_KIND } from "#src/model/machinery-kinds.ts";
import type { ReviewOutcome, RiskLevel } from "#src/model/model-verdict.ts";
import { atOrAboveFloor } from "#src/review/confidence-floor.ts";
import type { CommandFacts } from "#src/review/request/command-facts.ts";
import {
  classifierBanReason,
  classifierInsufficientInfoReason,
  classifierIntentGapReason,
  classifierNeutralAskReason,
} from "#src/review/verdict-copy.ts";

import {
  type BAN_LABELS,
  CLASSIFIER_QUESTION_SET,
  type EFFECT_LABELS,
  type INTENT_LABELS,
  type TARGET_LABELS,
} from "./questions.ts";

// ── Tiers ───────────────────────────────────────────────────────────────

/**
 * The verdict tier a decision row assigns, before the authorization table
 * adjusts it. `free` needs no request; `plain` releases on a named request
 * and asks leaning allow without one; `guard` releases on a named request
 * and asks leaning deny without one; `block` asks leaning deny even with a
 * named request.
 */
export type VerdictTier = "free" | "plain" | "guard" | "block";

const TIER_RANK: Readonly<Record<VerdictTier, number>> = {
  free: 0,
  plain: 1,
  guard: 2,
  block: 3,
};

/**
 * The legal labels per axis, built from the question registry — the
 * projection rejects anything outside it as malformed.
 */
const LEGAL_LABELS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  CLASSIFIER_QUESTION_SET.map((axis) => [axis.id, new Set(axis.labels)]),
) as Record<string, ReadonlySet<string>>;

// ── Projection ──────────────────────────────────────────────────────────

/** The `ban` reading. */
export type BanReading = (typeof BAN_LABELS)[number];

/** The `effect` reading: the heaviest action the command's words describe. */
export type EffectReading = (typeof EFFECT_LABELS)[number];

/** The `target` reading: the kind of thing the action touches. */
export type TargetReading = (typeof TARGET_LABELS)[number];

/**
 * The `intent` reading: whether the trusted request named this action.
 * Absent when the record carries no trusted anchor — the verdict layer takes
 * the no-anchor column directly instead of asking the model.
 */
export type IntentReading = (typeof INTENT_LABELS)[number] | "absent";

/**
 * The projected answers every synthesis reads: the four choices plus the
 * confidence channel of every axis the policy gates on (the ban wall, the
 * effect action, and the intent word), calibrated onto one scale. Confidence
 * gates POSITIVE readings only: a negative reading (`none`, `ordinary work
 * declared`, the request's own word) is adopted whenever a confidence was
 * reported at all, because gating it would let confidence manufacture a
 * missing-evidence wall. Whether a confidence was REPORTED is presence, not
 * magnitude — an absent one marks the axis unresolved. A confidence below the
 * floor leaves the axis reading untrusted; a missing, NaN, or out-of-range
 * confidence reads as untrusted (0), never as trusted.
 */
export interface ClassifierAnswers {
  ban: BanReading;
  /**
   * Sanitized 0–1. Below the floor a `forbids` hit is NOT trusted as a
   * block (it routes to insufficient-info instead), so an uncertain ban can
   * never be silently dropped.
   */
  banConfidence: number;
  effect: EffectReading;
  /** Sanitized 0–1; below the floor the action reading is untrusted. */
  effectConfidence: number;
  target: TargetReading;
  /** The target kind carries no confidence — its labels ARE the readings. */
  intent: IntentReading;
  /**
   * Sanitized 0–1. Below the floor a `requested` reading is not trusted: an
   * uncertain request claim must not unlock the allow, so it routes to the
   * request's own column as `cannot_determine`. The `absent` intent carries
   * NaN — "the instrument did not report" is a different state from "the
   * instrument reported, weakly".
   */
  intentConfidence: number;
}

/**
 * The one classifier verdict threshold: the minimum confidence at which a
 * classifier reading is adopted (0–1, default 0.5). Below it that axis
 * takes its uncertainty path — the reading is not trustworthy enough to
 * adopt, not evidence-free. There is no intent or risk knob — the
 * four-axis policy consumes none.
 */
export interface ClassifierThresholds {
  confidenceThreshold: number;
}

/**
 * Thrown when a classifier response is missing a required reading or carries
 * a label outside the axis's declared set. The adapter's catch routes it to a
 * machinery defer (never allow) — a reviewer that did not answer, or answered
 * outside the contract, is broken, not uncertain.
 */
export class IncompleteClassifierResponseError extends Error {
  constructor(public readonly missing: string) {
    super(`incomplete classifier response: missing ${missing}`);
    this.name = "IncompleteClassifierResponseError";
  }
}

/**
 * Sanitize a choice confidence onto the 0–1 scale. Absent (the choice
 * primitive's confidence is optional), non-finite, or out-of-range values all
 * read as 0 — untrusted. The wrong direction is the dangerous one: a NaN or a
 * 1.5 must never count as a trusted hit.
 *
 * @param confidence - The raw confidence value.
 * @returns The sanitized confidence (0 when unusable).
 */
function sanitizeConfidence(confidence: unknown): number {
  // ABSENT is not the same state as unusable. A missing confidence means the
  // instrument did not report a measurement at all; the NaN sentinel carries
  // that to the synthesis, where the negative readings consult presence. Every
  // floor comparison is false for NaN, so on the POSITIVE axes it behaves
  // exactly like 0 (untrusted).
  if (confidence === undefined) return Number.NaN;
  return typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0
    ? confidence <= 1
      ? confidence
      : 0
    : 0;
}

/**
 * Project one choice answer from the wire record.
 *
 * @param raw - Pi-ai's typed answers by question id.
 * @param id - The axis id.
 * @returns The label and its sanitized confidence.
 */
function projectChoice(
  raw: Record<string, ClassifierAnswer>,
  id: ClassifierQuestionId,
): { label: string; confidence: number } {
  const answer = raw[id];
  if (answer?.type !== "choice" || typeof answer.choice !== "string") {
    throw new IncompleteClassifierResponseError(`${id}.choice`);
  }
  const legal = LEGAL_LABELS[id];
  if (!legal.has(answer.choice)) {
    throw new IncompleteClassifierResponseError(`${id}.choice="${answer.choice}"`);
  }
  return { label: answer.choice, confidence: sanitizeConfidence(answer.confidence) };
}

/**
 * Project pi-ai's typed answers into {@link ClassifierAnswers}.
 *
 * Readings are required: `ban`, `effect`, and `target` must be present as a
 * `choice` with a choice inside the axis's declared labels. `intent` is
 * required only when the record carries a trusted anchor — without one the
 * verdict layer takes the no-anchor column and the action is never asked.
 * A missing or out-of-contract reading throws
 * {@link IncompleteClassifierResponseError} — "never answered" or "answered
 * outside the menu" is a malformed response, not a reading. Confidence is
 * optional and sanitized: missing, NaN, or out-of-range reads as 0
 * (untrusted).
 *
 * @param raw - Pi-ai's typed answers by question id.
 * @param hasAnchor - Whether the record carries a trusted anchor.
 * @returns The calibrated answers.
 */
export function projectClassifierAnswers(
  raw: Record<string, ClassifierAnswer>,
  hasAnchor: boolean,
): ClassifierAnswers {
  const ban = projectChoice(raw, "ban");
  const effect = projectChoice(raw, "effect");
  const target = projectChoice(raw, "target");
  if (!hasAnchor) {
    return {
      ban: ban.label as ClassifierAnswers["ban"],
      banConfidence: ban.confidence,
      effect: effect.label as ClassifierAnswers["effect"],
      effectConfidence: effect.confidence,
      target: target.label as ClassifierAnswers["target"],
      intent: "absent",
      intentConfidence: Number.NaN,
    };
  }
  const intent = projectChoice(raw, "intent");
  return {
    ban: ban.label as ClassifierAnswers["ban"],
    banConfidence: ban.confidence,
    effect: effect.label as ClassifierAnswers["effect"],
    effectConfidence: effect.confidence,
    target: target.label as ClassifierAnswers["target"],
    intent: intent.label as ClassifierAnswers["intent"],
    intentConfidence: intent.confidence,
  };
}

// ── Decision rows ───────────────────────────────────────────────────────

/**
 * A decision row's outcome: the tier, the condition the row matched, and the
 * stable row id for audit and unit tests. Row ids are stable by contract:
 * renaming a row is a policy change, not a refactor.
 */
interface RowHit {
  tier: VerdictTier;
  rowId: string;
  /** True when an escalating fact lifted the tier — the lean follows the lift. */
  escalated?: boolean;
}

/**
 * The base tier from one action reading, in row order — the first matching
 * row wins. Every condition names a model label AND the code fact that must
 * corroborate it: a release row never fires on a label alone, because the
 * model mistaking a destructive or unknown program for `read`/`modify` must
 * not release. `named_build_output` sits before the unknown-scope block so a
 * regenerable cache deletion never asks.
 *
 * @param effect - The action reading (model or code-verb; see the dual-reader rule).
 * @param target - The target-kind reading.
 * @param facts - The deterministic facts.
 * @returns The tier and the row id.
 */
function baseTier(effect: EffectReading, target: TargetReading, facts: CommandFacts): RowHit {
  const credential =
    target === "credential_material" ||
    facts.sensitivePathName ||
    facts.secretVariable ||
    facts.headerToken;
  // Row 1: reading credential material exposes it into the transcript.
  if (credential && effect === "read") return { tier: "block", rowId: "read-credential" };
  // Row 2: publishing an artifact or dumping the environment is irreversible.
  if (facts.publishesArtifact || facts.dumpsEnvironment)
    return { tier: "block", rowId: "publish-or-dump" };
  // Row 3: modifying or sending credential material.
  if (credential && (effect === "modify" || effect === "send_out")) {
    return { tier: "guard", rowId: "modify-or-send-credential" };
  }
  if (effect === "delete") {
    // Row 4: a regenerable build-output deletion — before the unknown-scope
    // block, so the `~/.cache/<subdirectory>` exception never asks.
    if (facts.namedBuildOutput) return { tier: "free", rowId: "build-output-delete" };
    // Row 5: a deletion the record cannot scope is unratable.
    if (facts.pathScope === "unknown") return { tier: "block", rowId: "unscoped-delete" };
    // Row 6: a recursive deletion outside the workspace.
    if (facts.recursive && facts.pathScope === "outside") {
      return { tier: "block", rowId: "recursive-outside-delete" };
    }
    // Row 7: any other deletion.
    return { tier: "guard", rowId: "other-delete" };
  }
  if (effect === "read") {
    // Row 8: a restricted-network read leaves the machine.
    if (facts.network === "restricted") return { tier: "guard", rowId: "restricted-read" };
    // Row 9: a public system path the code recognizes.
    if (facts.publicSystemPath) return { tier: "free", rowId: "public-system-read" };
    // Row 9a: a read outside the workspace always asks (never Row 10
    // free), even when the target reads as `none`. A named request still
    // releases it — the question is where, not whether.
    if (facts.pathScope === "outside" || facts.pathScope === "unknown") {
      return { tier: "guard", rowId: "outside-read" };
    }
    // Row 10: any other read.
    return { tier: "free", rowId: "other-read" };
  }
  // Row 11: a raw device copy.
  if (facts.rawCopy) return { tier: "guard", rowId: "raw-copy" };
  if (
    effect === "modify" &&
    (target === "ordinary_files" || target === "none") &&
    (facts.pathScope === "inside" || facts.pathScope === "none" || facts.pathScope === "scratch")
  ) {
    // Row 12: a workspace modification of ordinary files. The scope gate
    // stays as specified: a routine command naming paths outside the
    // workspace (`make -C /tmp`) never normalizes here — it falls to row
    // 14. A pathless runner (`cargo test`) reads scope `none` and releases
    // here on the routine gate's evidence.
    return { tier: "plain", rowId: "workspace-modify" };
  }
  // A history rewrite the record cannot scope is unratable — but a rewrite
  // the record scopes inside the workspace (a feature-branch amend) is an
  // ordinary VCS write, not an unscoped destruction.
  if (
    effect === "modify" &&
    target === "vcs_history" &&
    !facts.rewritesHistory &&
    (facts.pathScope === "inside" || facts.pathScope === "none" || facts.pathScope === "scratch")
  ) {
    // Row 13: a history-preserving VCS write inside the workspace.
    return { tier: "plain", rowId: "vcs-write" };
  }
  // Row 14: everything else — sending, running a program, modifying a system
  // or service, rewriting history, writing outside the workspace.
  return { tier: "guard", rowId: "other" };
}

/**
 * The verdict tier from a model action reading and the deterministic facts.
 * The base tier runs twice — once on the model's `effect`, once on the code
 * verb table's `commandEffect` (`unknown` reads as `run_program`) — and the
 * stricter tier wins. The model's reading therefore only ever tightens, never
 * loosens: mistaking a destructive or unknown program for `read`/`modify`
 * cannot release. A routine project command normalizes first: its
 * `run_program` runs as `modify` through the base tier (the workspace-scope
 * gate still applies), because running the project's own code executes
 * content the record cannot show — it releases as `plain`, never `free`.
 *
 * Escalating facts then lift any non-`block` tier to at least `guard`:
 * serving on all interfaces, installing persistence, sending data, or
 * rewriting history.
 *
 * @param effect - The model's action reading.
 * @param target - The model's target-kind reading.
 * @param facts - The deterministic facts.
 * @returns The tier and the row id of the winning read.
 */
function tierOf(effect: EffectReading, target: TargetReading, facts: CommandFacts): RowHit {
  const normalized: EffectReading =
    facts.routineDevCommand && (effect === "run_program" || effect === "read") ? "modify" : effect;
  // The code-verb reader normalizes the same way: an unknown program the
  // routine gate vouches for runs as a modification, not as an unknown.
  // Without this the dual reader would keep the stricter `guard` from the
  // code side and the normalization would never release.
  const codeReading: EffectReading =
    facts.routineDevCommand && (facts.commandEffect === "unknown" || facts.commandEffect === "read")
      ? "modify"
      : facts.commandEffect === "unknown"
        ? "run_program"
        : facts.commandEffect;
  // The strictest reader wins on the tier, but the row id follows the MODEL
  // reading whenever it already reaches that tier: the audit trail names
  // what the model saw, not the corroborating code verb.
  const fromModel = baseTier(normalized, target, facts);
  const fromCode = baseTier(codeReading, target, facts);
  const base = TIER_RANK[fromModel.tier] > TIER_RANK[fromCode.tier] ? fromModel : fromCode;
  if (base.tier === "block") return base;
  if (
    facts.allInterfaces ||
    facts.installsPersistence ||
    facts.sendsData ||
    facts.authHeaderExpansion ||
    facts.rewritesHistory ||
    // Widening a sensitive object's access class is the protection-weakening
    // shape. The conjunction is deliberate: `chmod +x build.sh` grants beyond
    // the owner too, and escalating every script bit would be noise.
    (facts.grantsBeyondOwner && facts.sensitivePathName)
  ) {
    // The escalator lifts the tier, never the request's word: a history
    // rewrite behind a named request still asks. The lean follows the
    // ESCALATED tier (deny), not the base row's — the escalating fact is
    // the reason silence must not release.
    return { tier: "guard", rowId: `${base.rowId}+escalated`, escalated: true };
  }
  return base;
}

// ── Synthesis ───────────────────────────────────────────────────────────

/**
 * The synthesis input: calibrated answers, deterministic facts, and whether
 * the record carries a trusted anchor.
 */
export interface ClassifierVerdictInput {
  answers: ClassifierAnswers;
  facts: CommandFacts;
  hasAnchor: boolean;
}

/**
 * The synthesis output: the outcome plus the decision row that produced it.
 * `rowId` names the row (`ban-forbids`, `ban-unestablished`,
 * `effect-unresolved`, `intent-unresolved`, or the tier row id) for audit
 * and unit tests.
 */
export interface ClassifierVerdict {
  outcome: ReviewOutcome;
  rowId: string;
}

/**
 * Synthesize a {@link ReviewOutcome} from calibrated answers and
 * deterministic facts, without reading any mode. The authorization table
 * adjusts the tier afterwards; the mode projection maps the verdict later.
 * A deny here is the model's judgment and maps soft; only the deterministic
 * screen hard-denies. `riskLevel` is an audit-only label — it is set after
 * the disposition is decided and never picks the disposition's deny
 * strength.
 *
 * Three-valued evaluation: a row fires only when its condition is
 * positively established, skips when positively unmet, and defers neutral
 * when a needed answer is missing confidence or reads `cannot_determine`.
 * Dangerous rows 1–3 treat an unmet condition as a hit — a credential,
 * publish, or dump the record cannot rule out is never released by a
 * negative inference.
 *
 * In order:
 *
 * 1. `ban=forbids` (trusted) → deny. An untrusted `forbids` is never benign: it falls through to
 *    insufficient-info.
 * 2. `ban=unestablished` → insufficient-info (defer, deny lean): the record may hold a prohibition.
 * 3. `effect=cannot_determine` → neutral defer: the command cannot be read.
 * 4. The base tier (dual-reader, stricter wins), adjusted by the authorization table: `free` allows;
 *    `plain` allows on `requested` and asks leaning allow otherwise; `guard` allows on `requested`
 *    and asks leaning deny otherwise; `block` asks leaning deny either way. An untrusted
 *    `requested` reads as `cannot_determine`.
 *
 * @param input - The calibrated answers, facts, and anchor presence.
 * @param thresholds - The adoption threshold (the confidence floor).
 * @param latencyMs - The call latency for the audit record.
 * @returns The outcome and the row id.
 */
export function decideClassifierVerdict(
  input: ClassifierVerdictInput,
  thresholds: ClassifierThresholds,
  latencyMs: number,
): ClassifierVerdict {
  const { answers, facts, hasAnchor } = input;
  const banTrusted = atOrAboveFloor(answers.banConfidence, thresholds.confidenceThreshold);
  const effectTrusted = atOrAboveFloor(answers.effectConfidence, thresholds.confidenceThreshold);
  const intentTrusted = atOrAboveFloor(answers.intentConfidence, thresholds.confidenceThreshold);
  const deny = (reason: string, rowId: string): ClassifierVerdict => ({
    outcome: { verdict: { kind: "deny", reason }, latencyMs, riskLevel: "critical" },
    rowId,
  });
  const denyLeanDefer = (
    reason: string,
    rowId: string,
    riskLevel: RiskLevel,
  ): ClassifierVerdict => ({
    outcome: {
      verdict: { kind: "defer" },
      deferKind: MODEL_DEFER_KIND,
      deferReason: reason,
      lean: "deny",
      latencyMs,
      riskLevel,
    },
    rowId,
  });
  const neutralDefer = (reason: string, rowId: string): ClassifierVerdict => ({
    outcome: {
      verdict: { kind: "defer" },
      deferKind: MODEL_DEFER_KIND,
      deferReason: reason,
      latencyMs,
    },
    rowId,
  });

  // 1. The ban wall — it runs before any unresolved reading. An UNTRUSTED
  //    `forbids` hit is not a block (a guessing model must not deny
  //    outright) but it is never benign either: it falls through to the
  //    insufficient-info row below.
  if (answers.ban === "forbids" && banTrusted) {
    return deny(classifierBanReason(), "ban-forbids");
  }

  // 2. An unresolved ban means the record may hold a prohibition.
  if (answers.ban === "unestablished" || (answers.ban === "forbids" && !banTrusted)) {
    return denyLeanDefer(classifierInsufficientInfoReason("ban"), "ban-unestablished", "high");
  }

  // 3. An unreadable command cannot be rated. An untrusted positive action
  //    reading joins it: a guess about what the command does is not evidence.
  if (answers.effect === "cannot_determine" || !effectTrusted) {
    return neutralDefer(classifierInsufficientInfoReason("effect"), "effect-unresolved");
  }

  const hit = tierOf(answers.effect, answers.target, facts);
  const { tier, rowId, escalated } = hit;
  const requested = hasAnchor && answers.intent === "requested" && intentTrusted;
  const intentUnresolved = hasAnchor && (answers.intent === "cannot_determine" || !intentTrusted);

  if (tier === "free") return { outcome: { verdict: { kind: "allow" }, latencyMs }, rowId };
  if (tier === "block") {
    return denyLeanDefer(classifierIntentGapReason(), rowId, "critical");
  }
  // The authorization table. `free` and `block` never reach it. A trusted
  // `requested` releases `plain` and `guard` alike — UNLESS an escalating
  // fact lifted the tier: a history rewrite, an interface bind, a send
  // shape, or installed persistence behind a named request still asks. The
  // request names the action; the escalating fact is the reason the named
  // action still needs a human.
  if (requested && !escalated) return { outcome: { verdict: { kind: "allow" }, latencyMs }, rowId };
  if (tier === "plain" && !escalated) {
    return {
      outcome: {
        verdict: { kind: "defer" },
        deferKind: MODEL_DEFER_KIND,
        deferReason: intentUnresolved ? classifierNeutralAskReason() : classifierIntentGapReason(),
        lean: "allow",
        latencyMs,
      },
      rowId,
    };
  }
  return {
    outcome: {
      verdict: { kind: "defer" },
      deferKind: MODEL_DEFER_KIND,
      deferReason: intentUnresolved ? classifierNeutralAskReason() : classifierIntentGapReason(),
      // A plain row asks leaning allow; an escalated row asks leaning deny
      // (the escalator already decided silence must not release).
      lean: tier === "plain" && !escalated ? "allow" : "deny",
      latencyMs,
    },
    rowId,
  };
}

/**
 * Synthesize a verdict from the classifier's answers and the deterministic
 * facts. A deny here is the model's judgment and maps soft; see
 * {@link decideClassifierVerdict}.
 *
 * @param answers - The calibrated answers.
 * @param facts - The deterministic facts.
 * @param hasAnchor - Whether the record carries a trusted anchor.
 * @param thresholds - The calibrated confidence floor.
 * @param latencyMs - Model call latency for the audit record.
 * @returns The outcome and the row id.
 */
export function synthesizeClassifierVerdict(
  answers: ClassifierAnswers,
  facts: CommandFacts | null,
  hasAnchor: boolean,
  thresholds: ClassifierThresholds,
  latencyMs: number,
): ClassifierVerdict {
  // Missing facts mean the command could not be read at all — not even to
  // scope it. The only honest reading is the one the record cannot rate:
  // a neutral defer on the effect axis, whatever the model claimed.
  if (facts === null) {
    return {
      outcome: {
        verdict: { kind: "defer" },
        deferKind: MODEL_DEFER_KIND,
        deferReason: classifierInsufficientInfoReason("effect"),
        latencyMs,
      },
      rowId: "effect-unresolved",
    };
  }
  return decideClassifierVerdict({ answers, facts, hasAnchor }, thresholds, latencyMs);
}
