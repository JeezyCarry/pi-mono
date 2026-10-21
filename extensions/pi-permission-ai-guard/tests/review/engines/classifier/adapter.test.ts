/**
 * Classifier adapter tests: error → three-state mapping. Success paths
 * (projection, synthesis) are covered at the verdict/unit level; here
 * each classifier failure pins its disposition: answered (never — failures
 * carry no verdict), retryable (availability failure incl. 409/425 per the
 * unified table), or terminal defer (auth/policy refusals, malformed
 * requests).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClassifierAnswer, ClassifierResult } from "@earendil-works/pi-ai";
import type { AuthorizerLog } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { configSchema } from "#src/config/config-schema.ts";
import { createClassifierAdapter } from "#src/review/engines/classifier/adapter.ts";
import type { ClassifierClientLike } from "#src/review/engines/classifier/client.ts";
import {
  ClassifierApiError,
  ClassifierConnectionError,
  ClassifierTimeoutError,
} from "#src/review/failure-taxonomy.ts";
import type { AttemptSpec, ClassifierPoolEndpoint } from "#src/review/pool.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import { snapshotRequest } from "#src/review/request/review-request.ts";
import { applyVerdictMode } from "#src/review/verdict-rule.ts";
import { makeDetails } from "#test/fixtures.ts";
import { makeMergedRecordingLog } from "#test/review/pipeline-helpers.ts";

import { classifierReply } from "./stubs.ts";

/**
 * A reply that answered the four axis questions, with individual answers replaced.
 *
 * @param answers - Per-question answers replacing the allow-shaped defaults.
 * @returns The classifier result the stubbed backend serves.
 */
function response(answers: Record<string, ClassifierAnswer> = {}): ClassifierResult {
  return classifierReply({
    answers: {
      ban: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
      effect: { type: "choice", choice: "read", confidence: 0.9, probabilities: {} },
      target: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
      // The attempt contexts carry a trusted anchor, so the intent action
      // is asked and the default reply answers it.
      intent: { type: "choice", choice: "not_requested", confidence: 0.9, probabilities: {} },
      ...answers,
    },
  });
}

/**
 * The attempt context for adapter tests.
 *
 * @param log - The audit log the attempt records into.
 * @returns The context the adapter's `attempt` consumes.
 */
function attemptContext(log: AuthorizerLog) {
  const ask = buildAskContext(makeDetails({ value: "ls" }), "/project");
  return {
    transcript: { trustedIntent: ["inspect files"], toolCalls: [], strippedCount: 0 },
    request: { ask, target: "ls", commandFacts: snapshotRequest(ask).commandFacts },
    log,
    requestId: "classifier-adapter-test",
  };
}

/**
 * Per-attempt spec for adapter tests.
 *
 * @param hasFailover - Whether another endpoint follows this one in the walk.
 * @returns The attempt spec.
 */
const spec = (hasFailover: boolean): AttemptSpec => ({
  hasFailover,
  attemptTimeoutMs: 5_000,
  walkRemainingMs: 30_000,
});

const endpoint = (model = "jev-1.13", timeoutMs = 15000): ClassifierPoolEndpoint => ({
  lane: "classifier",
  provider: "typesafe",
  model,
  timeoutMs,
  id: `typesafe/${model}`,
});

const classifierConfig = {
  classifier: {
    confidenceThreshold: 0.5,
  },
  instructions: {},
  temperature: undefined,
};

const adapter = (client: ClassifierClientLike) =>
  createClassifierAdapter({
    config: classifierConfig,
    registryClient: () => client,
  });

const httpError = (status: number) => new ClassifierApiError(status, "no capacity");

const throwing = (error: Error): ClassifierClientLike => ({
  classify: async () => {
    throw error;
  },
});

const safe: ClassifierClientLike = { classify: async () => response() };

