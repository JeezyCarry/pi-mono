/**
 * Read-only alignment diff: runs the 212-case design corpus through BOTH the
 * current classifier decision (`decideClassifierVerdict`) and
 * the new shared core (`factTier` + `classifierClaims` -> `decidePolicy`), and
 * reports every case where the two disagree in kind or lean.
 *
 * No model calls, no writes. This is the evidence used to decide whether the
 * shared core reproduces the current policy, and where the intended
 * divergences ("Where the core differs" in `docs/policy.md`) land.
 *
 * NOTE: this compares against the current classifier **with ideal axis
 * labels**, and compares only `kind` and `lean`. It does not exercise a real
 * model, the confidence channel (all labels are 0.9), the trusted-anchor gate
 * from a real transcript, the full screen->facts->lane->mode chain, the new
 * concepts, or tier equality (the concept-table consistency test covers that).
 * It is not a wiring acceptance test.
 *
 * The `unproven` movements are the **intended policy change** (`docs/policy.md`
 * Part II, "Release proof"): a run/send the code cannot establish as bounded now asks
 * even on a named anchor. They are reported separately from any other
 * difference, which must be zero.
 *
 * Npx tsx scripts/alignment-diff.ts
 */

import { decideClassifierVerdict } from "#src/review/axes/verdict.ts";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "#src/review/confidence-floor.ts";
import { classifierClaims } from "#src/review/policy/classifier-claims.ts";
import { decidePolicy } from "#src/review/policy/decide.ts";
import { factTier } from "#src/review/policy/fact-tier.ts";
import { screenCommand } from "#src/review/screen/screen.ts";

import { DESIGN_CASES, IDEAL_CONFIDENCE, factsFor, idealReadings } from "./lib/ideal-run.ts";
import { FORBIDS } from "./lib/review-labels.ts";
import { ALL_IMPACT } from "./review-corpus-impact.ts";

// NOTE: the ideal-label assembly below matches `paper-validate` except for
// two deliberate differences: the shared core takes an explicit
// `targetConfidence` (the old table never reads above the floor, so the value
// is load-free there), and `h-`-prefixed cases count as requested without an
// anchor (a legacy holdout convention for the headless-shape cases).

// `kind` and `kind/lean`: the two fields `alignment-diff` compares.
function key(kind: string, lean?: string | null): string {
  return `${kind}${lean ? "/" + lean : ""}`;
}

const cases = DESIGN_CASES;
let same = 0;
const diffs: string[] = [];

for (const c of cases) {
  const readings = idealReadings(c.id);
  if (!readings) continue;
  const [effect, target] = readings;
  const imp = ALL_IMPACT[c.id];
  const anchor =
    "anchor" in c
      ? Boolean(c.anchor)
      : Boolean(
          (c as { intent?: unknown; injection?: unknown }).intent ||
          (c as { injection?: unknown }).injection,
        );
  const requested = anchor && (c.id.startsWith("h-") ? true : imp?.fit === "requested");

  const facts = factsFor(c.command);

  const ban: "forbids" | "none" = FORBIDS.has(c.id) ? "forbids" : "none";
  const answers = {
    ban,
    banConfidence: IDEAL_CONFIDENCE,
    effect,
    effectConfidence: IDEAL_CONFIDENCE,
    target,
    intent: (!anchor ? "absent" : requested ? "requested" : "not_requested") as
      | "absent"
      | "requested"
      | "not_requested",
    intentConfidence: anchor ? IDEAL_CONFIDENCE : Number.NaN,
  };
  const current = decideClassifierVerdict(
    { answers, facts, hasAnchor: anchor },
    { confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD },
    0,
  );
  const curKind = current.outcome.verdict.kind;
  const curLean = curKind === "defer" ? (current.outcome.lean ?? undefined) : undefined;

  const claims = classifierClaims(
    {
      ban,
      banConfidence: IDEAL_CONFIDENCE,
      effect,
      effectConfidence: IDEAL_CONFIDENCE,
      target,
      targetConfidence: IDEAL_CONFIDENCE,
      intent: requested ? "requested" : anchor ? "not_requested" : "absent",
      intentConfidence: anchor ? IDEAL_CONFIDENCE : Number.NaN,
      hasAnchor: anchor,
    },
    facts,
  );
  const core = decidePolicy(
    {
      base: factTier(facts),
      claims,
      hasTrustedAnchor: anchor,
      laneUnresolved: false,
      completeness: "axes-are-mandatory",
    },
    { confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD, facts },
  );

  const screen = screenCommand(c.command).kind === "deny";
  if (key(curKind, curLean) === key(core.kind, core.lean)) {
    same++;
    continue;
  }
  diffs.push(
    [
      c.id.padEnd(28),
      `\`${c.command}\``.padEnd(46),
      `cur ${key(curKind, curLean).padEnd(11)} row=${current.rowId.padEnd(22)}`,
      `core ${key(core.kind, core.lean).padEnd(11)} by=${core.decidedBy}` +
        ` tier=${core.tier}${core.riskLevel ? "/" + core.riskLevel : ""}` +
        `${screen ? " SCREEN" : ""}`,
    ].join("  "),
  );
}

const unproven = diffs.filter((d) => d.includes("tier=unproven"));
const other = diffs.filter((d) => !d.includes("tier=unproven"));
console.log(
  `alignment diff: ${same}/${same + diffs.length} agree; ${unproven.length} intended unproven movements; ${other.length} other differ`,
);
if (other.length > 0) console.log(other.join("\n"));
if (unproven.length > 0) console.log("-- intended (unproven):\n" + unproven.join("\n"));
