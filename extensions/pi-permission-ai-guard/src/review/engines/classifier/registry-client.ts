/**
 * Registry classifier facade: a `ClassifierClientLike` backed by pi's
 * built-in classifier (`modelRegistry.classify`). The classifier adapter
 * reaches it through its `registryClient` dep: one facade per endpoint,
 * prebuilt at registration.
 *
 * The lane's request and answer shapes are pi-ai's, so the facade holds no
 * translation — it runs the call and keeps the walk's budget true:
 *
 * - Options map straight across: `timeoutMs`, `maxRetries` (multi-endpoint pools disable retries),
 *   and `signal`. The signal both rides along in the request and bounds the call with a race, so
 *   the walk's remaining budget holds regardless of how the transport treats the signal, and the
 *   request is skipped outright once the budget is spent.
 * - Errors: `classify()` never rejects a served-but-failed request — it returns a non-`stop` result,
 *   which the facade rebuilds as one of the lane's own errors ({@link classifierError}) so the
 *   adapter's `instanceof` failure classification works unchanged. A registry backend's audit
 *   `rawReply` (recorded for defers alone; a clean verdict is omitted) carries pi-ai's answers
 *   directly.
 */

import type { ClassifierModel } from "@earendil-works/pi-ai";

import type { RegistryClassifierLike } from "#src/model/model-registry.ts";
import type { ClassifierClientLike } from "#src/review/engines/classifier/client.ts";
import {
  ClassifierTimeoutError,
  classifierError,
  classifierStatus,
} from "#src/review/failure-taxonomy.ts";

/** Pi-ai's `classify` plus model lookup — the facade's registry surface. */
export interface RegistryModelDeps {
  /** Resolved classifier model from `findOfType`. */
  model: ClassifierModel<string>;
  /** Bound `classify` (request-time auth lives inside pi). */
  classify: RegistryClassifierLike["classify"];
}

/**
 * Await `work`, but throw the walk's timeout the moment `signal` fires. The
 * signal also rides along in the request; this race keeps the walk's budget
 * true regardless of how the transport treats the signal, and skips the
 * request outright when the budget is already spent. A rejection from the
 * abandoned work is swallowed (the outcome is already decided here).
 *
 * @param work - Deferred classify call; not called at all when the signal already fired.
 * @param signal - The walk-budget signal, when the caller passed one.
 * @returns The classify result, or a throw when the signal fires first.
 */
function raceWithAbort<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(new ClassifierTimeoutError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new ClassifierTimeoutError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (value: T): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const fail = (error: unknown): void => {
      signal.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    let pending: Promise<T>;
    try {
      pending = work();
    } catch (error) {
      // A synchronous throw (context mapping, auth lookup) must not leave the
      // listener behind on a signal that can live for the whole walk.
      fail(error);
      return;
    }
    pending.then(settle, fail);
  });
}

/**
 * Create the registry-backed facade: `classify(context, options)` runs the
 * request through pi's classifier.
 *
 * @param deps - The resolved model plus bound classify fn.
 * @returns A `ClassifierClientLike` over pi's classifier.
 */
export function createRegistryClassifierClient(deps: RegistryModelDeps): ClassifierClientLike {
  return {
    async classify(context, options) {
      const result = await raceWithAbort(
        () =>
          deps.classify(deps.model, context, {
            timeoutMs: options?.timeoutMs,
            maxRetries: options?.maxRetries,
            signal: options?.signal,
            temperature: options?.temperature,
          }),
        options?.signal,
      );
      if (result.stopReason !== "stop") {
        // An `aborted` stop usually means a timeout — but a status-bearing
        // message wins: a refusal cut short must stay terminal, exactly as
        // {@link classifierError} reads it.
        const failure = result.errorMessage ?? "classifier failed";
        throw result.stopReason === "aborted" && classifierStatus(failure) === undefined
          ? new ClassifierTimeoutError()
          : classifierError(failure);
      }
      return result;
    },
  };
}