describe("classifier adapter disposition", () => {
  it("keeps an invisible downstream deferred through the production rows", async () => {
    // Production-chain regression: a real package fixture whose entry
    // declares a downstream file nobody read (scope: entry-declaration-only)
    // — with an unreadable action and a naming anchor still defers. The
    // snapshot does not authorize, and an unreadable command never allows.
    // The adapter → verdict path is exercised with the real command, a
    // naming anchor, and a negating anchor.
    for (const anchor of [
      "run the migration", // names the action — still defers
      "do not run the migration", // negates it — no fact is manufactured
    ]) {
      const dir = join(tmpdir(), `adapter-facts-${process.pid}`);
      mkdirSync(dir, { recursive: true });
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ scripts: { migrate: "node invisible.js" } }),
        );
        const { events, log } = makeMergedRecordingLog();
        const ask = buildAskContext(makeDetails({ value: "npm run migrate" }), dir);
        const withFacts = {
          transcript: { trustedIntent: [anchor], toolCalls: [], strippedCount: 0 },
          request: {
            ask,
            target: "npm run migrate",
            observedFacts: snapshotRequest(ask).observedFacts,
          },
          log,
          requestId: "classifier-adapter-test",
        };
        // The snapshot carries the real entry text — the test would fail
        // if the producer stopped seeing the fixture.
        expect(withFacts.request.observedFacts).toMatchObject({
          source: "package.json:scripts.migrate",
          scripts: { migrate: "node invisible.js" },
        });
        let seenState: Record<string, unknown> | undefined;
        const invisible: ClassifierClientLike = {
          classify: async (context) => {
            // Capture the ACTUAL wire state the adapter built — the
            // snapshot must ride the classifier request, not just the
            // request context the test hands the adapter.
            seenState = context.state as Record<string, unknown>;
            return response({
              effect: {
                type: "choice",
                choice: "cannot_determine",
                confidence: 0.9,
                probabilities: {},
              },
            });
          },
        };
        const attempt = await adapter(invisible).attempt(endpoint(), withFacts, spec(false));
        expect(attempt.kind).toBe("answered");
        if (attempt.kind !== "answered") return;
        expect(attempt.result.outcome.verdict.kind).toBe("defer");
        expect(attempt.result.outcome.deferKind).toBe("model-defer");
        // The captured wire state carries the same snapshot the request
        // context holds — the adapter→buildState→classify joint is live.
        expect(seenState?.observed_facts).toMatchObject({
          source: "package.json:scripts.migrate",
          scope: "entry-declaration-only",
          downstream: "unresolved",
          trust: "untrusted-project-text-not-authorization",
          keys: ["migrate"],
          scripts: { migrate: "node invisible.js" },
        });
        expect(events.filter((e) => e.event === "ai_guard.model_answers")).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps a model-defer a defer through the default mode mapping", async () => {
    // Production chain, second half: the adapter synthesizes the defer
    // outcome, then the pipeline's mapping (default mode) must leave it a
    // defer — the evidence does not authorize, and an unreadable command
    // never maps to allow or deny. applyVerdictMode runs on the REAL outcome.
    const { log } = makeMergedRecordingLog();
    const attempt = await adapter({
      classify: async () =>
        response({
          effect: {
            type: "choice",
            choice: "cannot_determine",
            confidence: 0.9,
            probabilities: {},
          },
        }),
    }).attempt(endpoint(), attemptContext(log), spec(false));
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    const outcome = attempt.result.outcome;
    const mapped = applyVerdictMode("default", outcome.verdict, {
      kind: outcome.deferKind,
      reason: outcome.deferReason,
      lean: outcome.lean,
    });
    expect(mapped.kind).toBe("defer");
  });

  it("answers a valid allow with the primary identity", async () => {
    const { events, log } = makeMergedRecordingLog();
    const attempt = await adapter(safe).attempt(endpoint(), attemptContext(log), spec(false));
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.outcome.verdict.kind).toBe("allow");
    expect(attempt.result.modelId).toBe("typesafe/jev-1.13");
    expect(attempt.result.cacheable).toBeUndefined();
    // The policy replay reads answers from the audit stream, so the emission
    // is pinned here: one debug event whose payload carries the wire answers.
    const answersEvents = events.filter((e) => e.event === "ai_guard.model_answers");
    expect(answersEvents).toHaveLength(1);
    expect(answersEvents[0].details).toMatchObject({ answers: expect.anything() });
  });

  it("answers danger and low-confidence outcomes without failover signal", async () => {
    for (const [overrides, expected] of [
      // A credential read is a block-tier row: it asks leaning deny even
      // with a named request behind it; the mode mapping, not the verdict,
      // keeps it soft. A workspace modification without a request asks
      // leaning allow; an unsure confidence defers neutrally.
      [
        {
          effect: { type: "choice", choice: "read", confidence: 0.9, probabilities: {} },
          target: {
            type: "choice",
            choice: "credential_material",
            confidence: 0.9,
            probabilities: {},
          },
          intent: { type: "choice", choice: "requested", confidence: 0.9, probabilities: {} },
        },
        { verdict: { kind: "defer" }, deferKind: "model-defer", lean: "deny" },
      ],
      [
        {
          effect: { type: "choice", choice: "modify", confidence: 0.9, probabilities: {} },
          target: {
            type: "choice",
            choice: "ordinary_files",
            confidence: 0.9,
            probabilities: {},
          },
        },
        { verdict: { kind: "defer" }, deferKind: "model-defer", lean: "allow" },
      ],
      // A REPORTED-but-below-the-floor negative reading is adopted as
      // benign — gating it would let confidence manufacture a
      // missing-evidence wall.
      [
        {
          ban: { type: "choice", choice: "none", confidence: 0.1, probabilities: {} },
        },
        { verdict: { kind: "allow" } },
      ],
    ] as const) {
      const attempt = await adapter({
        classify: async () => response(overrides as Record<string, ClassifierAnswer>),
      }).attempt(endpoint(), attemptContext(makeMergedRecordingLog().log), spec(true));
      expect(attempt.kind).toBe("answered");
      if (attempt.kind !== "answered") continue;
      expect(attempt.result.outcome).toMatchObject(expected);
    }
  });

  it.each([402, 404, 408, 409, 410, 425, 429, 503])(
    "reports retryable on HTTP %i (unified table, 409/425 included)",
    async (status) => {
      const attempt = await adapter(throwing(httpError(status))).attempt(
        endpoint(),
        attemptContext(makeMergedRecordingLog().log),
        spec(true),
      );
      expect(attempt.kind).toBe("retryable");
      if (attempt.kind !== "retryable") return;
      expect(attempt.reason).toBe(`http-${status}`);
    },
  );

  it("reports retryable on timeouts and connection failures", async () => {
    for (const failure of [
      new ClassifierTimeoutError(),
      new ClassifierConnectionError("socket hang up"),
    ]) {
      const attempt = await adapter(throwing(failure)).attempt(
        endpoint(),
        attemptContext(makeMergedRecordingLog().log),
        spec(true),
      );
      expect(attempt.kind).toBe("retryable");
    }
  });

  it.each([400, 401, 403, 422])(
    "reports terminal defer (never machinery) on HTTP %i",
    async (status) => {
      const { events, log } = makeMergedRecordingLog();
      const attempt = await adapter(throwing(httpError(status))).attempt(
        endpoint(),
        attemptContext(log),
        spec(true),
      );
      expect(attempt.kind).toBe("terminal");
      if (attempt.kind !== "terminal") return;
      expect(attempt.result).toMatchObject({
        outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
      });
      // Debug emission stays with the terminal path.
      expect(events.map((e) => e.event)).toEqual(["ai_guard.model_call_error"]);
    },
  );

  it("records the failed attempt even when a backup supersedes it", async () => {
    // The pool only calls `finalize` on exhaustion: a retryable failure a
    // backup takes over must still reach the audit log, as it does in chat.
    const { events, log } = makeMergedRecordingLog();
    const attempt = await adapter(throwing(httpError(503))).attempt(
      endpoint(),
      attemptContext(log),
      spec(true),
    );
    expect(attempt.kind).toBe("retryable");
    expect(events.map((e) => e.event)).toEqual(["ai_guard.model_call_error"]);
  });

  it("fails over on unexpected local exceptions", async () => {
    // An untyped local throw (stale module, SDK bug) is availability on
    // its face, not a refusal: the pool tries the backup before deferring.
    const attempt = await adapter(throwing(new Error("unexpected parsing bug"))).attempt(
      endpoint(),
      attemptContext(makeMergedRecordingLog().log),
      spec(true),
    );
    expect(attempt.kind).toBe("retryable");
  });

  it("preserves single-endpoint retry and disables it with backups", async () => {
    const seen: Array<unknown> = [];
    const probe: ClassifierClientLike = {
      classify: async (_context, options) => {
        seen.push(options?.maxRetries);
        return response();
      },
    };
    const a = adapter(probe);
    await a.attempt(endpoint(), attemptContext(makeMergedRecordingLog().log), spec(false));
    await a.attempt(endpoint(), attemptContext(makeMergedRecordingLog().log), spec(true));
    expect(seen).toEqual([undefined, 0]);
  });

  it("sends the trimmed attempt timeout per attempt", async () => {
    const seen: Array<number | undefined> = [];
    const probe: ClassifierClientLike = {
      classify: async (_context, options) => {
        seen.push(options?.timeoutMs);
        return response();
      },
    };
    await adapter(probe).attempt(
      endpoint("backup-model", 2000),
      attemptContext(makeMergedRecordingLog().log),
      {
        hasFailover: true,
        attemptTimeoutMs: 500,
        walkRemainingMs: 60_000,
      },
    );
    // The trimmed attempt budget reaches the call — not the endpoint's own
    // 2000, which is what an equal-value spec could not tell apart.
    expect(seen).toEqual([500]);
  });

  it("forwards the configured temperature, or omits it when unset", async () => {
    // The slot exists for backends that apply sampling (llama-cpp scales
    // the label softmax); TypeSafe ignores it. Absent must stay absent —
    // an unpinned temperature is not a choice of zero.
    const seen: Array<Record<string, unknown> | undefined> = [];
    const probe: ClassifierClientLike = {
      classify: async (_context, options) => {
        seen.push(options === undefined ? undefined : { ...options });
        return response();
      },
    };
    const ctx = attemptContext(makeMergedRecordingLog().log);
    await adapter(probe).attempt(endpoint(), ctx, spec(false));
    expect(seen[0]).not.toHaveProperty("temperature");
    const pinned = createClassifierAdapter({
      config: { ...classifierConfig, temperature: 0.25 },
      registryClient: () => probe,
    });
    await pinned.attempt(endpoint(), ctx, spec(false));
    expect(seen[1]?.temperature).toBe(0.25);
  });

  it("carries the backend usage onto the outcome for the audit record", async () => {
    const usage = {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    };
    const attempt = await adapter({
      classify: async () => ({ ...response(), usage }),
    }).attempt(endpoint(), attemptContext(makeMergedRecordingLog().log), spec(false));
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.outcome.usage).toEqual(usage);
  });

  it("bounds the whole call with the walk's remaining budget", async () => {
    // Transport retries each get a fresh `timeoutMs`, so only the signal can
    // keep a single-endpoint walk (which keeps those retries) inside the
    // budget the pool advertises — and it must carry the walk's number, not a
    // constant.
    const seen: Array<AbortSignal | undefined> = [];
    const probe: ClassifierClientLike = {
      classify: async (_context, options) => {
        seen.push(options?.signal);
        return response();
      },
    };
    const a = adapter(probe);
    const ctx = attemptContext(makeMergedRecordingLog().log);
    await a.attempt(endpoint(), ctx, {
      hasFailover: false,
      attemptTimeoutMs: 15_000,
      walkRemainingMs: 60_000,
    });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.aborted).toBe(false);
    await a.attempt(endpoint(), ctx, {
      hasFailover: false,
      attemptTimeoutMs: 15_000,
      walkRemainingMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(seen[1]?.aborted).toBe(true);
  });
});

