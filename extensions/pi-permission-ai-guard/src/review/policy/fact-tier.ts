/**
 * The deterministic base tier: a pure function of `CommandFacts` alone.
 *
 * This is the code's half of the policy. It never consults a model reading, so
 * it is the trusted baseline the model may only tighten. The classifier lane's
 * own dual-reader table still lives in `axes/verdict.ts`; the wiring retires it.
 */

import type { CommandFacts } from "#src/review/request/command-facts.ts";

import type { FactRuling, PolicyConcept } from "./concepts.ts";

// The effect the code verb table votes (an unknown verb reads as a program).
function codeEffect(
  facts: CommandFacts,
): "read" | "modify" | "delete" | "send_out" | "run_program" {
  return facts.commandEffect === "unknown" ? "run_program" : facts.commandEffect;
}

/**
 * Whether a scope reads as inside the workspace (or pathless/scratch).
 *
 * @param facts - The command's deterministic facts.
 * @returns True when the scope is inside the workspace, pathless, or scratch.
 */
export function insideScope(facts: CommandFacts): boolean {
  return (
    facts.pathScope === "inside" || facts.pathScope === "none" || facts.pathScope === "scratch"
  );
}

function base(facts: CommandFacts): FactRuling {
  const credential = facts.sensitivePathName || facts.secretVariable || facts.headerToken;
  const effect = codeEffect(facts);

  // A socket path in an argument or a redirect is a network write the code
  // cannot rate — `/dev/tcp` and `/dev/udp` are shell sockets, not files. With
  // credential material it is irreversible exfiltration, so it blocks; alone it
  // is unproven, because no anchor proves where the data goes.
  if (facts.socketRedirection) {
    return credential
      ? { tier: "block", concept: "credential_exposure" }
      : { tier: "unproven", concept: "other_action" };
  }
  // Credential material read into the record is irreversible exposure.
  if (credential && effect === "read") return { tier: "block", concept: "credential_exposure" };
  // Publishing an artifact or dumping the environment is irreversible.
  if (facts.publishesArtifact) return { tier: "block", concept: "artifact_publish" };
  if (facts.dumpsEnvironment) return { tier: "block", concept: "environment_dump" };
  // A loop with no bound the code can see spawns without bound: the record
  // cannot show how many processes it creates. Unproven outranks a releasable
  // `guard`, so an unbounded loop never releases on an anchor — even when it
  // also carries credential material.
  if (facts.unboundedSpawn) return { tier: "unproven", concept: "resource_exhaustion" };
  // Modifying or sending credential material.
  if (credential && (effect === "modify" || effect === "send_out")) {
    return { tier: "guard", concept: "credential_egress" };
  }
  if (effect === "delete") {
    if (facts.namedBuildOutput) return { tier: "free", concept: "regenerable_output" };
    if (facts.pathScope === "unknown" || (facts.recursive && facts.pathScope === "outside")) {
      return { tier: "block", concept: "unbounded_deletion" };
    }
    return { tier: "guard", concept: "ordinary_deletion" };
  }
  if (effect === "read") {
    if (facts.network === "restricted")
      return { tier: "guard", concept: "restricted_network_read" };
    if (facts.publicSystemPath) return { tier: "free", concept: "public_system_read" };
    if (facts.pathScope === "outside" || facts.pathScope === "unknown") {
      return { tier: "guard", concept: "outside_workspace_read" };
    }
    return { tier: "free", concept: "other_read" };
  }
  // A raw copy of credential material through `dd`: the tool's own
  // `if=`/`of=` semantics are not read, so a copy that reaches a credential
  // is exposure regardless of which operand named it.
  if (facts.rawCopy && credential) return { tier: "block", concept: "credential_exposure" };
  // A raw device copy.
  if (facts.rawCopy) return { tier: "guard", concept: "device_overwrite" };
  if (effect === "modify" && insideScope(facts)) {
    return { tier: "plain", concept: "workspace_modification" };
  }
  // A modification whose target the code cannot resolve (`> $TARGET`): the
  // scope is unproven, so an anchor does not release it either.
  if (effect === "modify" && facts.pathScope === "unknown") {
    return { tier: "unproven", concept: "other_action" };
  }
  // A run or a send the code has not positively established as bounded: the
  // code cannot show what runs or where data goes. An anchor names the
  // request, so it does not release an unproven action — this is the tier
  // that asks even on a named request.
  if (effect === "run_program" || effect === "send_out") {
    return { tier: "unproven", concept: "other_action" };
  }
  return { tier: "guard", concept: "other_action" };
}

// A fact that lifts any non-`block` base to the `escalator` tier.
function escalator(facts: CommandFacts): PolicyConcept | undefined {
  if (facts.sendsData) return "data_egress";
  // An auth header whose value the record cannot read is data leaving in an
  // unreadable form: the same `data_egress` lift, never a credential claim.
  if (facts.authHeaderExpansion) return "data_egress";
  if (facts.installsPersistence) return "persistence_install";
  if (facts.rewritesHistory) return "history_rewrite";
  if (facts.allInterfaces) return "outward_listener";
  return undefined;
}

/**
 * The deterministic base tier for a command.
 *
 * @param facts - The command's deterministic facts.
 * @returns The base tier and the concept that carries it.
 */
export function factTier(facts: CommandFacts): FactRuling {
  const baseRuling = base(facts);
  if (baseRuling.tier === "block") return baseRuling;
  const lift = escalator(facts);
  return lift === undefined ? baseRuling : { tier: "escalator", concept: lift };
}
