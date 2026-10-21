/**
 * End-to-end matrix for the chat lane's protocol→policy path: a model JSON
 * verdict (the shape prompt.ts's Decision Order rows prescribe) goes through
 * the tolerant parser, then through the mode mapping, and the emitted kind
 * is pinned per row of the leniency ladder. This is the protocol/policy
 * contract, not model recognition: each case names the Decision Order line
 * it stands for.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { MODE_VALUES, type Mode } from "#src/config/config-schema.ts";
import { MODEL_DEFER_KIND } from "#src/model/machinery-kinds.ts";
import type { ReviewOutcome } from "#src/model/model-verdict.ts";
import { parseVerdictObject } from "#src/review/engines/chat/verdict-parser.ts";
import { applyVerdictMode, type ModelDeferInfo } from "#src/review/verdict-rule.ts";

type Kind = AuthorizerVerdict["kind"];

/** The per-mode emitted kind, one entry per ladder mode. */
type ModeKinds = Readonly<Record<Mode, Kind>>;

/**
 * The ModelDeferInfo the pipeline hands the mapping for a fresh model defer.
 *
 * @param outcome - The parsed review outcome.
 * @returns The defer routing facts, or undefined when the outcome is not a defer.
 */
function deferInfoOf(outcome: ReviewOutcome): ModelDeferInfo | undefined {
  if (outcome.verdict.kind !== "defer") return undefined;
  return { kind: outcome.deferKind, reason: outcome.deferReason, lean: outcome.lean };
}

/**
 * Parse-then-map, returning the emitted kind per ladder mode. The caller
 * asserts; keeping the expectations in the test body satisfies the
 * expect-expect rule and keeps the per-mode message local.
 *
 * @param outcome - The parsed review outcome.
 * @returns The emitted verdict kind for each mode.
 */
function emitPerMode(outcome: ReviewOutcome): ModeKinds {
  const modelDefer = deferInfoOf(outcome);
  const emitted = {} as Record<Mode, Kind>;
  for (const mode of MODE_VALUES) {
    emitted[mode] = applyVerdictMode(mode, outcome.verdict, modelDefer).kind;
  }
  return emitted;
}

/** A model deny is soft whatever its riskLevel: default and lenient ask the human. */
const MODEL_DENY_LADDER: ModeKinds = {
  strict: "deny",
  default: "defer",
  lenient: "defer",
  permissive: "deny",
};
/** The danger defer lane: permissive has no ask path for danger, so it denies. */
const DANGER_DEFER_LADDER: ModeKinds = {
  strict: "deny",
  default: "defer",
  lenient: "defer",
  permissive: "deny",
};
/** Allow is never transformed on any rung. */
const ALLOW_LADDER: ModeKinds = {
  strict: "allow",
  default: "allow",
  lenient: "allow",
  permissive: "allow",
};
/** The neutral defer: permissive auto-passes a benign/neutral doubt. */
const NEUTRAL_DEFER_LADDER: ModeKinds = {
  strict: "deny",
  default: "defer",
  lenient: "defer",
  permissive: "allow",
};

describe("A — ban wall / block boundary / uncovered duty deny → soft tier (a model never hard-denies)", () => {
  // Decision Order: "A still-effective human ban → deny (critical)"; an
  // established block-boundary hit → deny (critical); a duty hit the anchor
  // clearly leaves uncovered → deny (critical). All three are the same
  // protocol shape: a deny carrying a teaching reason and riskLevel critical.
  const parsed = parseVerdictObject(
    {
      verdict: "deny",
      reason: "a still-effective human ban forbids this action",
      riskLevel: "critical",
    },
    100,
  );

  it("parses to a deny carrying the reason and the critical risk level", () => {
    expect(parsed.verdict).toEqual({
      kind: "deny",
      reason: "a still-effective human ban forbids this action",
    });
    expect(parsed.riskLevel).toBe("critical");
  });

  it("denies in strict and permissive, asks in default and lenient", () => {
    for (const [mode, kind] of Object.entries(emitPerMode(parsed)) as Array<[Mode, Kind]>) {
      expect(kind, `${mode} must map a model deny by the soft ladder`).toBe(
        MODEL_DENY_LADDER[mode],
      );
    }
  });
});

