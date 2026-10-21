/**
 * Verdict-mode direct tests: the full mode × verdict mapping table and
 * the human-facing message constructors. The mapping lives in one module;
 * this table pins it densely — a semantic change to any cell is a
 * one-line failure here, before it reaches the pipeline's wiring tests.
 *
 * The ladder (strictest first): hard-tier denies (only the screen's) are
 * terminal in EVERY mode. Every model deny is soft and, with the model's
 * own uncertainty, maps per mode; machinery failures never map to allow.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { MODE_VALUES, type Mode } from "#src/config/config-schema.ts";
import { MODE_TABLE, suspicionRank } from "#src/config/mode-table.ts";
import { GENERIC_DENY_REASON } from "#src/model/model-verdict.ts";
import {
  escalationMessage,
  failOpenNotice,
  withAgentInstruction,
} from "#src/review/verdict-copy.ts";
import {
  type DenyAuthority,
  type ModelDeferInfo,
  applyVerdictMode,
  denyTier,
  machineryTarget,
  resolveMapping,
} from "#src/review/verdict-rule.ts";
import { OPERATOR_COPY_SHAPE } from "#test/operator-copy.ts";

type Row = [
  policy: Mode,
  verdict: AuthorizerVerdict,
  modelDefer: ModelDeferInfo | undefined,
  authority: DenyAuthority | undefined,
  expected: AuthorizerVerdict,
];

const DENY = { kind: "deny", reason: "secrets in the command" } as const;
const ALLOW = { kind: "allow" } as const;
const MODEL_DEFER = { kind: "defer" } as const;
const MODEL_DEFER_WITH_REASON: ModelDeferInfo = {
  kind: "model-defer",
  reason: "which file does this target?",
};

/** A deny that must carry a teaching reason — content unpinned, presence pinned. */
const DENY_WITH_REASON = { kind: "deny", reason: expect.any(String) } as const;

describe("applyVerdictMode — mapping table", () => {
  it.each<Row>([
    // Allow is never transformed, in any mode.
    ...MODE_VALUES.map((m) => [m, ALLOW, undefined, undefined, ALLOW] as Row),

    // A screen deny is terminal in every mode.
    ...MODE_VALUES.map((m) => [m, DENY, undefined, "screen", DENY] as Row),

    // Model denies are soft and map down the ladder — default and lenient ask
    // (the resting mode forwards every flag to the human), and permissive
    // DENIES: it has no ask path for a danger confirmation, so a flagged
    // screen is never rubber-stamped there.
    ...(
      [
        { mode: "strict", expected: DENY },
        { mode: "default", expected: { kind: "defer" } },
        { mode: "lenient", expected: { kind: "defer" } },
        { mode: "permissive", expected: DENY },
      ] as const
    ).map(({ mode, expected }) => [mode, DENY, undefined, "model", expected] as Row),

    // The model's own uncertainty (model-defer): strict denies it, carrying
    // the clarification request as the teaching reason; default asks;
    // lenient/permissive pass.
    [
      "strict",
      MODEL_DEFER,
      MODEL_DEFER_WITH_REASON,
      undefined,
      {
        kind: "deny",
        reason: "which file does this target?",
      },
    ],
    ["default", MODEL_DEFER, MODEL_DEFER_WITH_REASON, undefined, { kind: "defer" }],
    // A neutral (lean-less) doubt now asks in lenient too: lenient's accept
    // line moved from defer-neutral to defer-benign, so only a benign-leaned
    // doubt auto-passes there.
    ["lenient", MODEL_DEFER, MODEL_DEFER_WITH_REASON, undefined, { kind: "defer" }],
    ["permissive", MODEL_DEFER, MODEL_DEFER_WITH_REASON, undefined, { kind: "allow" }],

    // The lean split: benign-leaned doubts pass in lenient but ASK in
    // default (an unresolved verdict always keeps an ask path — the
    // intent question must be able to reach the authorizer); deny at
    // strict (a lean is not an allow); danger-leaned doubts ask everywhere
    // below strict (lenient's auto-pass breaks); permissive is ask-free, so
    // its lean decides between allow and deny.
    ...(
      [
        {
          lean: "allow",
          expected: {
            strict: { kind: "deny", reason: "which file does this target?" },
            default: { kind: "defer" },
            lenient: ALLOW,
            permissive: ALLOW,
          } as const,
        },
        {
          lean: "deny",
          expected: {
            strict: { kind: "deny", reason: "which file does this target?" },
            default: { kind: "defer" },
            lenient: { kind: "defer" },
            permissive: { kind: "deny", reason: "which file does this target?" },
          } as const,
        },
      ] as const
    ).flatMap(({ lean, expected }) =>
      MODE_VALUES.map(
        (m) =>
          [m, MODEL_DEFER, { ...MODEL_DEFER_WITH_REASON, lean }, undefined, expected[m]] as Row,
      ),
    ),

    // A model defer without a clarification request: strict denies with
    // the generic uncertainty reason.
    ["strict", MODEL_DEFER, { kind: "model-defer" }, undefined, DENY_WITH_REASON],

    // Machinery failures never map to allow: deny under the two extremes
    // (strict: fail closed; permissive: a broken reviewer must not
    // rubber-stamp), defer otherwise.
    ...[
      {
        mode: "strict",
        expected: DENY_WITH_REASON,
      },
      { mode: "default", expected: { kind: "defer" } },
      { mode: "lenient", expected: { kind: "defer" } },
      {
        mode: "permissive",
        expected: DENY_WITH_REASON,
      },
    ].map(
      ({ mode, expected }) => [mode, MODEL_DEFER, { kind: "no-json" }, undefined, expected] as Row,
    ),

    // A machinery defer without a classified kind: "unknown", denied under
    // the extremes.
    ["strict", MODEL_DEFER, undefined, undefined, DENY_WITH_REASON],
    ["default", MODEL_DEFER, undefined, undefined, { kind: "defer" }],
    ["permissive", MODEL_DEFER, undefined, undefined, DENY_WITH_REASON],
  ])(
    "%s × %j (deferKind %j, authority %j) → %j",
    (policy, verdict, modelDefer, authority, expected) => {
      expect(applyVerdictMode(policy, verdict, modelDefer, authority)).toEqual(expected);
    },
  );
});

