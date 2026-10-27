/**
 * Mode-table direct tests: the ladder's single-sourced operational facts —
 * the derived cycle membership, the emphasized value, the generated cycle
 * description, and the config surprise warnings. Everything here must be
 * DERIVED from the table; a hand-placed duplicate anywhere else in the
 * codebase is a drift bug this file exists to catch.
 */

import { describe, expect, it } from "vitest";

import { BUILTIN_MODE_VALUES } from "#src/config/config-schema.ts";
import {
  CYCLE_DESCRIPTION,
  CYCLE_MODE_VALUES,
  MODE_TABLE,
  modeWarnings,
} from "#src/config/mode-table.ts";

describe("MODE_TABLE", () => {
  it("covers every mode value exactly once, in ladder order", () => {
    expect(Object.keys(MODE_TABLE)).toEqual([...BUILTIN_MODE_VALUES]);
  });

  it("never maps machinery failures to allow in any mode", () => {
    for (const mode of BUILTIN_MODE_VALUES) {
      expect(MODE_TABLE[mode].onReviewFailure).not.toBe("allow");
    }
  });
});

describe("derived cycle facts", () => {
  it("the casual cycle visits default then auto, in ladder order", () => {
    expect(CYCLE_MODE_VALUES).toEqual(["default", "auto"]);
  });

  it("the cycle description is generated from the cycle values", () => {
    expect(CYCLE_DESCRIPTION).toBe("default → auto");
  });

  it("the casual cycle never includes strict (the fail-closed automation rung)", () => {
    expect(CYCLE_MODE_VALUES).not.toContain("strict");
    // auto joined the cycle by operator choice — the red footer
    // emphasis is the guardrail that makes the stop visible.
  });
});

describe("modeWarnings", () => {
  const breakerDefer = { consecutive: 3, total: 20, verdict: "defer" as const };
  const base = {
    provider: "p",
    model: "m",
    modelType: "chat" as const,
    fallbacks: [],
    reasoning: "off" as const,
    timeoutMs: 15000,
    maxTokens: 4096,
    transcript: { maxUserMessages: 5, maxToolCalls: 10, maxCharsPerEntry: 1000 },
    surfaces: ["bash"],
    instructions: null,
    classifier: {
      confidenceThreshold: 0.5,
    },
    cache: { maxEntries: 128 },
    notifyLevel: "info" as const,
    notifyApprovals: false,
    customMode: null,
  };

  it("warns on the two extremes combined with a breaker forced to defer", () => {
    for (const mode of ["strict", "auto"] as const) {
      const config = {
        ...base,
        mode,
        circuitBreaker: breakerDefer,
      };
      const warnings = modeWarnings(config, MODE_TABLE[config.mode].cuts);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.path).toBe("mode");
      expect(warnings[0]!.message).toContain(`mode "${mode}"`);
      expect(warnings[0]!.message).toContain("circuitBreaker.verdict");
    }
  });

  it("stays silent otherwise", () => {
    for (const mode of BUILTIN_MODE_VALUES) {
      const config = {
        ...base,
        mode,
        circuitBreaker: { consecutive: 3, total: 20, verdict: "deny" as const },
      };
      expect(modeWarnings(config, MODE_TABLE[config.mode].cuts)).toEqual([]);
    }
    expect(
      modeWarnings(
        {
          ...base,
          mode: "default",
          circuitBreaker: breakerDefer,
        },
        MODE_TABLE.default.cuts,
      ),
    ).toEqual([]);
  });
});
