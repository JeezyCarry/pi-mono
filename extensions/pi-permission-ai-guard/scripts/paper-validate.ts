/**
 * Free paper validation over the design corpus (212).
 * No model calls: ideal effect/target readings + real `readCommandFacts` +
 * real `decideClassifierVerdict` + real `applyVerdictMode`, compared with
 * impact expectations in all four modes. There is exactly one decision
 * table (in `src/review/axes/verdict.ts`); this script holds none.
 *
 * `npx tsx scripts/paper-validate.ts [--perturb]`
 *
 * `--perturb` additionally swaps each axis reading against every alternative
 * label and reports flips to unsafe-allow (single-axis misread analysis).
 */

import {
  decideClassifierVerdict,
  type ClassifierAnswers,
  type EffectReading,
  type TargetReading,
} from "#src/review/axes/verdict.ts";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "#src/review/confidence-floor.ts";
import { screenCommand } from "#src/review/screen/screen.ts";
import { applyVerdictMode } from "#src/review/verdict-rule.ts";

import { DESIGN_CASES, IDEAL_CONFIDENCE, factsFor, idealReadings } from "./lib/ideal-run.ts";
import { FORBIDS } from "./lib/review-labels.ts";
import { ALL_IMPACT, CLASS_EXPECTATION, KNOWN_SCREEN_GAPS } from "./review-corpus-impact.ts";

type Mode = "strict" | "default" | "lenient" | "permissive";
const MODES: Mode[] = ["strict", "default", "lenient", "permissive"];

// id -> "effect target intent". Effect: read | modify | delete | send_out |
// run_program | cannot_determine. Target: ordinary_files | credential_material |
// vcs_history | system_or_service | none | cannot_determine. Intent:
// requested | not_requested | cannot_determine | absent (no anchor — the
// verdict layer takes the no-anchor column and never asks the model).
// Translated 1:1 from the 4-axis expectations (the old r|m|d|s|x + p|k|v|y|n
// space is retired with the 5-axis table it served).

// Signed 2026-10-16 (scheme A): these 12 cases carry an
// escalating fact (rewritesHistory / sendsData / persistence / allInterfaces,
// each verified by `readCommandFacts`) behind a naming anchor. Their impact
// records stay `harmless` (what happens is reversible and named); only the
// mode expectation maps to defer-lean-deny, per the approved escalator
// policy (`requested && !escalated → allow`; escalated still asks).
const ESCALATED_HARMLESS: ReadonlySet<string> = new Set([
  "irrev-near-git-restore",
  "parity-git-checkout-intent",
  "expose-explicit-0000-intent",
  "vcs-amend-asked",
  "g-rebase-asked",
  "g-reset-soft-asked",
  "pe-cron-asked",
  "o-rsync-asked",
  "o-webhook-asked",
  "bs-git-hook-asked",
  "bs-crontab-asked",
  "bs-bashrc-asked",
]);

const variant = "v3-prod";

type Verdict = { kind: "allow" } | { kind: "defer"; lean?: "allow" | "deny" } | { kind: "deny" };

/**
 * Run one case through the PRODUCTION decision path: ideal readings as
 * calibrated answers (confidence 0.9, well above the 0.5 floor) + real
 * `readCommandFacts` + real `decideClassifierVerdict`. Per-case overrides
 * for the rows the label map cannot express: `ban-push-forbidden` answers
 * `ban=forbids`; the two `h-undet-*` cases answer the unestablished branch
 * the map's vocabulary has no word for (same mechanism as FORBIDS).
 *
 * @param effect - The ideal action reading.
 * @param target - The ideal target-kind reading.
 * @param command - The command text (real facts).
 * @param anchor - Whether the record carries a trusted anchor.
 * @param requested - Whether the anchor names this action.
 * @param banOverride - `forbids` / `unestablished` for the ban row, else `none`.
 * @param effectOverride - `cannot_determine` for the unreadable row, else the map label.
 * @returns The production outcome and row id.
 */
function productionVerdict(
  effect: EffectReading,
  target: TargetReading,
  command: string,
  anchor: boolean,
  requested: boolean,
  banOverride?: "forbids" | "unestablished",
  effectOverride?: "cannot_determine",
): { outcome: Verdict; rowId: string } {
  const facts = factsFor(command);
  const answers: ClassifierAnswers = {
    ban: banOverride ?? "none",
    banConfidence: IDEAL_CONFIDENCE,
    effect: effectOverride ?? effect,
    effectConfidence: IDEAL_CONFIDENCE,
    target,
    intent: !anchor ? "absent" : requested ? "requested" : "not_requested",
    intentConfidence: !anchor ? Number.NaN : IDEAL_CONFIDENCE,
  };
  const { outcome, rowId } = decideClassifierVerdict(
    { answers, facts, hasAnchor: anchor },
    { confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD },
    0,
  );
  const kind = outcome.verdict.kind;
  if (kind === "allow") return { outcome: { kind: "allow" }, rowId };
  if (kind === "deny") return { outcome: { kind: "deny" }, rowId };
  return { outcome: { kind: "defer", lean: outcome.lean ?? undefined }, rowId };
}

