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
 * strictest last (ADR 0003). A `defer`'s rank is set by its lean (benign /
 * none / danger); a `deny`'s by its tier. Machinery failures are NOT on
 * this line: they are a separate axis (a failure to obtain a verdict, not a
 * suspicion), carried by each mode's `machinery` lane.
 */
export const SUSPICION_ORDER = [
  "allow",
  "defer-benign",
  "defer-neutral",
  "defer-danger",
  "soft-deny",
  "hard-deny",
] as const;

/** One rung of the suspicion order. */
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
 * A mode's two cut lines on the suspicion order: at or below the accept
 * line the mode auto-allows; at or above the reject line it auto-denies;
 * between them it asks (defers). The cut-line shape makes each mode's
 * allow / ask / deny bands contiguous (pinned by the contiguity test).
 */
export interface ModeCuts {
  /** Suspicion ranks at or below this are auto-allowed. */
  acceptAtOrBelow: Suspicion;
  /** Suspicion ranks at or above this are auto-denied. */
  rejectAtOrAbove: Suspicion;
}

/** Per-mode operational facts for the settings/UX surfaces. */
export interface ModeFacts {
  /** One-line what-this-mode-changes blurb (completion labels, docs seed). */
  blurb: string;
  /** Whether the ctrl+alt+g casual cycle visits this mode. */
  inCycle: boolean;
  /** Whether the footer renders this value in warning red (command surfaces stay plain). */
  emphasize: boolean;
}

/** One mode's row in the ladder table. */
export interface ModeEntry {
  /** The two cut lines on the suspicion order (the allow / ask / deny bands). */
  cuts: ModeCuts;
  /**
   * The machinery-failure lane — narrower by type than the cuts: a broken
   * reviewer never maps to allow. The `permissive` value tightens back to
   * `deny` — the ladder's one non-monotone cell, contract over
   * monotonicity: a defer would need a dialog the zero-interruption
   * contract forbids, and a broken reviewer must not rubber-stamp.
   */
  machinery: VerdictOrigin;
  /** The operational facts for the settings/UX surfaces. */
  facts: ModeFacts;
}

/**
 * The ladder table, strictest first.
 *
 * The defer lane splits by lean — the reviewer's directional inclination
 * on an unresolved request. Doctrine: lean only moves a defer across the
 * ask/allow boundary, in the lean's own direction — lenient passes the
 * benign and neutral doubts (the reviewer already ran the full screen and
 * found nothing dangerous, only an authorization link it cannot see),
 * while its deny-leaning doubts still ask (a deny-leaning doubt is an
 * active alarm, and the mode's blurb promises exactly those ask). default
 * asks on every unresolved doubt AND every soft deny — an unresolved
 * verdict always keeps an ask path somewhere in the ladder, so the intent
 * question (the one thing the model structurally cannot see) can always
 * reach the authorizer. The deny band is reachable only by decisive
 * (hard-tier) denies; strict and permissive are lean-inert (their
 * contracts are absolute). Read down any column and the three bands
 * (allow / ask / deny) are contiguous in suspicion order — here that
 * follows from the cut-line shape: each row is two cut lines on
 * {@link SUSPICION_ORDER}, and the contiguity test pins it.
 */
export const MODE_TABLE: Record<Mode, ModeEntry> = {
  strict: {
    cuts: { acceptAtOrBelow: "allow", rejectAtOrAbove: "defer-benign" },
    machinery: "deny",
    facts: {
      blurb: "the reviewer's allow is the only pass",
      inCycle: false,
      emphasize: false,
    },
  },
  default: {
    cuts: { acceptAtOrBelow: "allow", rejectAtOrAbove: "hard-deny" },
    machinery: "defer",
    facts: {
      blurb: "you judge every flag but hard danger",
      inCycle: true,
      emphasize: false,
    },
  },
  lenient: {
    cuts: { acceptAtOrBelow: "defer-neutral", rejectAtOrAbove: "hard-deny" },
    machinery: "defer",
    facts: {
      blurb: "only the reviewer's active alarms ask you",
      inCycle: true,
      emphasize: false,
    },
  },
  permissive: {
    cuts: { acceptAtOrBelow: "soft-deny", rejectAtOrAbove: "hard-deny" },
    machinery: "deny",
    facts: {
      blurb: "only clear high-danger requests are blocked",
      // In the casual cycle by operator choice (4-mode ladder): the red
      // footer emphasis is the guardrail — the mode is visible the moment
      // it lands. Only strict (full fail-closed automation) stays
      // explicit.
      inCycle: true,
      emphasize: true,
    },
  },
};

/**
 * The casual ctrl+alt+g cycle, derived from the table's inCycle flags in
 * ladder order (default → lenient → permissive; the red footer makes the
 * permissive stop visible — only strict, the full fail-closed automation
 * rung, stays out of casual reach).
 */
export const CYCLE_MODE_VALUES: readonly Mode[] = MODE_VALUES.filter(
  (m) => MODE_TABLE[m].facts.inCycle,
);

/** The single emphasized value (renders in warning red), or undefined. */
export const EMPHASIZED_MODE: Mode | undefined = MODE_VALUES.find(
  (m) => MODE_TABLE[m].facts.emphasize,
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

/** The generated shortcut description's cycle part ("default → lenient → permissive"). */
export const CYCLE_DESCRIPTION = CYCLE_MODE_VALUES.join(" → ");

/**
 * A ladder-owned config surprise warning. Deliberately NOT the loader's
 * `ConfigIssue` — importing it here would create a type-level edge back
 * into the consuming layer (the loader imports the ladder, never the
 * reverse); the shape is structurally compatible.
 */
export interface ModeWarning {
  /** The offending config field ("mode"). */
  path: "mode";
  /** The surprise, in operator language. */
  message: string;
}

/**
 * The config surprise warnings: mode × breaker-verdict combinations where
 * the breaker can interrupt the human (the reviewer-untrusted escape
 * valve) — legal but worth surfacing. Owned by the ladder module: the
 * generic JSONC layer should not carry ladder semantics.
 *
 * @param config - The validated config.
 * @returns Warning issues, if any (path is always "mode").
 */
export function modeWarnings(config: AiGuardConfig): ModeWarning[] {
  if (
    (config.mode === "strict" || config.mode === "permissive") &&
    config.circuitBreaker.verdict === "defer"
  ) {
    return [
      {
        path: "mode",
        message: `mode "${config.mode}" + circuitBreaker.verdict "defer": the breaker interrupts the human when it trips (reviewer-untrusted escape valve).`,
      },
    ];
  }
  return [];
}
