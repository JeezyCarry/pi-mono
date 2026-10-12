/**
 * Registry-facade tests: the `ClassifierClientLike` over pi's
 * `modelRegistry.classify`. The facade holds no translation — it runs the
 * call, keeps the walk's budget true, and rebuilds one of the lane's own
 * errors from a served-but-failed result so the adapter's `instanceof`
 * classification works unchanged. The behaviors the old direct-backend
 * equivalence suite pinned on the registry side (a `timed out` wording
 * failing over as a retryable timeout; an unclassifiable failure failing
 * over as a retryable connection) are re-pinned here, through the facade.
 */

import { getEventListeners } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { buildClassifierRequest } from "#src/review/engines/classifier/client.ts";
import {
  ClassifierApiError,
  ClassifierConnectionError,
  ClassifierTimeoutError,
  classifyBackendError,
} from "#src/review/failure-taxonomy.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import { makeDetails } from "#test/fixtures.ts";

import {
  type RegistryClassify,
  classifierReply,
  errorClassifierReply,
  registryFacade,
} from "./stubs.ts";

const transcript = { trustedIntent: ["check"], toolCalls: [], strippedCount: 0 };
const request = { ask: buildAskContext(makeDetails({ value: "ls" }), "/project"), target: "ls" };

describe("registry classifier facade", () => {
  // The facade consumes the request the adapter built — one truth source,
  // no rebuild.
  const built = buildClassifierRequest(transcript, request, {});

  it("passes a served result straight through", async () => {
    const reply = classifierReply();
    const classify = vi.fn<RegistryClassify>(async () => reply);
    await expect(registryFacade(classify).classify(built)).resolves.toBe(reply);
    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[1]).toBe(built);
  });

  it("maps timeout/retry/signal options onto pi's classify", async () => {
    const classify = vi.fn<RegistryClassify>(async () => classifierReply());
    const controller = new AbortController();
    await registryFacade(classify).classify(built, {
      timeoutMs: 5_000,
      maxRetries: 0,
      signal: controller.signal,
    });
    expect(classify.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 5_000,
      maxRetries: 0,
      signal: controller.signal,
    });
  });

  it("abandons the classify call when the walk budget signal fires", async () => {
    // pi's classify may ignore the signal: the remaining budget is enforced
    // by abandoning the call, whose answer can no longer affect the walk.
    const classify = vi.fn<RegistryClassify>(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = registryFacade(classify).classify(built, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ClassifierTimeoutError);
  });

  it("rejects without calling the backend when the budget is already spent", async () => {
    const classify = vi.fn<RegistryClassify>(async () => classifierReply());
    await expect(
      registryFacade(classify).classify(built, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(ClassifierTimeoutError);
    expect(classify).not.toHaveBeenCalled();
  });

  it("drops the abort listener when the classify call throws synchronously", async () => {
    // A synchronous throw (context mapping, auth lookup) must not leave a
    // listener behind on a signal that can outlive the attempt.
    const classify = vi.fn<RegistryClassify>(() => {
      throw new Error("sync boom");
    });
    const controller = new AbortController();
    await expect(
      registryFacade(classify).classify(built, { signal: controller.signal }),
    ).rejects.toThrow("sync boom");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("rebuilds an API error with its status when stopReason is error", async () => {
    const classify = vi.fn<RegistryClassify>(async () =>
      errorClassifierReply("System One API error (429): busy"),
    );
    const thrown = await registryFacade(classify)
      .classify(built)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ClassifierApiError);
    expect((thrown as ClassifierApiError).status).toBe(429);
  });

  it("treats an aborted stop as a timeout, not an answer", async () => {
    // pi returns `stopReason: "aborted"` with whatever answers it collected
    // before the cut. A cut-short call is not a verdict — synthesizing one
    // here would let a half-run review authorize the ask.
    const classify = vi.fn<RegistryClassify>(async () =>
      classifierReply({ stopReason: "aborted" }),
    );
    await expect(registryFacade(classify).classify(built)).rejects.toBeInstanceOf(
      ClassifierTimeoutError,
    );
  });

  it("classifies a status-bearing aborted stop by its status", async () => {
    // A cut-short reply can still carry the provider's status. Routing it as a
    // timeout would let failover walk around a refusal.
    const reply = classifierReply({
      stopReason: "aborted",
      errorMessage: "System One API error (403): request aborted by upstream policy",
    });
    const thrown = await registryFacade(vi.fn<RegistryClassify>(async () => reply))
      .classify(built)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ClassifierApiError);
    expect((thrown as ClassifierApiError).status).toBe(403);
    expect(classifyBackendError(thrown).reason).toBeUndefined();
  });

  it("falls back to a retryable connection error when the reply carries no message", async () => {
    // pi's classifier stop reasons are `stop`/`error`/`aborted`; an `error`
    // one is allowed to arrive without a message, and it is still a failure
    // (a killed request, not a refusal with a status).
    const reply = classifierReply({ stopReason: "error", answers: {}, errorMessage: undefined });
    const thrown = await registryFacade(vi.fn<RegistryClassify>(async () => reply))
      .classify(built)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ClassifierConnectionError);
    expect(classifyBackendError(thrown).reason).toBe("connection");
  });

  it("keeps `timed out` wording a retryable timeout (registry-side pin)", async () => {
    // Re-pinned from the retired backend-equivalence suite: the facade's
    // error rebuild recognizes "timed out" wording the shared abort rule
    // alone does not, so the walk fails over instead of deferring.
    const thrown = await registryFacade(
      vi.fn<RegistryClassify>(async () => errorClassifierReply("request timed out")),
    )
      .classify(built)
      .catch((error: unknown) => error);
    expect(classifyBackendError(thrown)).toEqual({ reason: "timeout", deferKind: "timeout" });
  });

  it("keeps an unclassifiable failure a retryable connection failure (registry-side pin)", async () => {
    // Re-pinned from the retired backend-equivalence suite: a status-less,
    // timeout-less message still fails over — the backup decides.
    const thrown = await registryFacade(
      vi.fn<RegistryClassify>(async () => errorClassifierReply("provider exploded")),
    )
      .classify(built)
      .catch((error: unknown) => error);
    expect(classifyBackendError(thrown)).toEqual({
      reason: "connection",
      deferKind: "call-failed",
    });
  });
});