describe("denyTier", () => {
  it("makes only the screen hard", () => {
    expect(denyTier("screen")).toBe("hard");
    expect(denyTier("model")).toBe("soft");
  });
});

describe("model deny authority invariant", () => {
  it("never hard-denies a model deny in default or lenient, whatever its text", () => {
    for (const mode of ["default", "lenient"] as const) {
      expect(applyVerdictMode(mode, DENY, undefined, "model")).toEqual({ kind: "defer" });
      expect(applyVerdictMode(mode, DENY)).toEqual({ kind: "defer" });
    }
  });

  it("keeps the screen's deny a deny in every mode", () => {
    for (const mode of MODE_VALUES) {
      expect(applyVerdictMode(mode, DENY, undefined, "screen").kind).toBe("deny");
    }
  });
});

describe("machineryTarget", () => {
  it("denies under the two extremes and defers otherwise, never allowing", () => {
    expect(machineryTarget("strict")).toBe("deny");
    expect(machineryTarget("permissive")).toBe("deny");
    expect(machineryTarget("default")).toBe("defer");
    expect(machineryTarget("lenient")).toBe("defer");
  });
});

it("routes a confirm-defer by the mode's defer-danger band", () => {
  // The danger rows' confirm exit: lean deny puts it on defer-danger, so
  // strict denies (fail-closed), default and lenient ask, and permissive —
  // which has no ask path for danger — denies. No mode reaches allow from the
  // classifier's own danger rows; the permissive deny is the mode's ladder,
  // never the classifier's judgment.
  const confirm: ModelDeferInfo = { kind: "model-defer", lean: "deny" };
  const exits = MODE_VALUES.map(
    (mode) => [mode, applyVerdictMode(mode, { kind: "defer" }, confirm).kind] as const,
  );
  expect(Object.fromEntries(exits)).toEqual({
    strict: "deny",
    default: "defer",
    lenient: "defer",
    permissive: "deny",
  });
});

