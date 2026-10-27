import { describe, expect, it } from "vitest";

import { atOrAboveFloor, DEFAULT_CONFIDENCE_THRESHOLD } from "#src/review/confidence-floor.ts";

describe("atOrAboveFloor", () => {
  it("admits a reading exactly ON the floor — the floor is inclusive", () => {
    expect(atOrAboveFloor(0.6, 0.6)).toBe(true);
    expect(atOrAboveFloor(DEFAULT_CONFIDENCE_THRESHOLD, DEFAULT_CONFIDENCE_THRESHOLD)).toBe(true);
  });

  it("rejects a reading just below the floor", () => {
    expect(atOrAboveFloor(0.5999, 0.6)).toBe(false);
    expect(atOrAboveFloor(0, DEFAULT_CONFIDENCE_THRESHOLD)).toBe(false);
  });

  it("rejects NaN, so a broken confidence never reads as trusted", () => {
    // The dangerous direction: NaN must never compare as a trusted positive.
    // Every `>=` comparison is false for NaN, whatever the threshold.
    expect(atOrAboveFloor(Number.NaN, 0.6)).toBe(false);
    expect(atOrAboveFloor(Number.NaN, 0)).toBe(false);
  });

  it("rejects an absent confidence — never reported is not a measurement", () => {
    expect(atOrAboveFloor(undefined, 0.6)).toBe(false);
    expect(atOrAboveFloor(undefined, 0)).toBe(false);
  });
});
