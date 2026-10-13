/**
 * The AA policy's own contract: each tier enforces the contrast its role calls
 * for, the style zone preserves the author's emphasis step, and a pairing no
 * lightness can rescue is reported rather than distorted.
 *
 * The converter's tests pin the resulting hex; these pin the rules, so a
 * policy change fails here as a rule breach instead of churning goldens.
 */

import type { RgbColor } from "@earendil-works/pi-tui";
import { describe, expect, expectTypeOf, it } from "vitest";

import { contrastRatio } from "#src/core/color.ts";
import {
  aaAdjust,
  AA_RULES,
  type AaOptions,
  type AaToken,
  type SurfaceColors,
} from "#src/theme/aa-policy.ts";
import { SEMANTIC_TO_PI } from "#src/theme/syntax-theme.ts";

const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };
/** On black: 4.00:1 — inside the style zone, short of AA. */
const STYLE_ZONE = { r: 0x6c, g: 0x6c, b: 0x6c };
/** On black: 2.48:1 — below the readability floor. */
const SUB_FLOOR = { r: 0x4d, g: 0x4d, b: 0x4d };
/** On black 5.32:1, on white 3.95:1 — no single lightness clears 4.5 on both. */
const UNRESCUABLE = { r: 0x80, g: 0x80, b: 0x80 };
/** On black 18.4:1, on white 1.14:1 — no single lightness clears even 3 on both. */
const NEAR_WHITE = { r: 0xf0, g: 0xf0, b: 0xf0 };

/**
 * Every surface at black, then the overrides.
 *
 * @param overrides - Surfaces to set away from black.
 * @returns The surface set.
 */
const surfaces = (overrides: Partial<SurfaceColors> = {}): SurfaceColors => ({
  toolPendingBg: BLACK,
  toolSuccessBg: BLACK,
  toolErrorBg: BLACK,
  userMessageBg: BLACK,
  customMessageBg: BLACK,
  selectedBg: BLACK,
  searchMatchBg: BLACK,
  ...overrides,
});

const options = (overrides: Partial<AaOptions> = {}): AaOptions => ({
  themeName: "t",
  colors: surfaces(),
  enforceAa: true,
  towardWhite: true,
  ...overrides,
});

/**
 * The smallest contrast the color reaches on the token's own surfaces.
 *
 * @param token - The token whose rule names the surfaces.
 * @param rgb - The color to measure.
 * @param colors - The surfaces' RGB.
 * @returns The smallest contrast ratio.
 */
const reach = (token: AaToken, rgb: RgbColor, colors: SurfaceColors): number =>
  Math.min(...AA_RULES[token].surfaces.map((name) => contrastRatio(rgb, colors[name])));

/** The style zone is real only mid-band; guard the fixtures that rely on it. */
const BLACK_ONLY = surfaces();

describe("aa policy: body tier", () => {
  it("keeps a compliant color byte for byte", () => {
    const verdict = aaAdjust("text", WHITE, options());
    expect(verdict.rgb).toEqual(WHITE);
    expect(verdict.notes).toEqual([]);
  });

  it("lifts a style-zone color all the way to AA", () => {
    expect(reach("text", STYLE_ZONE, BLACK_ONLY)).toBeGreaterThanOrEqual(3);
    expect(reach("text", STYLE_ZONE, BLACK_ONLY)).toBeLessThan(4.5);

    const verdict = aaAdjust("text", STYLE_ZONE, options());
    expect(reach("text", verdict.rgb, BLACK_ONLY)).toBeGreaterThanOrEqual(4.5);
    expect(verdict.notes).toEqual([]);
  });
});

describe("aa policy: secondary tier", () => {
  it("keeps a style-zone color and reports every surface it falls short on", () => {
    const verdict = aaAdjust("muted", STYLE_ZONE, options());
    expect(verdict.rgb).toEqual(STYLE_ZONE);
    expect(verdict.notes).toHaveLength(AA_RULES.muted.surfaces.length);
    expect(verdict.notes.every((note) => note.message.includes("readable, not AA"))).toBe(true);
    expect(verdict.notes.every((note) => note.key.endsWith("|style"))).toBe(true);
  });

  it("lifts a color below the floor to the floor", () => {
    expect(reach("muted", SUB_FLOOR, BLACK_ONLY)).toBeLessThan(3);

    const verdict = aaAdjust("muted", SUB_FLOOR, options());
    expect(reach("muted", verdict.rgb, BLACK_ONLY)).toBeGreaterThanOrEqual(3);
    expect(verdict.notes).toEqual([]);
  });
});

describe("aa policy: indicator tier", () => {
  it("holds at 3:1, so a 4:1 color is already compliant", () => {
    expect(reach("border", STYLE_ZONE, BLACK_ONLY)).toBeGreaterThanOrEqual(3);

    const verdict = aaAdjust("border", STYLE_ZONE, options());
    expect(verdict.rgb).toEqual(STYLE_ZONE);
    expect(verdict.notes).toEqual([]);
  });

  it("lifts a color below 3:1", () => {
    const verdict = aaAdjust("border", SUB_FLOOR, options());
    expect(reach("border", verdict.rgb, BLACK_ONLY)).toBeGreaterThanOrEqual(3);
  });
});

describe("aa policy: unreachable pairings", () => {
  it("keeps the authored color and reports a conflict", () => {
    const colors = surfaces({ selectedBg: WHITE });
    const verdict = aaAdjust("text", UNRESCUABLE, options({ colors }));

    expect(verdict.rgb).toEqual(UNRESCUABLE);
    expect(verdict.notes).toHaveLength(1);
    expect(verdict.notes[0].message).toContain("cannot reach 4.5:1 on selectedBg");
  });

  it("reports a secondary conflict against its floor, on every failing surface", () => {
    const colors = surfaces({ selectedBg: WHITE, customMessageBg: WHITE });
    const verdict = aaAdjust("muted", NEAR_WHITE, options({ colors }));

    expect(verdict.rgb).toEqual(NEAR_WHITE);
    // The key and the message both name the floor (3), not AA — a secondary
    // label is never lifted to 4.5, so claiming it aimed there would lie.
    expect(verdict.notes.map((note) => note.key)).toEqual([
      "muted|selectedBg|3",
      "muted|customMessageBg|3",
    ]);
    expect(verdict.notes[0].message).toContain("cannot reach 3:1 on selectedBg");
  });

  it("reports nothing under the escape hatch", () => {
    const verdict = aaAdjust("text", SUB_FLOOR, options({ enforceAa: false }));
    expect(verdict.rgb).toEqual(SUB_FLOOR);
    expect(verdict.notes).toEqual([]);
  });
});

describe("aa policy: the table", () => {
  it("covers every syntax slot the converter enforces", () => {
    for (const slot of Object.values(SEMANTIC_TO_PI)) {
      expect(AA_RULES[slot], `no rule for ${slot}`).toBeDefined();
    }
  });

  it("rejects a token with no rule at compile time, not at conversion", () => {
    // The parameter type is the table's own keys, so widening it (or adding an
    // adjusted slot without a row) breaks the build rather than a user's
    // conversion. Pinned here because a runtime throw would be too late.
    expectTypeOf(aaAdjust).parameter(0).toEqualTypeOf<AaToken>();
    expectTypeOf<AaToken>().toEqualTypeOf<keyof typeof AA_RULES>();
  });
});