describe("the ladder's structural invariant — contiguous bands in suspicion order", () => {
  // The danger rows sit on this order: a hard deny stays terminal in every
  // mode, while a confirm-defer (lean deny) asks in default and lenient,
  // denies in strict, and allows in permissive.
  // The suspicion order: allow < defer+lean:allow < defer neutral <
  // defer+lean:deny < soft deny < hard deny. Each mode's mapping must be
  // three CONTIGUOUS bands (allow / ask / deny) on this line — a special
  // case that fragments the bands (e.g. allow → ask → allow) is a
  // structural break, not a tweak. Pinned so future lane edits that cut a
  // band apart fail here instead of shipping.
  const rank = { allow: 0, defer: 1, deny: 2 } as const;

  // The six verdict states in suspicion order — shared by the band
  // contiguity and the ask-path invariant (the last two, model and screen
  // deny, differ only in authority).
  const SUSPICION_ORDER_INPUTS: Array<
    [AuthorizerVerdict, ModelDeferInfo | undefined, DenyAuthority | undefined]
  > = [
    [{ kind: "allow" }, undefined, undefined],
    [{ kind: "defer" }, { kind: "model-defer", lean: "allow" }, undefined],
    [{ kind: "defer" }, { kind: "model-defer" }, undefined],
    [{ kind: "defer" }, { kind: "model-defer", lean: "deny" }, undefined],
    [{ kind: "deny", reason: "x" }, undefined, "model"],
    [{ kind: "deny", reason: "x" }, undefined, "screen"],
  ];

  function bandSequence(mode: Mode): number[] {
    return SUSPICION_ORDER_INPUTS.map(
      ([verdict, modelDefer, authority]) =>
        rank[applyVerdictMode(mode, verdict, modelDefer, authority).kind],
    );
  }

  it.each(MODE_VALUES)("%s's outputs are three contiguous bands", (mode) => {
    const seq = bandSequence(mode);
    // Contiguity = the distinct bands, in first-appearance order, are
    // monotonically increasing — a band never REAPPEARS after a stricter
    // one appeared (allow → ask → allow fragments the ladder; allow →
    // deny straight is fine — the ask cut just sits outside this mode's
    // range). The assertion names the sequence on failure.
    const distinct: number[] = [];
    for (const band of seq) {
      if (distinct[distinct.length - 1] !== band) distinct.push(band);
    }
    expect(
      distinct.every((b, i) => i === 0 || b > distinct[i - 1]!),
      `${mode}: band sequence ${seq.join(" → ")}`,
    ).toBe(true);
  });

  it("every mode's accept line sits below its reject line", () => {
    // A tie or inversion silently merges a band to the allow side (allow
    // wins ties in applyVerdictMode), failing open. The contiguity test
    // cannot see it — a merged band is still contiguous.
    for (const mode of MODE_VALUES) {
      const { acceptAtOrBelow, rejectAtOrAbove } = MODE_TABLE[mode].cuts;
      expect(
        suspicionRank(acceptAtOrBelow),
        `${mode}: accept ${acceptAtOrBelow} must sit below reject ${rejectAtOrAbove}`,
      ).toBeLessThan(suspicionRank(rejectAtOrAbove));
    }
  });

  it("every unresolved verdict keeps an ask path in at least one mode", () => {
    // The intent-check invariant: a defer (any lean) and a soft deny are
    // UNRESOLVED judgments — each must ask the human in at least one
    // mode, so the intent question can always reach the authorizer.
    // Only decisive verdicts (allow, hard deny) may bypass every ask.
    const unresolved = SUSPICION_ORDER_INPUTS.slice(1, 5);
    for (const [verdict, modelDefer, authority] of unresolved) {
      const asks = MODE_VALUES.some(
        (m) => applyVerdictMode(m, verdict, modelDefer, authority).kind === "defer",
      );
      expect(asks, `${JSON.stringify(verdict)} lean=${modelDefer?.lean ?? "none"}`).toBe(true);
    }
  });
});

