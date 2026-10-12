/**
 * Pool assembly: turn a validated config into ordered pool endpoints plus
 * lane adapters. The single place the config fans out into the pool —
 * lifecycle and the integration harness share it.
 *
 * Lane knowledge lives in the two lane modules (`chat/endpoints.ts`,
 * `classifier/endpoints.ts`), selected once per entry — never re-derived
 * from endpoint shapes downstream. This module only threads the ordered
 * config entries through those factories, runs the eager client
 * prebuilds, and wires the adapters.
 */

import type { ConfigIssue } from "#src/config/config-layer.ts";
import type { AiGuardConfig, FallbackItem } from "#src/config/config-schema.ts";
import { isClassifierMode } from "#src/config/config-schema.ts";
import type { ModelRegistryLike } from "#src/model/model-registry.ts";
import { createChatAdapter } from "#src/review/engines/chat/adapter.ts";
import type { ModelCallFn } from "#src/review/engines/chat/call.ts";
import { buildChatEndpoint } from "#src/review/engines/chat/endpoints.ts";
import type { ChatInstructions } from "#src/review/engines/chat/prompt.ts";
import { createClassifierAdapter } from "#src/review/engines/classifier/adapter.ts";
import {
  type ClassifierAdmission,
  prebuildClassifierClients,
  resolveClassifierEntry,
} from "#src/review/engines/classifier/endpoints.ts";
import type { ClassifierOverlay } from "#src/review/engines/classifier/instructions.ts";
import type { ClassifierPoolEndpoint, PoolEndpoint } from "#src/review/pool.ts";
import { FALLBACK_TIMEOUT_DEFAULT_MS, createReviewerPool } from "#src/review/pool.ts";
import type { ReviewerEngine } from "#src/review/reviewer-engine.ts";

export interface PoolAssemblyDeps {
  registry: ModelRegistryLike;
  modelCall: ModelCallFn;
  /** Sink for skipped-fallback issues (a broken backup degrades). */
  onSkippedFallback?: (issue: ConfigIssue) => void;
}

/**
 * Resolve the ordered endpoint list: primary first, backups after.
 * Backups take their own timeout, or the top-level one discounted to
 * `FALLBACK_TIMEOUT_DEFAULT_MS` — primary-only tuning (`classifier.*`
 * thresholds) never leaks onto an unrelated endpoint.
 *
 * Lane membership is decided once per entry by the lane modules — the
 * closed `modelType` enum *is* the lane. A registry classifier entry must
 * additionally clear the lane's structural gate (catalog presence); an
 * unresolvable primary throws (fail-safe: a broken primary means no
 * reviewer), an unresolvable fallback is reported and dropped.
 *
 * Omitting `admission` turns the registry gate off — every configured
 * endpoint is admitted as written, which is the shape the lane unit tests
 * assert against. Passing it turns the gate on: the catalog answers for
 * the model, and an unresolvable entry throws or is dropped by position.
 *
 * @param config - The validated extension config.
 * @param admission - Classifier-lane gate: catalog + skip sink.
 * @returns The ordered endpoints (primary first, backups after).
 */
