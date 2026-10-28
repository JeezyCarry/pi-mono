/**
 * Immutable per-ask review context — the single seam between permission
 * details and both prompt rendering and cache identity. Any fact that affects
 * a verdict must live here.
 */

import type { PromptRequestFacts } from "@gotgenes/pi-permission-system";

import type { CommandFacts } from "#src/review/request/command-facts.ts";
import { cacheKey, normalizeEmpty, shortHash } from "#src/utils.ts";

import type { AskContext } from "./ask.ts";
import { readCommandFacts } from "./command-facts.ts";
import { type ObservedFacts, snapshotObservedFacts } from "./observed-facts.ts";
import type { StrippedTranscript } from "./transcript-stripper.ts";

export interface ReviewRequestContext {
  readonly ask: AskContext;
  target: string;
  /**
   * The deterministic command facts for this review, computed once from
   * the command text before the cache lookup. The verdict layer reads them;
   * the model request never carries them — the model's residual judgment is
   * exactly what the facts cannot answer.
   */
  readonly commandFacts?: CommandFacts | null;
  /**
   * The per-review observed-facts snapshot. The pipeline takes this once per
   * review, before the cache lookup; the state builder, the cache material,
   * and both lane renderers consume it, so a file change mid-review cannot
   * put B's verdict under A's key. The next review re-snapshots.
   */
  readonly observedFacts?: ObservedFacts | null;
}

/**
 * The exclusion doctrine, as compile-time tripwires.
 *
 * The cache identity keys on a deliberate subset. Every OTHER
 * decision-adjacent fact is excluded for a REASON — the two records below
 * are exhaustive by construction: add a field to `AskContext`, or upstream
 * adds one to `PromptRequestFacts`, and the corresponding `Record` stops
 * compiling until the new field is either keyed or documented here. The
 * "annotations are always empty" and "administrative labels are noise"
 * assumptions can then never go stale silently.
 */

/** AskContext fields the cache identity reads from. */
type KeyedAskFields =
  | "kind"
  | "request"
  | "fullCommand"
  | "flaggedElements"
  | "toolInputPreview"
  | "readPath"
  | "resolvedAlias"
  | "canonicalBoundary"
  | "workingDirectory";

/** Upstream request facts the cache identity keys on (via the material below). */
type KeyedRequestFacts = "value" | "commandContext" | "executedUnit" | "matchedSpelling";

/** Every other AskContext field — excluded by doctrine, one entry each. */
export const EXCLUDED_ASK_FIELDS: Record<Exclude<keyof AskContext, KeyedAskFields>, string> = {
  annotations: "model advisories — not rendered, not keyed",
  agentReason:
    "agent's free-text intent — rendered for the reviewer, but its wording varies per call, so keying on it defeats the cache",
};

/** Every other upstream request fact — excluded by doctrine, one entry each. */
export const EXCLUDED_REQUEST_FACTS: Record<
  Exclude<keyof PromptRequestFacts, KeyedRequestFacts>,
  string
> = {
  requester: "who is asking — administrative",
  surface: "gate label — keying re-partitions the cache",
  toolName: "gate label, same doctrine as surface",
  invokedToolName: "gate label (alias re-exposure), same doctrine",
  matchedPattern: "rule name — rendered but instructed noise",
  decidingPath:
    "host attribution of a bash path ask (pi-permission-system 41+) — not rendered to either lane, so it cannot change the verdict",
};

/**
 * Build cache material for every fact that affects review semantics.
 *
 * The field set is a `kind`-agnostic decision-relevant superset: every field
 * that could change a verdict across any of the 9 payload kinds, with absent
 * fields (undefined or empty string) normalized to `null` so a missing fact
 * and an empty fact produce the same key.
 *
 * Excluded by design (do not affect the verdict the model can reach):
 * `matchedPattern`, `invokedToolName`, `requester`, `annotations`, `toolName`,
 * `surface`, `decidingPath` (not rendered), and `agentReason` (free text
 * whose wording varies per call).
 *
 * `matchedPattern` is excluded and `matchedSpelling` is not: the pattern is a
 * rule name the prompt teaches the model to ignore, while the spelling is the
 * gate's own resolution of the typed command (a relative path argument matched
 * as its absolute spelling), which changes what the action targets.
 *
 * `surface` is a gate label, not a decision input: the verdict is driven by
 * the command content, `executedUnit`, and `commandContext` (all in the key),
 * and the SAFETY_RULES instruct the model to treat administrative labels as
 * noise. Two asks that share `kind` + content but differ only in `surface`
 * (e.g. a `bash` kind reached via a shell-alias re-exposure, where `surface`
 * holds the alias name) reach the same verdict and so intentionally collide.
 *
 * **Never log this value** — it contains raw, unredacted action text (needed
 * for cache-key distinction). The caller must pass it directly to a hash
 * function.
 *
 * @param request - The review request context (ask + target).
 * @returns A stable serialization for immediate hashing by the caller.
 */
