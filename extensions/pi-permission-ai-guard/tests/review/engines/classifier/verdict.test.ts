import type { ClassifierAnswer } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { DANGER_NONE } from "#src/review/engines/classifier/questions.ts";
import {
  IncompleteClassifierResponseError,
  projectClassifierAnswers,
  riskLevelFromScore,
  synthesizeClassifierVerdict,
} from "#src/review/engines/classifier/verdict.ts";
import type {
  ClassifierAnswers,
  ClassifierThresholds,
} from "#src/review/engines/classifier/verdict.ts";
import {
  classifierCostlyReason,
  classifierDangerCriteria,
  classifierDangerNote,
  classifierIntentGapReason,
  classifierUncertainReason,
} from "#src/review/verdict-copy.ts";
import { denyTier } from "#src/review/verdict-rule.ts";

const THRESHOLDS: ClassifierThresholds = {
  intentThreshold: 0.5,
  riskThreshold: 0.5,
  confidenceThreshold: 0.6,
};

/**
 * A defer line names the gap, then asks in parentheses: the operator's only
 * channel (lean stays hidden, so the reason carries both halves).
 */
const DEFER_REASON_SHAPE = /^.+ \(.+\?\)$/;

function confident(overrides: Partial<ClassifierAnswers> = {}): ClassifierAnswers {
  return {
    dangerCategory: DANGER_NONE,
    dangerConfidence: 0.95,
    intentMatch: 0.9,
    riskScore: 0.1,
    riskConfidence: 0.9,
    ...overrides,
  };
}