export function resolvePoolEndpoints(
  config: AiGuardConfig,
  admission?: ClassifierAdmission,
): PoolEndpoint[] {
  // One config entry → its endpoints, the lane decision written once: a
  // chat entry passes straight through to the chat factory, a classifier
  // entry clears its lane's own admission gate (catalog → admit-or-throw/drop)
  // with the position deciding throw vs skip.
  const resolveEntry = (
    entry: AiGuardConfig | FallbackItem,
    position: number,
    timeoutMs: number,
    temperature: number | undefined,
  ): PoolEndpoint[] =>
    isClassifierMode(entry)
      ? resolveClassifierEntry(
          { provider: entry.provider, model: entry.model, timeoutMs },
          position,
          admission,
        )
      : [
          buildChatEndpoint({
            provider: entry.provider,
            model: entry.model,
            timeoutMs,
            temperature,
          }),
        ];

  // The primary's timeout is the top-level `timeoutMs` — same for both
  // lanes; per-endpoint tuning lives on fallback entries. A classifier
  // primary has no override of its own.
  return [
    ...resolveEntry(config, 0, config.timeoutMs, config.temperature),
    ...config.fallbacks.flatMap((entry: FallbackItem, position): PoolEndpoint[] =>
      // Fallback default is discounted: backups are usually cheap fast
      // models that need no primary-sized window. Explicit entries win.
      resolveEntry(
        entry,
        position + 1,
        entry.timeoutMs ?? Math.min(config.timeoutMs, FALLBACK_TIMEOUT_DEFAULT_MS),
        // Only a registry entry carries a sampling field.
        ("temperature" in entry ? entry.temperature : undefined) ?? config.temperature,
      ),
    ),
  ];
}

/** The per-lane instructions slices the config resolves to. */
export interface LaneInstructions {
  chat: ChatInstructions;
  classifier: ClassifierOverlay;
}

/**
 * Scope `instructions` per lane. A string is the one broadcast form: it
 * appends the same content to each lane's content key (chat `rules`,
 * classifier `background`). A per-lane slot feeds only its own lane; a lane
 * with no slot (or a null/absent `instructions`) runs the built-ins. The
 * string/object distinction stops here — adapters receive their resolved
 * slot.
 *
 * @param config - The validated extension config.
 * @returns The per-lane instructions slices.
 */
export function resolveLaneInstructions(config: AiGuardConfig): LaneInstructions {
  const instructions = config.instructions;
  if (typeof instructions === "string") {
    return {
      chat: { rules: instructions, replace: false },
      classifier: { background: instructions },
    };
  }
  if (instructions === null) {
    return { chat: { rules: null, replace: false }, classifier: {} };
  }
  return {
    chat: instructions.chat
      ? { rules: instructions.chat.rules, replace: instructions.chat.replace }
      : { rules: null, replace: false },
    classifier: instructions.classifier ?? {},
  };
}

/**
 * Build the pooled reviewer engine for a session. Structural problems
 * throw here — at registration time, not per ask (fail-safe session
 * start): a primary classifier model missing from pi's catalog. An
 * unresolvable registry *fallback* is skipped, not fatal.
 * Registry facades resolve eagerly and are cached by provider/model,
 * so a catalog hot-change can only fail the transport, never throw
 * stale wiring inside `attempt()`.
 *
 * @param config - The validated extension config.
 * @param deps - Registry + model-call fn for the chat lane.
 * @returns A lane-blind `ReviewerEngine` walking the endpoint list.
 */
export function buildReviewerPool(config: AiGuardConfig, deps: PoolAssemblyDeps): ReviewerEngine {
  const endpoints = resolvePoolEndpoints(config, {
    catalog: deps.registry,
    onSkipped: (issue) => deps.onSkippedFallback?.(issue),
  });
  const classifierEndpoints = endpoints.filter(
    (e): e is ClassifierPoolEndpoint => e.lane === "classifier",
  );
  const { chat: chatInstructions, classifier: classifierInstructions } =
    resolveLaneInstructions(config);
  // Eager clients: every classifier endpoint's client resolves at
  // registration (fail fast on a registry model outside pi's catalog), so
  // per-ask failures stay on the transport.
  const classifierClientFor = prebuildClassifierClients(classifierEndpoints, deps.registry);
  return createReviewerPool({
    endpoints,
    adapters: {
      chat: createChatAdapter({
        config: {
          reasoning: config.reasoning,
          maxTokens: config.maxTokens,
          instructions: chatInstructions,
        },
        registry: deps.registry,
        modelCall: deps.modelCall,
      }),
      classifier: createClassifierAdapter({
        config: {
          classifier: config.classifier,
          instructions: classifierInstructions,
          temperature: config.temperature,
        },
        registryClient: classifierClientFor,
      }),
    },
  });
}
