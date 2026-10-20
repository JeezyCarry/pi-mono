/**
 * Classifier lane adapter: one registry classifier attempt behind the pool's
 * three-state seam. Owns the classify call, answer projection, verdict
 * synthesis, and the terminalize closure — the raw error never leaves this
 * module.
 *
 * Availability table is shared with the chat lane (failover switches
 * backends; it is not same-backend retry): quota/payment limits, vanished
 * models (404/410), conflicts (409), rate limits (429), timeouts,
 * connection failures, and server errors switch. Auth/policy refusals
 * and malformed requests are terminal defers for the operator.
 */

import { emitCallFailure } from "#src/audit/call-failure.ts";
import { MODEL_ANSWERS_EVENT } from "#src/audit/events.ts";
import type { AiGuardConfig } from "#src/config/config-schema.ts";
import type { ReviewOutcome } from "#src/model/model-verdict.ts";
import { classifyBackendError } from "#src/review/failure-taxonomy.ts";
import type {
  AttemptResult,
  AttemptSpec,
  ClassifierPoolEndpoint,
  LaneAdapter,
  PoolEndpoint,
} from "#src/review/pool.ts";
import type { EngineCallContext, EngineReviewResult } from "#src/review/reviewer-engine.ts";
import { errorClassName } from "#src/utils.ts";

import {
  type ClassifierClientAccessor,
  type ClassifierClientLike,
  buildClassifierRequest,
} from "./client.ts";
import type { ClassifierOverlay } from "./instructions.ts";
import { projectClassifierAnswers, synthesizeClassifierVerdict } from "./verdict.ts";

export interface ClassifierAdapterDeps {
  /** The classifier-scoped config slice (thresholds + resolved instructions). */
  config: {
    classifier: AiGuardConfig["classifier"];
    instructions: ClassifierOverlay;
    /**
     * Sampling temperature for the classifier call. `undefined` omits the
     * field, so the backend default applies. TypeSafe ignores it (its
     * protocol carries no sampling knob); backends that do apply it
     * (llama-cpp scales the label softmax) read it from this slot.
     */
    temperature: number | undefined;
  };
  /**
   * Client seam for a classifier endpoint. Production passes the accessor
   * prebuilt at registration, so per-ask resolution never throws here.
   */
  registryClient?: ClassifierClientAccessor;
  /** Injected clock (tests only). */
  now?: () => number;
}

/**
 * Create the classifier lane adapter.
 *
 * @param deps - The classifier-scoped config slice and client factory.
 * @returns A `LaneAdapter` attempting one classifier endpoint per call.
 */
export function createClassifierAdapter(deps: ClassifierAdapterDeps): LaneAdapter {
  const { config } = deps;
  const { classifier } = config;
  const now = deps.now ?? Date.now;
  const clientFor = (endpoint: ClassifierPoolEndpoint): ClassifierClientLike => {
    const facade = deps.registryClient;
    if (!facade) throw new Error("classifier adapter received an endpoint without a facade");
    return facade(endpoint);
  };

  return {
    async attempt(
      endpoint: PoolEndpoint,
      ctx: EngineCallContext,
      spec: AttemptSpec,
    ): Promise<AttemptResult> {
      if (endpoint.lane !== "classifier")
        throw new Error("classifier adapter received a chat endpoint");
      const { hasFailover, attemptTimeoutMs, walkRemainingMs } = spec;
      const modelId = endpoint.id;
      const startedAt = now();
      try {
        const response = await clientFor(endpoint).classify(
          buildClassifierRequest(ctx.transcript, ctx.request, config.instructions),
          {
            timeoutMs: attemptTimeoutMs,
            // Transport retries each get a fresh budget, so only a signal
            // bounds their sum: without it a single-endpoint walk (which
            // keeps those retries) could outlive the budget the pool
            // advertises.
            signal: AbortSignal.timeout(walkRemainingMs),
            // With backups in the walk the pool's next hop is the retry:
            // each transport retry would spend the shared walk budget again.
            ...(hasFailover ? { maxRetries: 0 } : {}),
            // `undefined` stays absent: backends that ignore sampling keep
            // their default, and no absent-key serialization is disturbed.
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          },
        );
        // Emitted for every verdict, not just defers: a policy replay needs
        // the answers that produced an allow or a deny too, and the audit
        // record carries a sentinel for those.
        ctx.log.debug(MODEL_ANSWERS_EVENT, {
          requestId: ctx.requestId,
          modelId,
          answers: response.answers,
        });
        const outcome: ReviewOutcome = synthesizeClassifierVerdict(
          projectClassifierAnswers(response.answers),
          classifier,
          now() - startedAt,
        );
        // Usage rides the outcome into the structured audit record; the
        // rawReply keeps it too, so a record reader never depends on one path.
        if (response.usage !== undefined) outcome.usage = response.usage;
        outcome.rawReply = JSON.stringify({ answers: response.answers, usage: response.usage });
        return { kind: "answered", result: { outcome, modelId } };
      } catch (error) {
        const { reason, deferKind } = classifyBackendError(error);
        const diagnostic = errorClassName(error);
        // Recorded where the failure is observed, not where the walk ends: a
        // retryable failure that a backup supersedes never reaches `finalize`,
        // and the chat lane's own catch records that attempt too. The class
        // name (never the message: URLs and keys hide in bodies) is the one
        // question the review log must answer on its own — "was the guard
        // broken?" — without paging the debug stream.
        emitCallFailure(ctx, deferKind, error);
        // One terminal-defer builder serves both exits: `finalize` runs on
        // exhaustion (backup verdicts stay uncached like the chat lane),
        // the terminal path ships immediately (primary keeps its default).
        const terminalDefer = (): EngineReviewResult => ({
          outcome: {
            verdict: { kind: "defer" },
            deferKind,
            latencyMs: now() - startedAt,
            diagnostic: { kind: "call-error", errorClass: diagnostic },
          },
          modelId,
        });
        if (reason) {
          return { kind: "retryable", reason, finalize: terminalDefer };
        }
        // Auth/policy refusals and malformed requests: terminal defer for
        // the operator (never machinery — the classifier lane has no pre-call
        // auth step, so this stays on the defer outcome path).
        return { kind: "terminal", result: terminalDefer() };
      }
    },
  };
}
