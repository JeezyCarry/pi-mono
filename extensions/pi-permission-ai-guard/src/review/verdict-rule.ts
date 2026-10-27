/**
 * The mode mapping rule: how the link disposes the reviewer's non-allow
 * verdicts. Deciding only — the human-facing copy lives in verdict-copy.
 *
 * This module owns the verdict-bearing side of the leniency ladder — the
 * hard/soft deny tiers, the soft-deny/model-defer/machinery application.
 * The ladder's geometry lives in {@link ../config/suspicion.ts}; the
 * effective policy (built-in row or resolved custom pair) arrives as a
 * {@link ../config/mode-policy.ts!ModePolicy} — this module never indexes
 * the table by a mode name.
 *
 * The doctrine stays local: a hard-tier deny (only the deterministic screen's) is
 * terminal in every mode, and every model deny is soft, so the ladder maps it like
 * any other doubt; danger-leaned defers ask in `default` and deny in `strict` and
 * `auto` (neither has an ask path for danger); reviewer machinery failures never map
 * to allow in any mode (a broken reviewer must not rubber-stamp) — they deny under
 * `strict` and `auto` and defer under `default`; allow is never transformed.
 *
 * Pure functions: the fresh-model path and the cache-hit path both run
 * the mapping, so a cached verdict maps identically to a fresh one.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { Mode } from "#src/config/config-schema.ts";
import type { ModePolicy } from "#src/config/mode-policy.ts";
import { type Suspicion, suspicionBand } from "#src/config/suspicion.ts";
import { isModelDefer } from "#src/model/machinery-kinds.ts";
import { GENERIC_DENY_REASON } from "#src/model/model-verdict.ts";
import type { ModelCallDeferKind, RiskLevel, VerdictLean } from "#src/model/model-verdict.ts";

import {
  escalationMessage,
  failOpenNotice,
  machineryDenyReason,
  machineryDeferNotice,
  uncertainDenyReason,
  withAgentInstruction,
  type DenyInstructionSource,
} from "./verdict-copy.ts";

/**
 * Extra context for a model defer verdict (fresh-path only — defers are
 * never cached, so the cache-hit path has none of this).
 */
export interface ModelDeferInfo {
  /**
   * Classified defer kind; `model-defer` is the model's own uncertainty, the rest are machinery
   * failures.
   */
  kind?: ModelCallDeferKind;
  /** The model's defer reason: the gap, then the ask. */
  reason?: string;
  /**
   * The reviewer's directional inclination on a model defer — which way it
   * would decide if forced. Undefined means neutral. Selects the defer
   * lane; never surfaced to the human (anti-anchoring invariant).
   */
  lean?: VerdictLean;
}

/**
 * Who issued a deny. Authority, not the model's self-reported severity,
 * decides the tier: a model can misread a command, so its deny never binds
 * a human who can see the command; only the deterministic screen binds.
 */
export type DenyAuthority = "screen" | "model";

/**
 * Audit marker for a model defer the mode mapped to allow: the reviewer's
 * clarification request never reached the agent. Persisted as the decision
 * record's emittedReason so readers of the review log see what was
 * swallowed.
 */
export const CLARIFICATION_SUPPRESSED_REASON = "clarification-suppressed";

/**
 * Apply the configured mode to a model verdict.
 *
 * @param policy - The effective mode policy (mode name plus its cut lines).
 * @param verdict - The model's (or cached) verdict.
 * @param modelDefer - Deferred-call context when the verdict is a fresh model defer.
 * @param authority - Who issued a deny verdict (default: the model).
 * @returns The verdict the link emits.
 */
export function applyVerdictMode(
  policy: ModePolicy,
  verdict: AuthorizerVerdict,
  modelDefer?: ModelDeferInfo,
  authority: DenyAuthority = "model",
): AuthorizerVerdict {
  if (verdict.kind === "allow") {
    return verdict;
  }
  // The deterministic screen's deny is terminal in every mode: it never
  // enters the ladder, so no pair of cut lines — built-in or custom — can
  // lift it (ADR 0006). Only the screen issues hard-tier denies.
  if (authority === "screen") {
    return verdict;
  }
  // Machinery failures are their own axis (a failure to obtain a verdict),
  // never on the suspicion line — map through the mode's machinery lane,
  // which never allows: a broken reviewer must not rubber-stamp.
  if (verdict.kind === "defer" && !isModelDefer(modelDefer?.kind)) {
    return policy.onReviewFailure === "deny"
      ? { kind: "deny", reason: machineryDenyReason(modelDefer?.kind, policy.mode) }
      : verdict;
  }
  // Everything else sits on the suspicion line: a deny is soft (the hard rung
  // returned above — only the screen sits there), a model defer by its lean.
  // The lean is the reviewer's directional inclination, an audit-and-routing
  // fact: it selects the defer lane, never surfaces to the human, and a
  // deny-leaned defer can at best ask (never allow).
  const suspicion: Suspicion =
    verdict.kind === "deny"
      ? "soft-deny"
      : modelDefer?.lean === "allow"
        ? "defer-benign"
        : modelDefer?.lean === "deny"
          ? "defer-danger"
          : "defer-neutral";
  const band = suspicionBand(policy.cuts, suspicion);
  if (band === "allow") {
    return { kind: "allow" };
  }
  if (band === "deny") {
    // A deny keeps its teaching reason; a rejected defer synthesizes one
    // (the model's clarification request, or the generic uncertainty copy).
    return verdict.kind === "deny"
      ? verdict
      : { kind: "deny", reason: modelDefer?.reason ?? uncertainDenyReason(policy.mode) };
  }
  // The ask band: a defer passes through; a softened deny becomes a defer.
  return verdict.kind === "defer" ? verdict : { kind: "defer" };
}