describe("classifier adapter incomplete responses", () => {
  // Never answered is malformed, not zero: projection throws and the
  // catch routes to a machinery defer (never allow, in every mode).
  // (A fully-empty answers object is covered at the verdict layer by the
  // projection-throws test — this fixture always carries the base keys.)
  it("fails over on a malformed model reply", async () => {
    const attempt = await adapter({
      classify: async () => ({ ...response(), answers: undefined }) as unknown as ClassifierResult,
    }).attempt(endpoint(), attemptContext(makeMergedRecordingLog().log), spec(true));
    expect(attempt.kind).toBe("retryable");
    if (attempt.kind !== "retryable") return;
    expect(attempt.finalize()).toMatchObject({
      outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
    });
  });

  it.each([[{ effect: undefined }], [{ target: undefined }], [{ ban: undefined }]])(
    "fails over on missing answers %j",
    async (overrides) => {
      const attempt = await adapter({
        classify: async () => response(overrides as unknown as Record<string, ClassifierAnswer>),
      }).attempt(endpoint(), attemptContext(makeMergedRecordingLog().log), spec(true));
      expect(attempt.kind).toBe("retryable");
      if (attempt.kind !== "retryable") return;
      expect(attempt.finalize()).toMatchObject({
        outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
      });
    },
  );

  it("fails over on a missing reading field", async () => {
    const attempt = await adapter({
      classify: async () =>
        response({
          effect: { type: "bool", probability: 0.9 } as unknown as ClassifierAnswer,
        }),
    }).attempt(endpoint(), attemptContext(makeMergedRecordingLog().log), spec(true));
    expect(attempt.kind).toBe("retryable");
    if (attempt.kind !== "retryable") return;
    expect(attempt.finalize()).toMatchObject({
      outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
    });
  });

  it("answers model-defer on missing confidence (uncertain, not malformed)", async () => {
    const attempt = await adapter({
      classify: async () =>
        response({
          ban: { type: "choice", choice: "none" } as unknown as ClassifierAnswer,
          effect: { type: "choice", choice: "read" } as unknown as ClassifierAnswer,
        }),
    }).attempt(endpoint(), attemptContext(makeMergedRecordingLog().log), spec(true));
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.outcome.verdict).toEqual({ kind: "defer" });
    expect(attempt.result.outcome.deferKind).toBe("model-defer");
  });
});

