/**
 * The mode ladder — the single source of truth for every OPERATIONAL fact
 * about a BUILT-IN mode value: the suspicion cut lines, the casual-cycle
 * membership, and the config-surprise warnings (imported by config-layer).
 * The geometry those rows are drawn on lives in `suspicion.ts`; a `custom`
 * mode has no row here (its cuts come from the config, resolved by
 * `mode-policy.ts`).
 *
 * Deliberate exceptions live OUTSIDE the table: the Mode union itself
 * (config-schema — it is the config contract), and the curated human prose
 * in README/GLOSSARY and the JSON schema description (different readers —
 * generated prose would serve them worse). Those stay hand-edited; the
 * config-surface drift test pins the mechanical pairs.
 */

import type { VerdictOrigin } from "#src/model/model-verdict.ts";

import { BUILTIN_MODE_VALUES, type AiGuardConfig, type BuiltinMode } from "./config-schema.ts";
import { type ModeCuts, hasNoAskBand } from "./suspicion.ts";

/** Per-mode operational facts for the settings/UX surfaces. */
export interface ModeFacts {
  /** One-line what-this-mode-changes blurb (completion labels, docs seed). */
  blurb: string;
  /**
   * Whether the ctrl+alt+g casual cycle visits this mode. Hand-set, not
   * derived: `strict` is ask-free too, and only operator choice keeps the
   * full fail-closed automation rung out of casual reach.
   */
  inCycle: boolean;
}

/** One mode's row in the ladder table. */
export interface ModeEntry {
  cuts: ModeCuts;
  /**
   * How a review that produced no verdict is disposed of — narrower by type
   * than the cuts: a broken reviewer never maps to allow. The `auto` value
   * tightens back to `deny` — the ladder's one non-monotone cell, contract
   * over monotonicity: a defer would need a dialog the zero-interruption
   * contract forbids, and a broken reviewer must not rubber-stamp.
   */
  onReviewFailure: VerdictOrigin;
  /** The operational facts for the settings/UX surfaces. */
  facts: ModeFacts;
}

/**
 * The ladder table, strictest first.
 *
 * The defer lane splits by lean — the reviewer's directional inclination
 * on an unresolved request. Doctrine: lean only moves a defer across the
 * ask/allow boundary, in the lean's own direction. `default` asks on every
 * unresolved doubt AND every soft deny, so an unresolved verdict always
 * keeps an ask path somewhere in the ladder: a neutral doubt reaches the
 * authorizer, and a deny-leaning doubt — an active alarm — reaches the
 * human too. The deny band is reachable only by decisive (hard-tier) denies
 * in `default`; `strict` is lean-inert (its contract is absolute) while
 * `auto` is ask-free (the lean decides between allow and deny) — `auto`
 * allows only the benign and neutral doubts, so a danger
 * confirmation asks nowhere: it has no ask path for danger, and a
 * danger-leaned defer DENIES there rather than allowing (the F-GAP closure).
 * Read down any column and the three bands (allow / ask / deny) are
 * contiguous in suspicion order — here that follows from the cut-line shape:
 * each row is two cut lines on {@link SUSPICION_ORDER}, and the contiguity
 * test pins it.
 */
export const MODE_TABLE: Record<BuiltinMode, ModeEntry> = {
  strict: {
    cuts: { allowThrough: "allow", denyFrom: "defer-benign" },
    onReviewFailure: "deny",
    facts: {
      blurb: "the reviewer's allow is the only pass",
      inCycle: false,
    },
  },
  default: {
    cuts: { allowThrough: "allow", denyFrom: "hard-deny" },
    onReviewFailure: "defer",
    facts: {
      blurb: "you judge every flag but hard danger",
      inCycle: true,
    },
  },
  auto: {
    cuts: { allowThrough: "defer-neutral", denyFrom: "defer-danger" },
    onReviewFailure: "deny",
    facts: {
      blurb: "benign and neutral doubts pass; danger and denials block",
      // In the casual cycle by operator choice: the red footer emphasis is
      // the guardrail — the mode is visible the moment it lands. Only
      // strict (full fail-closed automation) stays explicit.
      inCycle: true,
    },
  },
};

/**
 * The casual ctrl+alt+g cycle, derived from the table's inCycle flags in
 * ladder order (default → auto; the red footer makes the auto stop visible
 * — only strict, the full fail-closed automation rung, stays out of casual
 * reach). A configured `custom` mode joins last via `cycleValues`
 * (mode-policy.ts), never here: the table owns built-in rows only.
 */
export const CYCLE_MODE_VALUES: readonly BuiltinMode[] = BUILTIN_MODE_VALUES.filter(
  (m) => MODE_TABLE[m].facts.inCycle,
);

/**
 * The `custom` row's blurb. It has no table row (its cuts come from the
 * config), so its one line lives here, next to the rows it is described
 * alongside in the picker.
 */
const CUSTOM_MODE_BLURB = "your own two cut lines, set in customMode";

/**
 * Each mode's one-line blurb, keyed by the mode name — the picker's
 * per-value descriptions ("strict — the reviewer's allow is the only
 * pass"). Derived from the table like the cycle subset, so the picker
 * labels cannot drift from the modes they describe.
 */
export const MODE_BLURBS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(BUILTIN_MODE_VALUES.map((m) => [m, MODE_TABLE[m].facts.blurb])),
  custom: CUSTOM_MODE_BLURB,
};

/**
 * The generated shortcut description's cycle part ("default → auto") — the
 * built-in stops. The live rotation may append a configured `custom` last;
 * the description names the suffix ("+ custom when configured") for that.
 */
export const CYCLE_DESCRIPTION = CYCLE_MODE_VALUES.join(" → ");

/**
 * A ladder-owned config surprise warning. Deliberately NOT the loader's
 * `ConfigIssue` — importing it here would create a type-level edge back
 * into the consuming layer (the loader imports the ladder, never the
 * reverse); the shape is structurally compatible.
 */
export interface ModeWarning {
  /** The offending config field (always "mode"). */
  path: "mode";
  /** The surprise, in operator language. */
  message: string;
}

/**
 * The config surprise warnings: an ask-free mode paired with a breaker
 * verdict of `defer`, where the breaker can interrupt the human (the
 * reviewer-untrusted escape valve) — legal but worth surfacing. Owned by the
 * ladder module: the generic JSONC layer should not carry ladder semantics.
 *
 * @param config - The validated config (only `mode` and `circuitBreaker` are read).
 * @param cuts - The effective mode's cut lines: the built-in row's, or the
 *   resolved custom pair's. Always explicit — the ladder never guesses
 *   which cuts a mode name means.
 * @returns Warning issues, if any (path is always "mode").
 */
export function modeWarnings(
  config: Pick<AiGuardConfig, "mode" | "circuitBreaker">,
  cuts: ModeCuts,
): ModeWarning[] {
  if (hasNoAskBand(cuts) && config.circuitBreaker.verdict === "defer") {
    return [
      {
        path: "mode",
        message: `mode "${config.mode}" + circuitBreaker.verdict "defer": the breaker interrupts the human when it trips (reviewer-untrusted escape valve).`,
      },
    ];
  }
  return [];
}