describe("synthesizeClassifierVerdict", () => {
  it("allows when intent matches and risk is low, all confident", () => {
    const out = synthesizeClassifierVerdict(confident(), THRESHOLDS, 100);
    expect(out.verdict).toEqual({ kind: "allow" });
    expect(out.latencyMs).toBe(100);
  });

  it("hard-denies an unauthorized confident danger hit, naming the category", () => {
    // Matrix #3: nobody asked for it — terminal in every mode.
    const out = synthesizeClassifierVerdict(
      confident({ dangerCategory: "credential_exfiltration", intentMatch: 0.2 }),
      THRESHOLDS,
      42,
    );
    expect(out.verdict).toEqual({
      kind: "deny",
      reason: "matched a safety rule: credential exfiltration",
    });
    // Unknown categories fail safe to high.
    expect(out.riskLevel).toBe("high");
  });

  it("confirms an authorized confident danger hit instead of denying it", () => {
    // Matrix #2: the anchor names the action, so the operator rules on it —
    // the classifier never allows a danger hit; a permissive allow comes from
    // the mode's ladder, never the classifier's judgment.
    const out = synthesizeClassifierVerdict(
      confident({ dangerCategory: "credential_exfiltration" }),
      THRESHOLDS,
      42,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.lean).toBe("deny");
    // The category leads, so the review log attributes the defer to its lane.
    expect(out.deferReason).toMatch(/^matched a safety rule: credential exfiltration \(/);
    expect(out.riskLevel).toBe("high");
  });

  it("confirms a danger hit whose confidence is below the floor", () => {
    // Matrix #1: the model could not establish the hit, so the operator
    // settles it. The classifier holds no allow path on the danger rows; a
    // permissive allow comes from the mode's ladder, never the classifier's
    // judgment.
    const out = synthesizeClassifierVerdict(
      confident({ dangerCategory: "credential_exfiltration", dangerConfidence: 0.3 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.lean).toBe("deny");
    expect(out.deferReason).toMatch(/^matched a safety rule: credential exfiltration \(/);
    expect(out.riskLevel).toBe("high");
  });

  it("defers below the floor when no danger hit is present", () => {
    const out = synthesizeClassifierVerdict(confident({ dangerConfidence: 0.3 }), THRESHOLDS, 7);
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.deferReason).toMatch(DEFER_REASON_SHAPE);
  });

  it("renders every line from verdict-copy, never inline", () => {
    // The synthesis decides the shape; the words live in verdict-copy.
    // An inlined rewording breaks here, not in front of the operator.
    const danger = synthesizeClassifierVerdict(
      confident({
        dangerCategory: "secrets_credentials",
        dangerConfidence: 0.9,
        intentMatch: 0.1,
      }),
      THRESHOLDS,
      7,
    );
    expect(danger.verdict).toEqual({
      kind: "deny",
      reason: classifierDangerCriteria("secrets credentials"),
    });
    const confirm = synthesizeClassifierVerdict(
      confident({
        dangerCategory: "secrets_credentials",
        dangerConfidence: 0.9,
        intentMatch: 0.9,
      }),
      THRESHOLDS,
      7,
    );
    expect(confirm.deferReason).toBe(
      `${classifierDangerCriteria("secrets credentials")} (${classifierDangerNote(true)})`,
    );
    const unsure = synthesizeClassifierVerdict(confident({ dangerConfidence: 0.3 }), THRESHOLDS, 7);
    expect(unsure.deferReason).toBe(classifierUncertainReason(true));
    const costly = synthesizeClassifierVerdict(
      confident({ intentMatch: 0.9, riskScore: 0.8 }),
      THRESHOLDS,
      7,
    );
    expect(costly.deferReason).toBe(classifierCostlyReason());
    const gap = synthesizeClassifierVerdict(
      confident({ intentMatch: 0.1, riskScore: 0.1 }),
      THRESHOLDS,
      7,
    );
    expect(gap.deferReason).toBe(classifierIntentGapReason());
  });

  it("names the reading that fell short, not a fixed line", () => {
    // Both branches ask the same thing, so the gap is where the information is:
    // the line has to follow whichever confidence came in under the floor.
    const dangerShort = synthesizeClassifierVerdict(
      confident({ dangerConfidence: 0.3 }),
      THRESHOLDS,
      7,
    );
    const riskShort = synthesizeClassifierVerdict(
      confident({ riskConfidence: 0.2 }),
      THRESHOLDS,
      7,
    );
    expect(dangerShort.deferReason).not.toBe(riskShort.deferReason);
    expect(dangerShort.deferReason).toMatch(DEFER_REASON_SHAPE);
    expect(riskShort.deferReason).toMatch(DEFER_REASON_SHAPE);
  });

  it("keeps the hard deny when nothing authorizes the danger", () => {
    // The danger rows run before the intent/risk gate: a confident hit with
    // no authorization never reaches the DENY-Unless lane.
    const out = synthesizeClassifierVerdict(
      confident({ dangerCategory: "system_tampering", dangerConfidence: 0.99, intentMatch: 0.1 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({
      kind: "deny",
      reason: "matched a safety rule: system tampering",
    });
  });

  it("defers neutral when low confidence but no danger signal", () => {
    const out = synthesizeClassifierVerdict(
      confident({ riskConfidence: 0.1, intentMatch: 0.9 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.lean).toBeUndefined();
  });

  it("labels the deny by the band it landed in", () => {
    // riskLevel is a fixed rubric reading, independent of riskThreshold:
    // [0.5, 0.75) reads high, [0.75, 1) reads critical.
    const high = synthesizeClassifierVerdict(
      confident({ intentMatch: 0.2, riskScore: 0.6 }),
      THRESHOLDS,
      7,
    );
    expect(high.verdict.kind).toBe("deny");
    expect(high.riskLevel).toBe("high");
    const critical = synthesizeClassifierVerdict(
      confident({ intentMatch: 0.2, riskScore: 0.8 }),
      THRESHOLDS,
      7,
    );
    expect(critical.verdict.kind).toBe("deny");
    expect(critical.riskLevel).toBe("critical");
  });

  it("confirms at the risk bar when intent is established, denies when it is not", () => {
    // Matrix #5: the risk half is intent-aware — an authorized costly action
    // is a confirmation, an unauthorized one stays the generic deny.
    const authorized = synthesizeClassifierVerdict(confident({ riskScore: 0.6 }), THRESHOLDS, 7);
    expect(authorized.verdict).toEqual({ kind: "defer" });
    expect(authorized.lean).toBe("deny");
    const unauthorized = synthesizeClassifierVerdict(
      confident({ riskScore: 0.6, intentMatch: 0.2 }),
      THRESHOLDS,
      7,
    );
    expect(unauthorized.verdict.kind).toBe("deny");
  });

  it("cuts the risk bar at 0.5: 0.4 allows, 0.5 confirms when asked and denies when not", () => {
    expect(
      synthesizeClassifierVerdict(confident({ riskScore: 0.4 }), THRESHOLDS, 7).verdict,
    ).toEqual({
      kind: "allow",
    });
    expect(
      synthesizeClassifierVerdict(confident({ riskScore: 0.5 }), THRESHOLDS, 7).verdict.kind,
    ).toBe("defer");
    expect(
      synthesizeClassifierVerdict(confident({ riskScore: 0.5, intentMatch: 0.2 }), THRESHOLDS, 7)
        .verdict.kind,
    ).toBe("deny");
  });

  it("keeps every default-line risk deny inside the hard tier", () => {
    // riskLevelFromScore and denyTier jointly hold this: at the default 0.5
    // line a risk-lane deny always reads high/critical, so it blocks in
    // every mode. Either side moving alone breaks it — this fails first.
    for (const riskScore of [0.5, 0.6, 0.74]) {
      const out = synthesizeClassifierVerdict(
        confident({ riskScore, intentMatch: 0.2 }),
        THRESHOLDS,
        7,
      );
      expect(out.verdict.kind).toBe("deny");
      expect(denyTier(out.riskLevel)).toBe("hard");
    }
  });

  it("follows a raised risk line: 0.6 allows under a 0.7 line", () => {
    const raised = { ...THRESHOLDS, riskThreshold: 0.7 };
    expect(synthesizeClassifierVerdict(confident({ riskScore: 0.6 }), raised, 7).verdict).toEqual({
      kind: "allow",
    });
  });

  it("defers with an allow lean when intent falls short and risk is low", () => {
    // Matrix #7: the screen is clean, only the authorization link is
    // unclear — lenient allows, default asks.
    const out = synthesizeClassifierVerdict(
      confident({ intentMatch: 0.2, riskScore: 0.3 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.deferReason).toMatch(DEFER_REASON_SHAPE);
    expect(out.lean).toBe("allow");
  });

  it("defers with a deny lean when confidence is low but risk is over the line", () => {
    // Matrix #5: evidence of danger never leans allow — lenient asks.
    const out = synthesizeClassifierVerdict(
      {
        dangerCategory: DANGER_NONE,
        dangerConfidence: 0.9,
        intentMatch: 0.9,
        riskScore: 0.8,
        riskConfidence: 0.2,
      },
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.lean).toBe("deny");
  });

  it("defers neutral when confidence is low and risk is under the line", () => {
    // Matrix #6: an untrusted reading has no direction — lenient allows
    // with a fail-open notice, default asks.
    const out = synthesizeClassifierVerdict(
      {
        dangerCategory: DANGER_NONE,
        dangerConfidence: 0.2,
        intentMatch: 0.9,
        riskScore: 0.3,
        riskConfidence: 0.9,
      },
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.lean).toBeUndefined();
  });

  it("defers neutral on a low-confidence intent gap — untrusted readings lean nothing", () => {
    // Low intent alone does not lean allow when the readings are
    // untrusted: lenient allows with a fail-open notice, not silently.
    const out = synthesizeClassifierVerdict(
      {
        dangerCategory: DANGER_NONE,
        dangerConfidence: 0.2,
        intentMatch: 0.2,
        riskScore: 0.3,
        riskConfidence: 0.9,
      },
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.lean).toBeUndefined();
  });

  it("defers when the risk confidence is under the floor", () => {
    const out = synthesizeClassifierVerdict(confident({ riskConfidence: 0.2 }), THRESHOLDS, 7);
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferReason).toMatch(DEFER_REASON_SHAPE);
  });
});

describe("projectClassifierAnswers", () => {
  it("normalizes the 0–4 risk score to the 0–1 verdict scale", () => {
    const answers = projectClassifierAnswers({
      danger_category: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
      intent_match: { type: "bool", probability: 0.2 },
      risk: { type: "score", score: 3, confidence: 0.9 },
    });
    expect(answers.riskScore).toBe(0.75);
    // Raw 3 bottoms out in the critical band.
    const out = synthesizeClassifierVerdict(answers, THRESHOLDS, 1);
    expect(out.verdict.kind).toBe("deny");
    expect(out.riskLevel).toBe("critical");
  });

  it("maps the quartile bands independent of the threshold", () => {
    expect(riskLevelFromScore(0)).toBe("low");
    expect(riskLevelFromScore(0.24)).toBe("low");
    expect(riskLevelFromScore(0.25)).toBe("medium");
    expect(riskLevelFromScore(0.49)).toBe("medium");
    expect(riskLevelFromScore(0.5)).toBe("high");
    expect(riskLevelFromScore(0.74)).toBe("high");
    expect(riskLevelFromScore(0.75)).toBe("critical");
    expect(riskLevelFromScore(1)).toBe("critical");
  });

  it("throws on missing readings — never answered is malformed, not zero", () => {
    expect(() => projectClassifierAnswers({})).toThrow(IncompleteClassifierResponseError);
    expect(() =>
      projectClassifierAnswers({
        danger_category: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
        intent_match: { type: "bool", probability: 0.2 },
      }),
    ).toThrow(IncompleteClassifierResponseError);
    expect(() =>
      projectClassifierAnswers({
        danger_category: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
        intent_match: { type: "bool", probability: 0.2 },
        risk: { type: "score", confidence: 0.9 } as unknown as ClassifierAnswer,
      }),
    ).toThrow(IncompleteClassifierResponseError);
  });

  it("treats missing confidence as zero (uncertain), not malformed", () => {
    const answers = projectClassifierAnswers({
      danger_category: { type: "choice", choice: "none" } as unknown as ClassifierAnswer,
      intent_match: { type: "bool", probability: 0.9 },
      risk: { type: "score", score: 1 } as unknown as ClassifierAnswer,
    });
    expect(answers.dangerConfidence).toBe(0);
    expect(answers.riskConfidence).toBe(0);
    const out = synthesizeClassifierVerdict(answers, THRESHOLDS, 1);
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
  });
});
