/**
 * Deterministic command facts: what a command text demonstrably does, read from the
 * shell AST and the working directory alone — no model, no subprocess, no network.
 *
 * Every fact fails toward the conservative side. A word the walker cannot read, a
 * command it cannot parse, or a construct that hides what runs (`eval`, `$CMD`)
 * widens the path scope to `unknown` and the network class to `restricted`; the
 * decision table treats both as "not provably safe". A fact that raises scrutiny
 * (`publishesArtifact`, `dumpsEnvironment`, ...) is only set on positive evidence.
 */
import {
  credentialReadings,
  historyRewrites,
  listensOnAllInterfaces,
  maxEffect,
  networkOf,
  publishingCommands,
  scanEffects,
} from "./command-facts/effect.ts";
import { freeExitReading, removalFlagsUnknown, routineReading } from "./command-facts/free-exit.ts";
import {
  PUBLIC_SYSTEM_PATH,
  PathResolver,
  SENSITIVE_PATH,
  scanPaths,
  widestScope,
} from "./command-facts/scope.ts";
import { SOCKET_PATH, collectText } from "./command-facts/syntax.ts";
import type { Collected, CommandFacts, FactsContext } from "./command-facts/types.ts";

export type {
  CommandEffect,
  CommandFacts,
  FactsContext,
  NetworkAccess,
  PathScope,
} from "./command-facts/types.ts";

/**
 * Read the deterministic facts of a command text. This is the only orchestration
 * entry: it reads the invocations once per concern, in dependency order, and
 * assembles the record explicitly. Each reading lives in the module that owns
 * its rules — verbs and network in `effect.ts`, paths in `scope.ts`, the closed
 * build-output shape in `free-exit.ts`.
 *
 * @param command - The shell command text.
 * @param ctx - The working directory and (injectable) filesystem lookups.
 * @returns The facts; unparsable or opaque text yields conservative path and network facts.
 */
export function readCommandFacts(command: string, ctx: FactsContext): CommandFacts {
  const out: Collected = {
    invocations: [],
    opaque: false,
    parsed: true,
    socket: false,
    background: false,
    loop: false,
    unboundedLoop: false,
  };
  collectText(command, out, 0);
  const invs = out.invocations;
  const unresolved = out.opaque || !out.parsed;
  const routine = unresolved ? "none" : routineReading(command, invs, ctx);
  const resolver = new PathResolver(ctx);
  const paths = scanPaths(invs);
  const effects = scanEffects(invs, unresolved);
  const all = [...paths.reads, ...paths.writes];
  const settled = widestScope(all, resolver, paths.cdSeen, unresolved ? "unknown" : "none");
  // A deletion whose flags the closed shape cannot spell may reach further than
  // its paths show (`--one-file-system` changes which filesystem the removal
  // stays on): without a provable scope the row 5 block decides.
  const scope =
    removalFlagsUnknown(invs) && effects.commandEffect === "delete" ? "unknown" : settled;
  const credentials = credentialReadings(command, invs, out.opaque);
  const network = networkOf(invs, unresolved);
  // A secret handed to a network command is data sent out, not data read.
  const commandEffect =
    credentials.secretVariable && network !== "none"
      ? maxEffect(effects.commandEffect, "send_out")
      : effects.commandEffect;

  return {
    parsed: out.parsed,
    pathScope: scope,
    namedBuildOutput:
      !out.opaque &&
      freeExitReading({ invs, reads: paths.reads, resolver, scope, cdSeen: paths.cdSeen }),
    recursive: effects.recursive,
    publishesArtifact: publishingCommands(invs),
    sensitivePathName: all.some((a) => SENSITIVE_PATH.test(a.text)),
    publicSystemPath:
      paths.reads.length > 0 &&
      paths.writes.length === 0 &&
      paths.reads.every((a) => PUBLIC_SYSTEM_PATH.test(a.text)),
    rewritesHistory: historyRewrites(invs),
    rawCopy: effects.rawCopy,
    allInterfaces: listensOnAllInterfaces(invs),
    network,
    dumpsEnvironment: effects.dumpsEnvironment,
    installsPersistence: paths.persistence,
    grantsBeyondOwner: paths.grants,
    sendsData: effects.sendsData,
    commandEffect,
    secretVariable: credentials.secretVariable,
    headerToken: credentials.headerToken,
    authHeaderExpansion: credentials.authHeaderExpansion,
    routineDevCommand: routine !== "none",
    socketRedirection: out.socket || invs.some((i) => i.args.some((a) => SOCKET_PATH.test(a.text))),
    unboundedSpawn: out.unboundedLoop || (out.background && out.loop),
  };
}
