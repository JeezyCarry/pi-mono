/**
 * Disposition: the single release seam for every gate that emits a verdict.
 *
 * Each verdict-bearing gate decides a verdict; releasing it — writing the
 * audit record, sending the operator notice, attaching the agent
 * instruction — lives here, once. One pipeline instance holds one release
 * seam, so the once-per-pipeline fail-open notice state is a private
 * detail of the implementation, not a caller's read-modify-write. This
 * module owns both release shapes (the pass-through gates — policy,
 * surface-unmatched — and the breaker's own trip ritual stay outside by
 * design):
 *
 * - `releaseMachineryGate` — the four reviewer-failure gates that never hold a parsed verdict
 *   (no-target, model-unresolved, transcript-error, auth-failed). Owns the machinery lane lookup,
 *   the deny reason (computed ONCE — the audit annotation and the returned verdict share it), the
 *   breaker's recoverable-tier credit, the review-stream record (mapped when the gate denies, plain
 *   when it defers), the forced-defer notice, and the returned verdict.
 * - `releaseVerdictGate` — the two gates that emit a real verdict (cache-hit and fresh model). Owns
 *   the mapping decision's side effects: the fail-open notice state, the operator notice, the
 *   `mapped()` record annotation, and the returned verdict (a deny already carries its agent
 *   instruction — {@link resolveMapping} attaches it).
 *
 * The pure deciding rules stay where they are (`resolveMapping` /
 * `machineryTarget` in verdict-rule): this module performs, it does not
 * decide. Gates declare verdict + facts; the ritual lives here.
 */

import type { AuthorizerLog, AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import { type DecisionRecordEntry, mapped } from "#src/audit/decision-record.ts";
import { DECISION_EVENT } from "#src/audit/events.ts";
import type { Mode } from "#src/config/config-schema.ts";
import type { PreCallMachineryKind } from "#src/model/machinery-kinds.ts";
import type { RiskLevel } from "#src/model/model-verdict.ts";
import type { NotifyFn } from "#src/notice.ts";
import { isBoundedDelegationSurface } from "#src/review/request/ask.ts";

import { type CircuitBreaker } from "./circuit-breaker.ts";
import {
  approvalNotice,
  machineryDenyReason,
  machineryDeferNotice,
  type ReviewCost,
  withAgentInstruction,
} from "./verdict-copy.ts";
import { machineryTarget, type ModelDeferInfo, resolveMapping } from "./verdict-rule.ts";

/**
 * What a verdict release hands back to its gate: the record to write, and
 * the verdict to return. The gate writes the record to its own stream
 * (review vs debug) — the stream choice is the gate's one remaining fact.
 */
export interface VerdictRelease {
  /** The annotated (or plain) decision record. */
  record: DecisionRecordEntry;
  verdict: AuthorizerVerdict;
}

/**
 * A pre-call machinery gate's facts: the four reviewer-failure gates that
 * never hold a parsed verdict (no-target, model-unresolved,
 * transcript-error, auth-failed).
 */
export interface MachineryGate {
  /** The effective mode (the machinery lane's only input). */
  mode: Mode;
  /** The classified machinery failure (pre-call: the review never opened). */
  kind: PreCallMachineryKind;
  /** The gate's decision record (verdict "defer" — the review never opened). */
  record: DecisionRecordEntry;
  /** The session circuit breaker (recoverable-tier credit). */
  breaker: CircuitBreaker;
  /** The authorizer log pair (review stream). */
  log: AuthorizerLog;
}

/**
 * A verdict-bearing gate's facts: the two gates that emit a real verdict
 * (cache-hit and fresh model).
 */
export interface VerdictGate {
  /** The effective mode (the mapping's policy input). */
  mode: Mode;
  /** The gate's decision record (un-annotated). */
  record: DecisionRecordEntry;
  /** The reviewer's verdict (model or cached). */
  original: AuthorizerVerdict;
  emitted: AuthorizerVerdict;
  riskLevel: RiskLevel | undefined;
  /**
   * The fresh review's defer context (undefined on the cache-hit path —
   * defers are never stored — and when the original is not a defer).
   */
  defer: ModelDeferInfo | undefined;
  /** The review's cost for the approval tail (fresh latency or cached replay). */
  cost: ReviewCost;
}

/**
 * The release seam's per-pipeline configuration: the notify it sends every
 * notice through, and whether emitted allows are announced.
 */
export interface DispositionDeps {
  notify: NotifyFn;
  /** Whether to announce emitted allows; ambient notifyLevel still applies. */
  notifyApprovals: boolean;
}

/** The release seam for one pipeline instance. */
export interface Disposition {
  /**
   * Release a pre-call machinery gate. The shared invariants — a broken
   * reviewer never rubber-stamps, every reviewer-relevant gate writes the
   * review stream — live behind this method.
   *
   * @param gate - The machinery gate's facts.
   * @returns The verdict the gate emits.
   */
  releaseMachineryGate(gate: MachineryGate): AuthorizerVerdict;
  /**
   * Release a verdict-bearing gate.
   *
   * @param gate - The verdict gate's facts.
   * @returns The record to write and the verdict to return.
   */
  releaseVerdictGate(gate: VerdictGate): VerdictRelease;
}

/**
 * Create the release seam for one pipeline instance. The fail-open notice
 * state fires on the first mapped allow, then stays silent.
 *
 * @param deps - The per-pipeline notify and approval flag.
 * @returns The release seam.
 */
export function createDisposition(deps: DispositionDeps): Disposition {
  let noticeShown = false;

  return {
    releaseMachineryGate({ mode, kind, record, breaker, log }) {
      if (machineryTarget(mode) !== "deny") {
        log.review(DECISION_EVENT, record);
        // Forced defer interrupts the human with no dialog context of its
        // own — same doctrine as the breaker trip: name the cause.
        deps.notify(machineryDeferNotice(kind), "warning");
        return { kind: "defer" };
      }
      breaker.recordDenyEquivalent();
      const reason = machineryDenyReason(kind, mode);
      log.review(DECISION_EVENT, mapped(record, mode, "deny", reason));
      // The audit annotation keeps the un-instructed reason; the returned
      // verdict carries the agent instruction (a machinery denial was never
      // judged — retrying later is legitimate).
      return { kind: "deny", reason: withAgentInstruction(reason, "machinery") };
    },

    releaseVerdictGate({ mode, record, original, emitted, riskLevel, defer, cost }) {
      const decision = resolveMapping({
        original,
        emitted,
        riskLevel,
        deferKind: defer?.kind,
        deferReason: defer?.reason,
        deferLean: defer?.lean,
        mode,
        noticeShown,
      });
      if (decision.notice) deps.notify(decision.notice.message, decision.notice.level);
      // Only this gate emits reviewer-backed allows (fresh or cached). The host
      // caps path/external-directory allows to defer, so those are not approvals.
      // Never echo the target: commands may contain secrets or control text.
      if (
        deps.notifyApprovals &&
        emitted.kind === "allow" &&
        record.surface &&
        !isBoundedDelegationSurface(record.surface)
      ) {
        deps.notify(
          approvalNotice(
            original.kind === "allow" ? { kind: "reviewer" } : { kind: "mode", mode },
            cost,
          ),
          "info",
        );
      }
      if (decision.markNoticeShown) noticeShown = true;
      return {
        record: decision.annotate
          ? mapped(record, mode, emitted.kind, decision.emittedReason)
          : record,
        verdict: decision.verdict,
      };
    },
  };
}
