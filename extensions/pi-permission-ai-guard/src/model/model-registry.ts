/**
 * Pi's model registry, projected to the surfaces this extension needs.
 * Lane-neutral: the chat lane reads `find`/`getApiKeyAndHeaders`/
 * `streamSimple`, the classifier lane reads `classify`/`findOfType`.
 * Kept apart from both lanes' call machinery so
 * neither lane's transport leaks into the other.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Auth result from `ModelRegistry.getApiKeyAndHeaders`, derived from the
 * upstream return type (not exported from the package root).
 */
export type ResolvedRequestAuth = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;

/**
 * The chat-lane registry surface: model lookup, auth, and the simple-stream
 * completion.
 *
 * `streamSimple`, not `complete`: the latter routes to the provider's
 * low-level `stream`, which reads `reasoningEffort` and silently drops the
 * simple-layer `reasoning` option — every review would run at the model's
 * `off` level. `streamSimple` translates `reasoning` through the model's
 * `thinkingLevelMap`.
 *
 * A `Pick` of the real class instance type so the accepted method set
 * tracks the package's exported shape instead of a hand-written
 * interface that can silently diverge.
 */
export type ChatRegistryLike = Pick<ModelRegistry, "find" | "getApiKeyAndHeaders" | "streamSimple">;

/**
 * The classifier-lane registry surface: pi built-in classifiers.
 * Required on the floor — the peer floor (`pi >= 1.0`) exposes both;
 * the lane's catalog gate still admits or rejects each configured
 * endpoint at registration.
 */
export type RegistryClassifierLike = Pick<ModelRegistry, "classify" | "findOfType">;

/** Minimal structural projection of pi's `ModelRegistry` this extension needs. */
export type ModelRegistryLike = ChatRegistryLike & RegistryClassifierLike;