describe("B — unestablished safety facts / costly-consequence confirms / duty with lean deny → the danger defer lane", () => {
  // Decision Order: "Safety facts the record cannot establish → defer with
  // lean 'deny'"; Sensitive-Data Egress and Sole-Copy Loss confirms → defer
  // with lean 'deny'; a lower duty hit (covered or left unestablished) →
  // defer with lean 'deny'. One protocol shape, one ladder row.
  const DANGER_DEFERRALS = [
    {
      name: "safety facts the record cannot establish",
      output: {
        verdict: "defer",
        reason: "whether this mutates local state cannot be established",
        lean: "deny",
      },
    },
    {
      name: "an established Sensitive-Data Egress consequence",
      output: {
        verdict: "defer",
        reason: "credentials would leave this machine (Sensitive-Data Egress)",
        lean: "deny",
      },
    },
    {
      name: "an established Sole-Copy Loss consequence",
      output: {
        verdict: "defer",
        reason: "no other copy of this data exists (Sole-Copy Loss)",
        lean: "deny",
      },
    },
    {
      name: "a duty hit the anchor covers or leaves unestablished",
      output: {
        verdict: "defer",
        reason: "an automatic start the anchor explicitly covers (Persistent System Changes)",
        lean: "deny",
      },
    },
  ] as const;

  it.each(DANGER_DEFERRALS)("$name parses to a deny-leaned model defer", ({ output }) => {
    const parsed = parseVerdictObject(output, 100);
    expect(parsed.verdict).toEqual({ kind: "defer" });
    expect(parsed.deferKind).toBe(MODEL_DEFER_KIND);
    expect(parsed.lean).toBe("deny");
  });

  it.each(DANGER_DEFERRALS)(
    "$name asks in default and lenient, denies in strict and permissive",
    ({ output }) => {
      const emitted = emitPerMode(parseVerdictObject(output, 100));
      for (const [mode, kind] of Object.entries(emitted) as Array<[Mode, Kind]>) {
        // Permissive has no ask path for danger: a danger confirmation denies
        // there rather than auto-passing.
        expect(kind, `${mode} must map a deny-leaned defer to deny`).toBe(
          DANGER_DEFER_LADDER[mode],
        );
      }
    },
  );
});

describe("C — CWD read-only inspection / anchor-covered ordinary action → allow, untransformed", () => {
  // Decision Order: "Established read-only inspection confined to the working
  // directory → allow with no anchor needed"; "any other established action
  // the anchor covers → allow".
  const ALLOW_OUTPUTS = [
    {
      name: "read-only inspection confined to the working directory",
      output: { verdict: "allow", reason: "listing the project directory" },
    },
    {
      name: "an ordinary action the anchor covers",
      output: { verdict: "allow", reason: "the active task asks for this edit" },
    },
  ] as const;

  it.each(ALLOW_OUTPUTS)("$name parses to a bare allow", ({ output }) => {
    expect(parseVerdictObject(output, 100).verdict).toEqual({ kind: "allow" });
  });

  it.each(ALLOW_OUTPUTS)("$name passes every mode", ({ output }) => {
    const emitted = emitPerMode(parseVerdictObject(output, 100));
    for (const [mode, kind] of Object.entries(emitted) as Array<[Mode, Kind]>) {
      expect(kind, `${mode} must pass an allow unchanged`).toBe(ALLOW_LADDER[mode]);
    }
  });
});

describe("D — ordinary established action the anchor leaves uncovered → neutral defer", () => {
  // Decision Order: "Any other established action: the anchor covers it →
  // allow; otherwise → defer with no lean." No lean is the neutral doubt.
  const parsed = parseVerdictObject(
    {
      verdict: "defer",
      reason: "deleting build output is not covered by any request (is that in scope?)",
    },
    100,
  );

  it("parses to a neutral model defer (no lean)", () => {
    expect(parsed.verdict).toEqual({ kind: "defer" });
    expect(parsed.deferKind).toBe(MODEL_DEFER_KIND);
    expect(parsed.lean).toBeUndefined();
  });

  it("denies in strict, asks in default and lenient, passes in permissive", () => {
    const emitted = emitPerMode(parsed);
    for (const [mode, kind] of Object.entries(emitted) as Array<[Mode, Kind]>) {
      expect(kind, `${mode} must map a neutral defer to its ladder row`).toBe(
        NEUTRAL_DEFER_LADDER[mode],
      );
    }
  });
});
