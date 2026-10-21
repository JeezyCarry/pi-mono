/**
 * Mode-table direct tests: the ladder's single-sourced operational facts —
 * the derived cycle membership, the emphasized value, the generated cycle
 * description, and the config surprise warnings. Everything here must be
 * DERIVED from the table; a hand-placed duplicate anywhere else in the
 * codebase is a drift bug this file exists to catch.
 */

import { describe, expect, it } from "vitest";

import { MODE_VALUES } from "#src/config/config-schema.ts";
import {
  CYCLE_DESCRIPTION,
  CYCLE_MODE_VALUES,
  EMPHASIZED_MODE,
  MODE_TABLE,
  modeWarnings,
} from "#src/config/mode-table.ts";

describe("MODE_TABLE", () => {
  it("covers every mode value exactly once, in ladder order", () => {
    expect(Object.keys(MODE_TABLE)).toEqual([...MODE_VALUES]);
  });

  it("never maps machinery failures to allow in any mode", () => {
    for (const mode of MODE_VALUES) {
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
  };

  it("warns on the two extremes combined with a breaker forced to defer", () => {
    for (const mode of ["strict", "auto"] as const) {
      const config = {
        ...base,
        mode,
        circuitBreaker: { consecutive: 3, total: 20, verdict: "defer" as const },
      };
      const warnings = modeWarnings(config);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.path).toBe("mode");
      expect(warnings[0]!.message).toContain(`mode "${mode}"`);
      expect(warnings[0]!.message).toContain("circuitBreaker.verdict");
    }
  });

  it("stays silent otherwise", () => {
    for (const mode of MODE_VALUES) {
      const config = {
        ...base,
        mode,
        circuitBreaker: { consecutive: 3, total: 20, verdict: "deny" as const },
      };
      expect(modeWarnings(config)).toEqual([]);
    }
    expect(
      modeWarnings({
        ...base,
        mode: "default",
        circuitBreaker: { consecutive: 3, total: 20, verdict: "defer" as const },
      }),
    ).toEqual([]);
  });

  it("the red value is derived: the one cycled mode with no ask band", () => {
    expect(EMPHASIZED_MODE).toBe("auto");
    expect(CYCLE_MODE_VALUES).toContain(EMPHASIZED_MODE);
    // The defining property, observed through the ladder's own warning:
    // an ask-free mode paired with a deferring breaker warns, a mode with
    // an ask band stays silent — so the red value is the cycled mode that
    // never asks, whichever literal it happens to be.
    const breakerDefer = { consecutive: 3, total: 20, verdict: "defer" as const };
    const warned = (mode: (typeof MODE_VALUES)[number]): boolean =>
      modeWarnings({ ...base, mode, circuitBreaker: breakerDefer }).length > 0;
    expect(warned(EMPHASIZED_MODE!)).toBe(true);
    expect(CYCLE_MODE_VALUES.filter((m) => m !== EMPHASIZED_MODE).map(warned)).toEqual(
      CYCLE_MODE_VALUES.filter((m) => m !== EMPHASIZED_MODE).map(() => false),
    );
  });
});