export function reviewRequestCacheMaterial(request: ReviewRequestContext): string {
  const { ask } = request;
  return JSON.stringify({
    kind: ask.kind,
    value: normalizeEmpty(ask.request.value),
    target: normalizeEmpty(request.target),
    fullCommand: normalizeEmpty(ask.fullCommand),
    flaggedElements: ask.flaggedElements.map(normalizeEmpty),
    commandContext: normalizeEmpty(ask.request.commandContext),
    executedUnit: normalizeEmpty(ask.request.executedUnit),
    matchedSpelling: normalizeEmpty(ask.request.matchedSpelling),
    canonicalBoundary: normalizeEmpty(ask.canonicalBoundary),
    workingDirectory: normalizeEmpty(ask.workingDirectory),
    readPath: normalizeEmpty(ask.readPath),
    resolvedAlias: normalizeEmpty(ask.resolvedAlias),
    toolInputPreview: normalizeEmpty(ask.toolInputPreview),
    // Observed facts: the script text is decision-relevant evidence —
    // a package.json edit invalidates the cached verdict, and so does the
    // owning manifest moving (`manifestDir`). The absence reason is keyed
    // too: evidence appearing where none was keyed is the same invalidation.
    observedFacts: request.observedFacts
      ? request.observedFacts.source === null
        ? `absent:${request.observedFacts.reason}`
        : JSON.stringify({
            source: request.observedFacts.source,
            scope: request.observedFacts.scope,
            runner: request.observedFacts.runner,
            lifecycleDeclared: request.observedFacts.lifecycleDeclared,
            keys: request.observedFacts.keys,
            scripts: request.observedFacts.scripts,
            manifestDir: request.observedFacts.manifestDir,
          })
      : null,
    // Deterministic command facts: a symlink retarget after caching must
    // miss — the path scope the verdict rested on may have moved.
    commandFacts: request.commandFacts
      ? JSON.stringify({
          pathScope: request.commandFacts.pathScope,
          namedBuildOutput: request.commandFacts.namedBuildOutput,
          recursive: request.commandFacts.recursive,
          publishesArtifact: request.commandFacts.publishesArtifact,
          sensitivePathName: request.commandFacts.sensitivePathName,
          publicSystemPath: request.commandFacts.publicSystemPath,
          rewritesHistory: request.commandFacts.rewritesHistory,
          rawCopy: request.commandFacts.rawCopy,
          allInterfaces: request.commandFacts.allInterfaces,
          network: request.commandFacts.network,
          dumpsEnvironment: request.commandFacts.dumpsEnvironment,
          installsPersistence: request.commandFacts.installsPersistence,
          grantsBeyondOwner: request.commandFacts.grantsBeyondOwner,
          sendsData: request.commandFacts.sendsData,
          commandEffect: request.commandFacts.commandEffect,
          secretVariable: request.commandFacts.secretVariable,
          routineDevCommand: request.commandFacts.routineDevCommand,
        })
      : null,
  });
}

/**
 * The per-review evidence snapshot: both fact layers from one manifest read.
 *
 * The pipeline takes this once per review, before the cache lookup. Every
 * consumer — the cache key, the state builder, both lane renderers — reads
 * this one value, so a file change mid-review cannot put B's verdict under
 * A's key.
 */
export interface RequestSnapshot {
  /** The observed package evidence; null for non-bash entries. */
  readonly observedFacts: ObservedFacts | null;
  /** The deterministic command facts; null for non-bash entries. */
  readonly commandFacts: CommandFacts | null;
}

/**
 * Take the per-review evidence snapshot for a request context. Call once per
 * review, before the cache lookup.
 *
 * Both layers come from the one manifest read: the command facts derive
 * `declaredTasks` from the observed snapshot rather than re-reading the file,
 * so they can never disagree about what the project declares.
 *
 * Pure read of one capped regular file plus the command text (and one
 * `realpath` per path word — read-only metadata, never file content); every
 * failure is an absence reason, never a throw.
 *
 * @param ask - The ask context to snapshot evidence for.
 * @returns The frozen snapshot; both layers null for non-bash entries.
 */
export function snapshotRequest(ask: AskContext): RequestSnapshot {
  const observedFacts = snapshotObservedFacts(ask.kind, ask.fullCommand, ask.workingDirectory);
  return { observedFacts, commandFacts: commandFactsFrom(ask, observedFacts) };
}

function commandFactsFrom(
  ask: AskContext,
  observedFacts: ObservedFacts | null,
): CommandFacts | null {
  if (ask.kind !== "bash" || !ask.fullCommand) return null;
  return readCommandFacts(ask.fullCommand, {
    cwd: ask.workingDirectory,
    declaredTasks: declaredTasksOf(observedFacts),
  });
}

// The declared project tasks of the owning manifest, keyed by entry name.
// Absent vouches for nothing: a command naming an undeclared task simply
// misses the routine-command gate. Kept private — the verdict layer reads
// `routineDevCommand`, never this map.
function declaredTasksOf(
  observed: ObservedFacts | null,
): Readonly<Record<string, string>> | undefined {
  if (observed?.source === null) return undefined;
  return observed?.scripts;
}

/** The cache identity: the two hashes the verdict cache keys on. */
export interface CacheIdentity {
  /** Hash of the decision-relevant request material. */
  commandHash: string;
  /** Hash of the transcript's trusted intent (the authorization source). */
  contextHash: string;
}

/**
 * Build the cache identity for one ask: both hashes the verdict cache
 * reads, from the ONE material definition and the transcript's trusted
 * intent. The context hash covers the trusted intent only — user messages
 * are the authorization source the model honors, so a new user message
 * must miss; tool calls are deliberately excluded (an agent retrying the
 * same command between user turns would otherwise never hit). The residual
 * risk — a verdict replayed into a prompt with different background tool
 * calls — is accepted: tool calls are untrusted context, not
 * authorization.
 *
 * @param request - The review request context (ask + target).
 * @param transcript - The stripped transcript (its trusted intent is the context hash).
 * @returns The command hash and the context hash.
 */
export function cacheIdentity(
  request: ReviewRequestContext,
  transcript: StrippedTranscript,
): CacheIdentity {
  return {
    commandHash: shortHash(reviewRequestCacheMaterial(request)),
    contextHash: shortHash(cacheKey(...transcript.trustedIntent)),
  };
}