const registryEndpoint = (provider = "typesafe", model = "jev-latest"): ClassifierPoolEndpoint => ({
  lane: "classifier",
  provider,
  model,
  timeoutMs: 15000,
  id: `${provider}/${model}`,
});

describe("classifier registry seam", () => {
  it("routes an endpoint through the facade client", async () => {
    // Locks the adapter↔facade joint: the endpoint must reach
    // `registryClient` and its answers must flow through verdict synthesis
    // to an answered attempt.
    const seen: string[] = [];
    const adapterWithFacade = createClassifierAdapter({
      config: classifierConfig,
      registryClient: () => {
        seen.push("facade");
        return safe;
      },
    });
    const attempt = await adapterWithFacade.attempt(
      registryEndpoint(),
      attemptContext(makeMergedRecordingLog().log),
      spec(false),
    );
    expect(seen).toEqual(["facade"]);
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.outcome.verdict.kind).toBe("allow");
    expect(attempt.result.modelId).toBe("typesafe/jev-latest");
  });

  it("names the registry provider in the audit identity", async () => {
    // A registry endpoint is whichever provider Pi resolved, so the audit
    // record carries that provider id.
    const withFacade = createClassifierAdapter({
      config: classifierConfig,
      registryClient: () => safe,
    });
    const attempt = await withFacade.attempt(
      registryEndpoint("cloudflare-workers-ai", "classify-v1"),
      attemptContext(makeMergedRecordingLog().log),
      spec(false),
    );
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.modelId).toBe("cloudflare-workers-ai/classify-v1");
  });

  it("fails over when an endpoint arrives without a facade", async () => {
    // The missing-facade throw lands in the attempt's own try/catch and is
    // untyped, so the pool treats it as availability: a wiring bug on the
    // primary must not block the backup from answering.
    const withoutFacade = createClassifierAdapter({ config: classifierConfig });
    const attempt = await withoutFacade.attempt(
      registryEndpoint(),
      attemptContext(makeMergedRecordingLog().log),
      spec(false),
    );
    expect(attempt.kind).toBe("retryable");
    if (attempt.kind !== "retryable") return;
    expect(attempt.finalize()).toMatchObject({ outcome: { deferKind: "call-failed" } });
  });
});

describe("classifier config surface", () => {
  it("defaults to no backups for a registry classifier primary", () => {
    const parsed = configSchema.parse({
      provider: "typesafe",
      model: "jev-1.13",
      modelType: "classifier",
    });
    expect(parsed.fallbacks).toEqual([]);
  });

  it("rejects the removed direct provider form", () => {
    expect(
      configSchema.safeParse({
        provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" },
        model: "jev-1.13",
      }).success,
    ).toBe(false);
  });

  it("accepts cross-lane (chat) backups and still bounds the list", () => {
    expect(
      configSchema.safeParse({
        provider: "typesafe",
        model: "jev-1.13",
        modelType: "classifier",
        fallbacks: [{ provider: "anthropic", model: "haiku" }],
      }).success,
    ).toBe(true);
    expect(
      configSchema.safeParse({
        provider: "typesafe",
        model: "jev-1.13",
        modelType: "classifier",
        fallbacks: Array.from({ length: 6 }, () => ({ provider: "anthropic", model: "m" })),
      }).success,
    ).toBe(false);
  });
});
