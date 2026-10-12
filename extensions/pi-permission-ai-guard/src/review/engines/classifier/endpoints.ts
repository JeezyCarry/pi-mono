/**
 * Classifier lane endpoint construction. Owns the lane-shape facts: which
 * provider shapes and `modelType` values address this lane, which registry
 * models must resolve before registration, and how each endpoint prebuilds
 * its client.
 *
 * Nothing downstream of this module branches on lane or backend shape —
 * the pool walks endpoints, the adapter attempts them.
 */

import type { ModelTypeMap } from "@earendil-works/pi-ai";

import type { ConfigIssue } from "#src/config/config-layer.ts";
import type { ModelRegistryLike } from "#src/model/model-registry.ts";
import type { ClassifierPoolEndpoint } from "#src/review/pool.ts";
import { cacheKey } from "#src/utils.ts";

import type { ClassifierClientAccessor, ClassifierClientLike } from "./client.ts";
import { createRegistryClassifierClient } from "./registry-client.ts";

/** Addressing fields shared by primary and fallback config entries. */
interface ClassifierTarget {
  /** Pi's provider id. */
  provider: string;
  model: string;
  timeoutMs: number;
}

/** The catalog surface an admission gate reads. */
type ClassifierCatalog = Pick<ModelRegistryLike, "findOfType">;

/** Sink for degraded (non-primary) rejections. */
type ClassifierSkipSink = (issue: ConfigIssue) => void;

/** What a lane must know to admit one configured endpoint into the pool. */
export interface ClassifierAdmission {
  /** The session registry — the catalog the model must exist in. */
  catalog: ClassifierCatalog;
  /** Sink for degraded (non-primary) rejections. */
  onSkipped?: ClassifierSkipSink;
}

/**
 * The lane's one catalog query: pi's `findOfType` with the model type
 * pinned to `"classifier"`, so the literal is spelled once.
 *
 * @param catalog - The registry (or its `findOfType` slice).
 * @param provider - The registry provider id.
 * @param model - The classifier model id.
 * @returns The catalog model, or undefined when absent.
 */
function classifierModel(
  catalog: ClassifierCatalog,
  provider: string,
  model: string,
): ModelTypeMap["classifier"] | undefined {
  return catalog.findOfType("classifier", provider, model);
}

/**
 * Resolve one configured classifier entry into pool endpoints.
 *
 * The model must first clear the structural gate: it must exist in pi's
 * catalog. An unresolvable *primary* throws — a broken primary means no
 * reviewer at all (fail-safe session start). An unresolvable *fallback* is
 * reported and dropped — the fallback contract is "a broken backup
 * degrades", and a dropped endpoint must never reach `attempt()`.
 *
 * @param target - Addressing fields plus the entry's resolved timeout.
 * @param position - Config position (0 = primary); decides throw vs skip.
 * @param admission - Registry catalog + skip sink.
 * @returns The admitted endpoints (empty when a fallback degraded away).
 */
export function resolveClassifierEntry(
  target: ClassifierTarget,
  position: number,
  admission?: ClassifierAdmission,
): ClassifierPoolEndpoint[] {
  const endpoint: ClassifierPoolEndpoint = {
    lane: "classifier",
    provider: target.provider,
    model: target.model,
    timeoutMs: target.timeoutMs,
    id: `${target.provider}/${target.model}`,
  };
  // No admission means the caller wants pure routing (every endpoint
  // admitted as written) — the structural gate is opt-in.
  if (!admission) return [endpoint];
  if (classifierModel(admission.catalog, endpoint.provider, endpoint.model) === undefined) {
    return reject(
      position,
      admission.onSkipped,
      `registry classifier model ${endpoint.id} not found in pi's model catalog — skipped`,
      `registry classifier primary (${endpoint.id}) not found in pi's model catalog — check the provider id and model`,
      ".model",
    );
  }
  return [endpoint];
}

/**
 * Prebuild every classifier endpoint's client eagerly, returning the
 * accessor the adapter fetches through by identity. Eager resolution means
 * an unresolvable registry model fails at registration, not per ask, and
 * shared credentials share one client.
 *
 * Facades resolve against pi's catalog in the same synchronous pass the
 * admission gate probed; resolving per ask would let a catalog hot-change
 * turn an admitted endpoint into a throw inside `attempt()`. The accessor
 * is the adapter's only path, so a miss is a wiring bug, not an
 * availability signal.
 *
 * @param endpoints - The admitted endpoint list.
 * @param registry - The model registry from the session.
 * @returns The client accessor, keyed by provider/model.
 */
export function prebuildClassifierClients(
  endpoints: readonly ClassifierPoolEndpoint[],
  registry: ModelRegistryLike,
): ClassifierClientAccessor {
  const facades = new Map<string, ClassifierClientLike>();
  // Bind: `classify` reads `this.runtime` on pi's registry, so a detached
  // reference throws `TypeError` at call time.
  const classify = registry.classify.bind(registry);
  for (const endpoint of endpoints) {
    const model = classifierModel(registry, endpoint.provider, endpoint.model);
    // Admission already proved this model resolves; a miss here means the
    // catalog changed between probe and prebuild — the endpoint then has no
    // client and the accessor's guard fires rather than a stale facade going
    // out to the model.
    if (!model) continue;
    facades.set(
      cacheKey(endpoint.provider, endpoint.model),
      createRegistryClassifierClient({ model, classify }),
    );
  }
  return (endpoint) => {
    const client = facades.get(cacheKey(endpoint.provider, endpoint.model));
    if (!client)
      throw new Error(`unreachable: no prebuilt client for classifier endpoint ${endpoint.id}`);
    return client;
  };
}

/**
 * Throw for a primary, report-and-drop for a fallback.
 *
 * @param position - Endpoint position: 0 is the primary.
 * @param onSkipped - Sink for the dropped-fallback issue.
 * @param fallbackMessage - Message when a fallback is dropped.
 * @param primaryMessage - The error thrown for a broken primary.
 * @param field - Suffix naming the offending field (a catalog miss is the model's).
 * @returns Always empty — a rejected entry contributes no endpoint.
 */
function reject(
  position: number,
  onSkipped: ClassifierSkipSink | undefined,
  fallbackMessage: string,
  primaryMessage: string,
  field: string,
): ClassifierPoolEndpoint[] {
  if (position === 0) throw new Error(primaryMessage);
  onSkipped?.({ path: `fallbacks.${position - 1}${field}`, message: fallbackMessage });
  return [];
}