/** The operator notice a mapping decision owes, rendered and leveled. */
export interface MappingNotice {
  message: string;
  level: "info" | "warning";
}

/**
 * What the disposition owes after the mode maps a verdict: the verdict the
 * agent receives, the decision record's annotation input, and the operator
 * notice. Pure — the once-per-pipeline fail-open notice state is READ as an
 * input and returned as a {@link MappingDecision.markNoticeShown} signal; the
 * caller performs the mutation.
 */
export interface MappingDecision {
  /**
   * The verdict the agent receives. A deny carries its agent instruction
   * (machinery vs content) — the same rule that picked the deny's reason
   * attaches the instruction, so no caller can drop it.
   */
  verdict: AuthorizerVerdict;
  /**
   * The `emittedReason` for the decision record's mapping annotation: deny→allow
   * keeps the swallowed deny reason; defer→allow marks the swallowed
   * clarification; →deny records the synthesized teaching reason the agent DID get
   * (never a "suppressed" marker, nothing was suppressed on the way to a deny).
   * Undefined when the mapping introduced none.
   */
  emittedReason?: string;
  /**
   * Whether the emitted kind differs from the original — the record
   * needs the `mapped()` annotation ({@link DecisionRecord.mapped}).
   */
  annotate: boolean;
  /**
   * The operator notice this disposition owes, rendered and leveled; null when
   * silent. Five kinds: a model deny that HOLDS or escalates (the host renders no
   * dialog for denials, so the notify line is the operator's only copy), a mapped
   * defer (the ask tail corrects the operator's read), the once-per-pipeline
   * fail-open notice (the mode allowing against the model's explicit verdict
   * or its neutral uncertainty), a model defer that emitted as defer (its reason,
   * which no dialog would show), and a machinery defer that emitted as defer (the
   * cause notice).
   */
  notice: MappingNotice | null;
  /**
   * Whether this decision consumes the once-per-pipeline fail-open
   * notice state (the caller flips its `shown` flag).
   */
  markNoticeShown: boolean;
}

/**
 * The per-ask mapping context resolveMapping decides on: the verdicts
 * (original vs emitted), the risk/defer classification, the lean, the
 * mode, and the once-per-pipeline notice state.
 */
interface MappingInput {
  /** The model's (or cached) verdict. */
  original: AuthorizerVerdict;
  /** The verdict the mode mapping emitted. */
  emitted: AuthorizerVerdict;
  /** The model's risk assessment (escalation copy). */
  riskLevel: RiskLevel | undefined;
  /**
   * The fresh review's defer classification (kind + clarification
   * request) when the original is a defer; undefined on the cache-hit
   * path (defers are never stored — a cached original is allow/deny
   * only) and when the original is not a defer.
   */
  deferKind: ModelCallDeferKind | undefined;
  /** The model's clarification request on its own defer, if any. */
  deferReason: string | undefined;
  /** The reviewer's lean on a fresh model defer. */
  deferLean: VerdictLean | undefined;
  /** The effective mode (names the policy in the fail-open copy). */
  mode: Mode;
  /** Whether the once-per-pipeline fail-open notice already fired. */
  noticeShown: boolean;
}

/**
 * The mapping's consequence resolver — the deciding rule as one pure
 * function: given
 * the original verdict, the emitted verdict, and the per-ask context
 * (risk level, defer classification, lean, mode, notice state), it
 * decides the record annotation, every notify the disposition owes, and
 * the agent instruction's source. The pipeline calls it and performs
 * the side effects; the rule itself is testable in one place.
 *
 * The input is an object because `original` and `emitted` are adjacent
 * same-typed parameters — positional calls could swap them silently; the
 * lean:allow exemption note (a benign-leaned pass rides the model's own
 * inclination — silent; the fail-open notice belongs to the mode going
 * AGAINST the model) lives in the field docs above.
 *
 * @param input - The per-ask mapping context, field-documented on
 *   {@link MappingInput}.
 * @returns The record-annotation, notify, and instruction-source decision.
 */
