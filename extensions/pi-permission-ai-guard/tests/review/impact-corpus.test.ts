import { describe, expect, it } from "vitest";

import {
  ALL_IMPACT,
  CLASS_EXPECTATION,
  EXISTING_IMPACT,
  IMPACT_GROUPS,
  impactIssues,
  KNOWN_SCREEN_GAPS,
  type ImpactClass,
} from "#scripts/review-corpus-impact.ts";
import { AB_GROUPS } from "#scripts/review-corpus.ts";
import type { Mode } from "#src/config/config-schema.ts";
import { screenCommand } from "#src/review/screen/screen.ts";
import { applyVerdictMode } from "#src/review/verdict-rule.ts";

const MODES: Mode[] = ["strict", "default", "auto"];
const existing = AB_GROUPS.flatMap((g) => g.cases);
const impact = IMPACT_GROUPS.flatMap((g) => g.cases);
const all = [...existing, ...impact];

const runClass = (cls: ImpactClass, mode: Mode): string => {
  switch (cls) {
    case "harmless":
      return applyVerdictMode(mode, { kind: "allow" }).kind;
    case "likely_fine":
      return applyVerdictMode(mode, { kind: "defer" }, { kind: "model-defer", lean: "allow" }).kind;
    case "unclear":
      return applyVerdictMode(mode, { kind: "defer" }, { kind: "model-defer" }).kind;
    case "needs_human":
      return applyVerdictMode(mode, { kind: "deny", reason: "r" }).kind;
    case "screen_only":
      return applyVerdictMode(mode, { kind: "deny", reason: "r" }, undefined, "screen").kind;
  }
};

describe("impact corpus", () => {
  it("judges every existing case and nothing else", () => {
    expect(Object.keys(EXISTING_IMPACT).toSorted()).toEqual(existing.map((c) => c.id).toSorted());
  });

  it("has unique ids across the legacy corpus and the impact groups", () => {
    const ids = all.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every impact record internally consistent", () => {
    const problems = Object.entries(ALL_IMPACT).flatMap(([id, i]) =>
      impactIssues(i).map((p) => `${id}: ${p}`),
    );
    expect(problems).toEqual([]);
  });

  it("derives each class's outcome from the real mode mapping", () => {
    for (const cls of Object.keys(CLASS_EXPECTATION) as ImpactClass[]) {
      for (const mode of MODES) {
        expect(runClass(cls, mode), `${cls}/${mode}`).toBe(CLASS_EXPECTATION[cls].byMode[mode]);
      }
    }
  });

  it("sends a case to the screen exactly when its impact is screen_only, bar the known gaps", () => {
    const mismatches = all
      .filter(
        (c) =>
          (screenCommand(c.command).kind === "deny") !== (ALL_IMPACT[c.id]?.cls === "screen_only"),
      )
      .map((c) => c.id);
    expect(mismatches.toSorted()).toEqual(Object.keys(KNOWN_SCREEN_GAPS).toSorted());
  });
});