describe("resolveMapping — the mapping consequence rule", () => {
  const SOFT = { kind: "deny", reason: "unsafe" } as const;
  const HARD = { kind: "deny", reason: "unsafe" } as const;
  const DEFER_V = { kind: "defer" } as const;
  const ALLOW_V = { kind: "allow" } as const;

  it("a verdict that holds never annotates; a deny with a reason notifies its held copy", () => {
    const held = resolveMapping({
      original: SOFT,
      emitted: SOFT,
      riskLevel: "low",
      deferKind: undefined,
      deferReason: undefined,
      deferLean: undefined,
      mode: "default",
      noticeShown: false,
    });
    expect(held.annotate).toBe(false);
    expect(held.emittedReason).toBeUndefined();
    expect(held.markNoticeShown).toBe(false);
    expect(held.verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction(SOFT.reason, "content"),
    });
    const notice = held.notice!;
    expect(notice.level).toBe("warning");
    expect(notice.message).toContain("unsafe");
    expect(notice.message).toContain("risk low");
    expect(notice.message).toMatch(OPERATOR_COPY_SHAPE);
  });

  it("notifies a reason-less deny instead of falling through to the empty defer notice", () => {
    // The parser synthesizes a reason for every deny, so no current producer
    // reaches here without one — but a reason-less deny must not render nothing
    // at all: a silent deny is a deny the human never sees.
    const reasonless = { kind: "deny" } as unknown as AuthorizerVerdict;
    const denied = resolveMapping({
      original: reasonless,
      emitted: reasonless,
      riskLevel: "low",
      deferKind: undefined,
      deferReason: undefined,
      deferLean: undefined,
      mode: "default",
      noticeShown: false,
    });
    expect(denied.notice).toMatchObject({ level: "warning" });
    expect(denied.notice?.message).toContain(GENERIC_DENY_REASON);
  });

  it("an allow that holds is fully silent", () => {
    expect(
      resolveMapping({
        original: ALLOW_V,
        emitted: ALLOW_V,
        riskLevel: undefined,
        deferKind: undefined,
        deferReason: undefined,
        deferLean: undefined,
        mode: "lenient",
        noticeShown: false,
      }),
    ).toEqual({
      annotate: false,
      notice: null,
      verdict: ALLOW_V,
      markNoticeShown: false,
    });
  });

  it("a mapped defer annotates and notifies the ask tail", () => {
    const asked = resolveMapping({
      original: SOFT,
      emitted: DEFER_V,
      riskLevel: "low",
      deferKind: undefined,
      deferReason: undefined,
      deferLean: undefined,
      mode: "default",
      noticeShown: false,
    });
    expect(asked.annotate).toBe(true);
    expect(asked.emittedReason).toBeUndefined();
    const notice = asked.notice!;
    expect(notice.level).toBe("warning");
    expect(notice.message).toMatch(OPERATOR_COPY_SHAPE);
    // Same facts as a held deny, told with the ask outcome: comparing against
    // the copy builder pins the mapping without pinning the wording.
    expect(notice.message).toBe(
      escalationMessage({ kind: "deny", reason: "unsafe" }, "low", "asked"),
    );
    expect(notice.message).not.toBe(
      escalationMessage({ kind: "deny", reason: "unsafe" }, "low", "denied"),
    );
  });

  it("a defer→allow mapping marks the swallowed clarification and stays silent when benign-leaned", () => {
    const leaned = resolveMapping({
      original: DEFER_V,
      emitted: ALLOW,
      riskLevel: undefined,
      deferKind: undefined,
      deferReason: undefined,
      deferLean: "allow",
      mode: "lenient",
      noticeShown: false,
    });
    expect(leaned.annotate).toBe(true);
    expect(leaned.emittedReason).toBe("clarification-suppressed");
    expect(leaned.notice).toBeNull();
    expect(leaned.markNoticeShown).toBe(false);
  });

  it("a neutral defer→allow mapping fires the fail-open notice once and marks the state", () => {
    const neutral = resolveMapping({
      original: DEFER_V,
      emitted: ALLOW,
      riskLevel: undefined,
      deferKind: undefined,
      deferReason: undefined,
      deferLean: undefined,
      mode: "lenient",
      noticeShown: false,
    });
    expect(neutral.markNoticeShown).toBe(true);
    const notice = neutral.notice!;
    expect(notice.level).toBe("warning");
    expect(notice.message).toMatch(OPERATOR_COPY_SHAPE);
    // The copy builder pins the mapping without pinning the wording.
    expect(notice.message).toBe(failOpenNotice());
    // Already shown: silent, and the state is not re-marked.
    const again = resolveMapping({
      original: DEFER_V,
      emitted: ALLOW,
      riskLevel: undefined,
      deferKind: undefined,
      deferReason: undefined,
      deferLean: undefined,
      mode: "lenient",
      noticeShown: true,
    });
    expect(again.markNoticeShown).toBe(false);
    expect(again.notice).toBeNull();
  });

  it("a deny→allow mapping keeps the swallowed reason and fires the permissive fail-open copy", () => {
    const swallowed = resolveMapping({
      original: SOFT,
      emitted: ALLOW,
      riskLevel: "low",
      deferKind: undefined,
      deferReason: undefined,
      deferLean: undefined,
      mode: "permissive",
      noticeShown: false,
    });
    expect(swallowed.annotate).toBe(true);
    expect(swallowed.emittedReason).toBe("unsafe");
    const notice = swallowed.notice!;
    expect(notice.level).toBe("warning");
    expect(notice.message).toBe(failOpenNotice());
  });

  it("a defer→deny mapping records the synthesized teaching reason, never a suppressed marker", () => {
    const denied = resolveMapping({
      original: DEFER_V,
      emitted: { kind: "deny", reason: "needs the target" },
      riskLevel: undefined,
      deferKind: undefined,
      deferReason: undefined,
      deferLean: undefined,
      mode: "strict",
      noticeShown: false,
    });
    expect(denied.annotate).toBe(true);
    expect(denied.emittedReason).toBe("needs the target");
    expect(denied.notice).toBeNull();
  });

  it("a hard deny that holds notifies regardless of mode (the permissive lane is no carve-out)", () => {
    for (const mode of MODE_VALUES) {
      const held = resolveMapping({
        original: HARD,
        emitted: HARD,
        riskLevel: "critical",
        deferKind: undefined,
        deferReason: undefined,
        deferLean: undefined,
        mode,
        noticeShown: false,
      });
      expect(held.notice?.message).toContain("risk critical");
      expect(held.notice?.message).toMatch(OPERATOR_COPY_SHAPE);
    }
  });
});