export function resolveMapping(input: MappingInput): MappingDecision {
  const { original, emitted, riskLevel, deferKind, deferReason, deferLean, noticeShown } = input;
  // The agent instruction's source: machinery iff what was denied is a
  // machinery defer (the review failed — retry-later copy); content
  // otherwise (the request itself was judged — stop-pursuing copy). One
  // rule, stated once: an unclassified defer counts as machinery here
  // exactly as it does in the lane table above, and the cache-hit path
  // derives "content" from the same rule structurally (a cached original
  // is allow/deny only, so the machinery branch is unreachable by type,
  // not by comment). Applied only where a deny is emitted — the verdict
  // carries the instruction, so no caller can drop it.
  const instructionSource: DenyInstructionSource =
    original.kind === "defer" && !isModelDefer(deferKind) ? "machinery" : "content";
  // A defer that emitted as defer owes a notice: the model's reason (the dialog
  // alone would never show what it could not establish), or the machinery cause (a
  // forced defer must name its failure kind, same doctrine as the pre-call gates).
  // The model's reason is the whole line: a prefix would add a second separator to
  // the host's own. A terse defer without a reason stays silent by design.
  const deferNotice: MappingNotice | null =
    emitted.kind === "defer" && original.kind === "defer"
      ? isModelDefer(deferKind) && deferReason
        ? {
            message: deferReason,
            level: "info",
          }
        : deferKind !== undefined && !isModelDefer(deferKind)
          ? { message: machineryDeferNotice(deferKind), level: "warning" }
          : null
      : null;
  if (emitted.kind === original.kind) {
    // The verdict held. The host renders no dialog for a deny, so the notify line
    // is the only human-visible copy, in every mode and tier. A reason-less deny
    // (the parser synthesizes one; a future producer might not) takes the generic
    // reason rather than falling through to the defer notice, which renders
    // nothing. A defer that holds still owes its own notice (the machinery cause,
    // or the model's reason).
    if (emitted.kind === "deny" && original.kind === "deny") {
      // Held deny: the released verdict carries `emitted.reason` (what the mode
      // actually emitted); `original` supplies the escalation copy. The outer
      // kind-equality guard makes `emitted.kind === "deny"` the only case here.
      const denied = original.reason ? original : { ...original, reason: GENERIC_DENY_REASON };
      return {
        annotate: false,
        notice: { message: escalationMessage(denied, riskLevel, "denied"), level: "warning" },
        verdict: {
          kind: "deny",
          reason: withAgentInstruction(emitted.reason, instructionSource),
        },
        markNoticeShown: false,
      };
    }
    return {
      annotate: false,
      notice: deferNotice,
      verdict: emitted,
      markNoticeShown: false,
    };
  }
  // The mapping changed the emitted kind: the record gets the mapping
  // annotation, and the emittedReason tells audit readers what the agent
  // actually received.
  const emittedReason =
    emitted.kind === "allow"
      ? original.kind === "defer"
        ? CLARIFICATION_SUPPRESSED_REASON
        : original.kind === "deny"
          ? original.reason
          : undefined
      : emitted.kind === "deny"
        ? emitted.reason
        : undefined;
  // The changed-kind branch never owes a defer notice: deferNotice needs emitted
  // AND original to both be defers, which a changed kind excludes by definition.
  let notice: MappingDecision["notice"] = null;
  let markNoticeShown = false;
  if (emitted.kind === "defer") {
    // A mode-softened deny becomes the human's decision — the tail
    // corrects the operator's read (the request was NOT denied; a dialog
    // is coming).
    notice = { message: escalationMessage(original, riskLevel, "asked"), level: "warning" };
  } else if (emitted.kind === "allow" && deferLean !== "allow" && !noticeShown) {
    // The fail-open notice: the mode passed something against the
    // model's stance — a swallowed deny, or auto-passed NEUTRAL
    // uncertainty. A benign-leaned pass is excluded (the reviewer saying
    // "I would allow this", confirmed — allows never notify). Once per
    // pipeline: the first occurrence teaches, the rest stay quiet.
    markNoticeShown = true;
    notice = { message: failOpenNotice(), level: "warning" };
  }
  const verdict: AuthorizerVerdict =
    emitted.kind === "deny"
      ? { kind: "deny", reason: withAgentInstruction(emitted.reason, instructionSource) }
      : emitted;
  return { annotate: true, emittedReason, notice, verdict, markNoticeShown };
}