function project(mode: Mode, v: Verdict, screen: boolean): string {
  if (screen)
    return applyVerdictMode(mode, { kind: "deny", reason: "r" }, undefined, "screen").kind;
  if (v.kind === "allow") return applyVerdictMode(mode, { kind: "allow" }).kind;
  if (v.kind === "deny") return applyVerdictMode(mode, { kind: "deny", reason: "r" }).kind;
  return applyVerdictMode(mode, { kind: "defer" }, { kind: "model-defer", lean: v.lean }).kind;
}
const cases = DESIGN_CASES;
let ok = 0;
let total = 0;
const bad: string[] = [];
const unsafe: string[] = [];
for (const c of cases) {
  const imp = ALL_IMPACT[c.id]!;
  const readings = idealReadings(c.id);
  if (!readings) {
    console.log("NO LABEL", c.id);
    continue;
  }
  const [e, t] = readings;
  const anchor = Boolean(c.intent?.length || c.injection);
  const requested = anchor && imp.fit === "requested";
  const screen = screenCommand(c.command).kind === "deny" && !(c.id in KNOWN_SCREEN_GAPS);
  const banOverride = FORBIDS.has(c.id) ? ("forbids" as const) : undefined;
  const { outcome: verdict, rowId } = productionVerdict(
    e,
    t,
    c.command,
    anchor,
    requested,
    banOverride,
  );
  // Scheme A: escalated-harmless cases expect the defer projection.
  const cls = ESCALATED_HARMLESS.has(c.id) ? "needs_human" : imp.cls;
  const exp = CLASS_EXPECTATION[cls].byMode;
  const got = Object.fromEntries(MODES.map((m) => [m, project(m, verdict, screen)])) as Record<
    Mode,
    string
  >;
  total++;
  const same = MODES.every((m) => got[m] === exp[m]);
  if (same) ok++;
  else {
    bad.push(
      `${c.id.padEnd(34)} ${imp.cls.padEnd(11)} exp ${MODES.map((m) => exp[m][0]).join("")} got ${MODES.map((m) => got[m][0]).join("")}  row=${rowId} ${readings.join(" ")}${anchor ? (requested ? " req" : " notreq") : " noanchor"} | ${c.command.slice(0, 60)}`,
    );
    if (MODES.some((m) => got[m] === "allow" && exp[m] !== "allow")) unsafe.push(c.id);
  }
}
console.log(
  `variant ${variant}: ${ok}/${total} match all four modes; unsafe allow (got allow, expected not): ${unsafe.length}`,
);
if (unsafe.length) console.log("UNSAFE:", unsafe.join(", "));
console.log(bad.join("\n"));

if (process.argv.includes("--perturb")) {
  const EFFECTS: EffectReading[] = ["read", "modify", "delete", "send_out", "run_program"];
  const TARGETS: TargetReading[] = [
    "ordinary_files",
    "credential_material",
    "vcs_history",
    "system_or_service",
    "none",
  ];
  const verdictFor = (
    command: string,
    e: EffectReading,
    t: TargetReading,
    anchor: boolean,
    requested: boolean,
  ): Verdict => productionVerdict(e, t, command, anchor, requested).outcome;
  let single = 0;
  let intentOnly = 0;
  let robust = 0;
  const fragile: string[] = [];
  const intentFragile: string[] = [];
  let considered = 0;
  for (const c of cases) {
    const imp = ALL_IMPACT[c.id]!;
    const readings = idealReadings(c.id);
    if (!readings || FORBIDS.has(c.id)) continue;
    if (screenCommand(c.command).kind === "deny" && !(c.id in KNOWN_SCREEN_GAPS)) continue;
    const exp = CLASS_EXPECTATION[imp.cls].byMode;
    if (MODES.every((m) => exp[m] === "allow")) continue;
    considered++;
    const [e0, t0] = readings;
    const anchor = Boolean(c.intent?.length || c.injection);
    const requested = anchor && imp.fit === "requested";
    const unsafeWith = (e: EffectReading, t: TargetReading, req: boolean): boolean => {
      const v = verdictFor(c.command, e, t, anchor, req);
      return MODES.some((m) => project(m, v, false) === "allow" && exp[m] !== "allow");
    };
    const misread: string[] = [];
    for (const e of EFFECTS)
      if (e !== e0 && unsafeWith(e, t0, requested)) misread.push(`effect=${e}`);
    for (const t of TARGETS)
      if (t !== t0 && unsafeWith(e0, t, requested)) misread.push(`target=${t}`);
    // Dual-condition: requested=true with a misread target. Only cases
    // already requested count — flipping requested itself is the intent
    // axis's finding, not the target axis's. This catches "target misread
    // + named request releases the guard" (live h-fetch-metadata-service
    // shape): block rows are immune by construction, guard rows are not.
    if (requested) {
      for (const t of TARGETS) {
        if (t !== t0 && unsafeWith(e0, t, true)) misread.push(`target=${t}+requested`);
      }
    }
    if (misread.length) {
      single++;
      fragile.push(
        `${c.id.padEnd(34)} ${readings.join(" ")} ${misread.join(" ")} | ${c.command.slice(0, 50)}`,
      );
    } else robust++;
    if (anchor && !requested && unsafeWith(e0, t0, true)) {
      intentOnly++;
      intentFragile.push(c.id);
    }
  }
  console.log(`\nperturbation over ${considered} non-allow cases (screen/ban excluded):`);
  console.log(`  robust to any single-axis misread: ${robust}`);
  console.log(`  a single-axis misread yields an unsafe allow: ${single}`);
  console.log(`  intent misread as requested yields an unsafe allow: ${intentOnly}`);
  console.log("\nmodel-dependent (single-axis):\n" + fragile.join("\n"));
  console.log("\nintent-dependent: " + intentFragile.join(", "));
}
