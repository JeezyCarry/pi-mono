/**
 * Shared input scaffolding for the offline corpus runs (`paper-validate`,
 * `alignment-diff`): the fixed command-facts context, the case list, and the
 * ideal-label translation. Only inputs live here — each script keeps its own
 * judgment path, so a change to one check never rewrites the other's meaning.
 */

import type { EffectReading, TargetReading } from "#src/review/axes/verdict.ts";
import { readCommandFacts, type CommandFacts } from "#src/review/request/command-facts.ts";

import { IMPACT_GROUPS } from "../review-corpus-impact.ts";
import { AB_GROUPS, type AbCase } from "../review-corpus.ts";
import { LABELS } from "./review-labels.ts";

/** The corpus supplies the labels, so no ideal reading is uncertain. */
export const IDEAL_CONFIDENCE = 0.9;

const PKG_SCRIPTS = {
  test: "vitest run",
  build: "tsc -p .",
  lint: "oxlint src",
  dev: "vite",
  deploy: "./deploy.sh",
};

/** Both corpora, in one list: the legacy groups then the impact groups. */
export const DESIGN_CASES: readonly AbCase[] = [...AB_GROUPS, ...IMPACT_GROUPS].flatMap(
  (g) => g.cases,
);

const factsByCommand = new Map<string, CommandFacts>();

/**
 * Command facts for a corpus case, under the fixed offline context.
 *
 * @param command - The case's command text.
 * @returns The production facts, memoised per command (`--perturb` re-reads one case many times).
 */
export function factsFor(command: string): CommandFacts {
  const cached = factsByCommand.get(command);
  if (cached) return cached;
  const facts = readCommandFacts(command, {
    cwd: "/work/proj",
    home: "/home/u",
    realpath: () => null,
    declaredTasks: PKG_SCRIPTS,
  });
  factsByCommand.set(command, facts);
  return facts;
}

/**
 * The ideal axis readings a case's label states.
 *
 * @param id - The case id.
 * @returns `[effect, target]`, or undefined when the case carries no label.
 */
export function idealReadings(id: string): [EffectReading, TargetReading] | undefined {
  const label = LABELS[id];
  if (label === undefined) return undefined;
  return label.split(" ") as [EffectReading, TargetReading];
}
