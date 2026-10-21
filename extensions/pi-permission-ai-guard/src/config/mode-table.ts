/**
 * The mode ladder — the single source of truth for every OPERATIONAL fact
 * about a mode value: the suspicion cut lines (imported by verdict-rule), the
 * casual-cycle membership, the warning-red emphasis, and the
 * config-surprise warnings (imported by config-layer).
 *
 * Deliberate exceptions live OUTSIDE the table: the Mode union itself
 * (config-schema — it is the config contract), and the curated human prose
 * in README/GLOSSARY and the JSON schema description (different readers —
 * generated prose would serve them worse). Those stay hand-edited; the
 * config-surface drift test pins the mechanical pairs.
 */

import type { VerdictOrigin } from "#src/model/model-verdict.ts";

import { MODE_VALUES, type AiGuardConfig, type Mode } from "./config-schema.ts";

/**
 * The reviewer-suspicion order — the total order the ladder is drawn on,
 * strictest last (ADR 0002). A `defer`'s rank is set by its lean (benign /
 * none / danger); a `deny`'s by its tier. Machinery failures are NOT on
 * this line: they are a separate axis (a failure to obtain a verdict, not a
 * suspicion), carried by each mode's `onReviewFailure` lane. A danger-leaned
 * defer sits above a soft deny: the `auto` mode rejects at that rung, so a
 * danger confirmation never auto-flows into an allow there.
 */
export const SUSPICION_ORDER = [
  "allow",
  "defer-benign",
  "defer-neutral",
  "defer-danger",
  "soft-deny",
  "hard-deny",
] as const;

export type Suspicion = (typeof SUSPICION_ORDER)[number];

/**
 * A suspicion rung's rank (higher = more suspicious).
 *
 * @param suspicion - A rung of the suspicion order.
 * @returns Its index in {@link SUSPICION_ORDER}.
 */
export function suspicionRank(suspicion: Suspicion): number {
  return SUSPICION_ORDER.indexOf(suspicion);
}

/**
 * Which band a mode's cuts put a rung in — the ladder's one geometry, used
 * by the verdict mapping and by the ask-band derivation below, so the
 * mapping and its own invariants cannot disagree.
 *
 * @param cuts - The mode's two cut lines.
 * @param suspicion - The rung to place.
 * @returns `allow` at or below the accept line, `deny` at or above the
 *   reject line, `ask` between them (allow wins when the lines cross).
 */
export function suspicionBand(cuts: ModeCuts, suspicion: Suspicion): "allow" | "ask" | "deny" {
  const rank = suspicionRank(suspicion);
  if (rank <= suspicionRank(cuts.allowThrough)) return "allow";
  return rank >= suspicionRank(cuts.denyFrom) ? "deny" : "ask";
}

/**
 * A mode's two cut lines on the suspicion order: at or below the accept
 * line the mode auto-allows; at or above the reject line it auto-denies;
 * between them it asks (defers). The cut-line shape makes each mode's
 * allow / ask / deny bands contiguous (pinned by the contiguity test).
 */
export interface ModeCuts {
  /** At or below this rung the mode auto-allows (inclusive). */
  allowThrough: Suspicion;
  /** At or above this rung the mode auto-denies (inclusive). */
  denyFrom: Suspicion;
}

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
export const MODE_TABLE: Record<Mode, ModeEntry> = {
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
 * reach).
 */
export const CYCLE_MODE_VALUES: readonly Mode[] = MODE_VALUES.filter(
  (m) => MODE_TABLE[m].facts.inCycle,
);

/**
 * The single emphasized value (renders in warning red), or undefined.
 *
 * Derived, not hand-set: a mode the casual cycle reaches that never asks is
 * the one an operator can land in without ever seeing a dialog, so the red
 * footer is the guardrail that keeps it visible. Today that is `auto`.
 */
export const EMPHASIZED_MODE: Mode | undefined = MODE_VALUES.find(
  (m) => MODE_TABLE[m].facts.inCycle && hasNoAskBand(MODE_TABLE[m].cuts),
);

/**
 * Each mode's one-line blurb, keyed by the mode name — the picker's
 * per-value descriptions ("strict — the reviewer's allow is the only
 * pass"). Derived from the table like the cycle subset, so the picker
 * labels cannot drift from the modes they describe.
 */
export const MODE_BLURBS: Readonly<Record<string, string>> = Object.fromEntries(
  MODE_VALUES.map((m) => [m, MODE_TABLE[m].facts.blurb]),
);

/** The generated shortcut description's cycle part ("default → auto"). */
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
 * Whether a mode's cuts leave no ask band at all: the accept line touches
 * or passes the reject line, so no rung lands between them. `strict` and
 * `auto` are such modes by construction, and a hand-configured one can be
 * too.
 *
 * @param cuts - The mode's two cut lines.
 * @returns True when every rung maps to allow or deny, never to ask.
 */
function hasNoAskBand(cuts: ModeCuts): boolean {
  return SUSPICION_ORDER.every((s) => suspicionBand(cuts, s) !== "ask");
}

/**
 * The config surprise warnings: an ask-free mode paired with a breaker
 * verdict of `defer`, where the breaker can interrupt the human (the
 * reviewer-untrusted escape valve) — legal but worth surfacing. Owned by the
 * ladder module: the generic JSONC layer should not carry ladder semantics.
 *
 * @param config - The validated config.
 * @param cuts - The effective mode's cut lines, defaulting to the built-in
 *   table's row (the loader passes nothing; a custom mode passes its own).
 * @returns Warning issues, if any (path is always "mode").
 */
export function modeWarnings(
  config: AiGuardConfig,
  cuts: ModeCuts = MODE_TABLE[config.mode].cuts,
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
