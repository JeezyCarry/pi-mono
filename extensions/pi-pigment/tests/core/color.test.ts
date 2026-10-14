/** Pure color math: ANSI-color decoding, WCAG measures, and the AA lightness lift. */

import { TinyColor } from "@ctrl/tinycolor";
import type { RgbColor } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  isAlphaHex8,
  isLightRgb,
  isOpaqueHex6,
  minContrast,
  parseAnsiRgb,
  parseHexForm,
  parseOpaqueHex,
  parseRootColor,
  rgbLuminance,
  wcagAdjusted,
} from "#src/core/color.ts";

describe("parseAnsiRgb", () => {
  it("parses truecolor fg sequences", () => {
    expect(parseAnsiRgb("\x1b[38;2;10;20;30m")).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("parses truecolor bg sequences", () => {
    expect(parseAnsiRgb("\x1b[48;2;1;2;3m")).toEqual({ r: 1, g: 2, b: 3 });
  });

  it("decodes 256-color sequences through the XTerm cube and grayscale", () => {
    // Cube corners.
    expect(parseAnsiRgb("\x1b[38;5;16m")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseAnsiRgb("\x1b[48;5;231m")).toEqual({ r: 255, g: 255, b: 255 });
    // A mid-cube color: 59 = 16 + 1*36 + 1*6 + 1 → (95,95,95).
    expect(parseAnsiRgb("\x1b[38;5;59m")).toEqual({ r: 95, g: 95, b: 95 });
    // Grayscale ramp: 232 → 8, 255 → 238.
    expect(parseAnsiRgb("\x1b[38;5;232m")).toEqual({ r: 8, g: 8, b: 8 });
    expect(parseAnsiRgb("\x1b[38;5;255m")).toEqual({ r: 238, g: 238, b: 238 });
  });

  it("rejects system colors, malformed input, and plain text", () => {
    // 0-15 are terminal-configured system colors with no portable RGB.
    expect(parseAnsiRgb("\x1b[38;5;0m")).toBeNull();
    expect(parseAnsiRgb("\x1b[38;5;15m")).toBeNull();
    expect(parseAnsiRgb("\x1b[38;5;256m")).toBeNull();
    expect(parseAnsiRgb("\x1b[31m")).toBeNull(); // 16-color code
    expect(parseAnsiRgb("plain")).toBeNull();
    expect(parseAnsiRgb("")).toBeNull();
  });
});

describe("rgbLuminance / isLightRgb", () => {
  it("uses the WCAG relative luminance formula", () => {
    expect(rgbLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(rgbLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
  });

  it("classifies light vs dark at the 0.5 threshold", () => {
    expect(isLightRgb({ r: 255, g: 255, b: 255 })).toBe(true);
    expect(isLightRgb({ r: 0, g: 0, b: 0 })).toBe(false);
    // Mid-gray linearizes to ~0.216 — dark by the WCAG formula.
    expect(isLightRgb({ r: 128, g: 128, b: 128 })).toBe(false);
    expect(isLightRgb({ r: 188, g: 188, b: 188 })).toBe(true);
  });
});

describe("parseRootColor (root hex with 3/4-digit shorthand)", () => {
  it("expands #rgb to its 6-digit form (opaque)", () => {
    expect(parseRootColor("#3af")).toEqual({
      rgb: { r: 51, g: 170, b: 255 },
      alpha: 1,
    });
  });

  it("expands #rgba to its 8-digit form, doubling each channel", () => {
    const root = parseRootColor("#3af6");
    expect(root?.rgb).toEqual({ r: 51, g: 170, b: 255 });
    expect(root?.alpha).toBeCloseTo(102 / 255, 5);
  });

  it("keeps accepting the full 6/8-digit forms", () => {
    expect(parseRootColor("#3fa9f5")).toEqual({
      rgb: { r: 63, g: 169, b: 245 },
      alpha: 1,
    });
    expect(parseRootColor("#3fa9f566")?.alpha).toBeCloseTo(102 / 255, 5);
  });

  it("rejects everything else (2/5-digit, wrong chars, names)", () => {
    expect(parseRootColor("#3a")).toBeNull();
    expect(parseRootColor("#3a4bc")).toBeNull();
    expect(parseRootColor("#3a4b5c7d8")).toBeNull();
    expect(parseRootColor("#ggg")).toBeNull();
    expect(parseRootColor("red")).toBeNull();
  });
});

describe("parseHexForm strictness (TinyColor's lenience never leaks)", () => {
  it("requires the # prefix and rejects surrounding whitespace", () => {
    expect(parseHexForm("fff")).toBeNull(); // TinyColor alone accepts this
    expect(parseHexForm("#fff ")).toBeNull(); // trailing whitespace
    expect(parseHexForm(" #fff")).toBeNull(); // leading whitespace
    expect(parseHexForm("#fff")).not.toBeNull();
  });

  it("classifies the alpha forms", () => {
    expect(parseHexForm("#fff")?.isAlphaForm).toBe(false);
    expect(parseHexForm("#ffffff")?.isAlphaForm).toBe(false);
    expect(parseHexForm("#ffff")?.isAlphaForm).toBe(true);
    expect(parseHexForm("#ffffffff")?.isAlphaForm).toBe(true);
  });

  it("rejects non-hex color syntaxes (names, rgb(), hsl())", () => {
    expect(parseHexForm("red")).toBeNull();
    expect(parseHexForm("rgb(255,0,0)")).toBeNull();
    expect(parseHexForm("hsl(0,100%,50%)")).toBeNull();
  });
});

describe("isOpaqueHex6 / isAlphaHex8 (exact-form predicates)", () => {
  it("accepts exactly the 6-digit opaque form", () => {
    expect(isOpaqueHex6("#ffffff")).toBe(true);
    expect(isOpaqueHex6("#fff")).toBe(false); // shorthand is not exact
    expect(isOpaqueHex6("#ffffffff")).toBe(false); // alpha form
    expect(isOpaqueHex6("#ffff")).toBe(false);
  });

  it("accepts exactly the 8-digit alpha form", () => {
    expect(isAlphaHex8("#ffffffff")).toBe(true);
    expect(isAlphaHex8("#ffff")).toBe(false); // shorthand is not exact
    expect(isAlphaHex8("#ffffff")).toBe(false); // opaque form
    expect(isAlphaHex8("#fff")).toBe(false);
  });
});

describe("parseOpaqueHex", () => {
  it("expands the 3-digit shorthand and passes regeneration forms through", () => {
    expect(parseOpaqueHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseOpaqueHex("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseOpaqueHex("#ffff")).toBeNull(); // 4-digit is not opaque shorthand
    expect(parseOpaqueHex("#ffffffff")).toBeNull(); // 8-digit is not opaque shorthand
  });
});

/**
 * Every color the ramp reaches, gathered by bisecting each channel's own 8-bit
 * transitions rather than by sampling lightness. The independent oracle for the
 * tests below: it drives TinyColor directly and shares nothing with
 * `wcagAdjusted` but the ramp itself.
 *
 * @param h - Hue in degrees.
 * @param s - Saturation in [0, 1].
 * @returns The colors the ramp reaches.
 */
function rampColors(h: number, s: number): RgbColor[] {
  const at = (l: number): RgbColor => {
    const c = new TinyColor({ h, s, l }).toRgb();
    return { r: c.r, g: c.g, b: c.b };
  };
  const seen = new Map<string, RgbColor>();
  const add = (c: RgbColor) => seen.set(`${c.r},${c.g},${c.b}`, c);
  // A channel only moves one way on either side of 0.5, so each value it takes
  // there has a single crossing. The halving runs until the doubles are
  // adjacent, so it lands on the first lightness that reaches the value rather
  // than within some distance of it — a search that steps would miss a crossing
  // sitting inside one step.
  for (const [a, b] of [
    [0, 0.5],
    [0.5, 1],
  ]) {
    add(at(a));
    add(at(b));
    for (let ci = 0; ci < 3; ci += 1) {
      const channel = (l: number) => [at(l).r, at(l).g, at(l).b][ci];
      for (let v = channel(a) + 1; v <= channel(b); v += 1) {
        let fail = a;
        let pass = b;
        for (;;) {
          const mid = fail + (pass - fail) / 2;
          if (mid === fail || mid === pass) break;
          if (channel(mid) >= v) pass = mid;
          else fail = mid;
        }
        add(at(pass));
      }
    }
  }
  return [...seen.values()];
}

/** The ramps already built, so fixtures sharing one only pay for it once. */
const ramps = new Map<string, RgbColor[]>();

const rampOf = (h: number, s: number): RgbColor[] => {
  const key = `${h},${s}`;
  let ramp = ramps.get(key);
  if (!ramp) {
    ramp = rampColors(h, s);
    ramps.set(key, ramp);
  }
  return ramp;
};

/**
 * The nearest double above or below a positive number, stepped through its
 * IEEE-754 bit pattern.
 *
 * A fraction of the value would skip a representable step at some magnitudes,
 * and a target on the edge of what a ramp reaches has to move exactly one step
 * to land on its neighbour.
 *
 * @param x - The positive number to step from.
 * @param direction - 1 to step up, -1 to step down.
 * @returns The adjacent representable value.
 */
function adjacentDouble(x: number, direction: 1 | -1): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  if (direction === 1) {
    if (low === 0xffffffff) view.setUint32(0, high + 1);
    view.setUint32(4, low + 1);
  } else {
    if (low === 0) view.setUint32(0, high - 1);
    view.setUint32(4, low - 1);
  }
  return view.getFloat64(0);
}

/**
 * Whether two colors hold the same channel values.
 *
 * @param a - One color.
 * @param b - The other color.
 * @returns True when every channel matches.
 */
function sameRgb(a: RgbColor, b: RgbColor): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

describe("wcagAdjusted", () => {
  const BLACK = { r: 0, g: 0, b: 0 };
  const WHITE = { r: 255, g: 255, b: 255 };
  /** Luminance 0.0018 — dark enough that white and a mid tone cannot both clear 4.5. */
  const NEAR_BLACK = { r: 6, g: 6, b: 6 };
  const MID_DARK = { r: 0x4b, g: 0x4b, b: 0x4b };
  const MID = { r: 0x70, g: 0x70, b: 0x70 };
  const MID_GRAY = { r: 0x80, g: 0x80, b: 0x80 };
  /** Authored color, backgrounds, target — the cases the oracle sweeps below. */
  const FIXTURES: Array<[string, RgbColor, RgbColor[], number]> = [
    ["mid grey", MID_GRAY, [BLACK, WHITE], 4.5],
    ["low grey", { r: 0x40, g: 0x40, b: 0x40 }, [BLACK, WHITE], 4.5],
    ["high grey", { r: 0xc0, g: 0xc0, b: 0xc0 }, [BLACK, WHITE], 4.5],
    ["muted red", { r: 0x99, g: 0x33, b: 0x33 }, [BLACK, WHITE], 4.5],
    ["amber", { r: 0xe6, g: 0x80, b: 0x19 }, [NEAR_BLACK, WHITE], 4.5],
    ["blue", { r: 0x0d, g: 0x7f, b: 0xf2 }, [NEAR_BLACK, WHITE], 4.5],
    ["pure red", { r: 255, g: 0, b: 0 }, [NEAR_BLACK, WHITE], 4.5],
    ["rust", { r: 0x85, g: 0x51, b: 0x47 }, [NEAR_BLACK, WHITE], 4.5],
  ];

  it("finds a plateau between the endpoints when the ramp holds one", () => {
    // Black at one end, white at the other: neither endpoint clears both, while
    // a mid grey clears each (4.56 on black, 4.61 on white).
    const result = wcagAdjusted(MID_GRAY, [BLACK, WHITE], true, 4.5);

    expect(result.met).toBe(true);
    expect(minContrast(result.rgb, [BLACK, WHITE])).toBeGreaterThanOrEqual(4.5);
  });

  it("reaches a plateau above the authored color and below it", () => {
    // Both directions land in the same black-and-white plateau, so the darker
    // authored grey is lifted and the lighter one lowered.
    for (const gray of [0x40, 0xc0]) {
      const authored = { r: gray, g: gray, b: gray };
      const result = wcagAdjusted(authored, [BLACK, WHITE], true, 4.5);

      expect(result.met).toBe(true);
      expect(result.rgb).not.toEqual(authored);
      expect(minContrast(result.rgb, [BLACK, WHITE])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("reaches a plateau on a colored ramp", () => {
    // #993333 over the same pair: a red can clear both ends, just not at the
    // lightness it was authored at.
    const authored = { r: 0x99, g: 0x33, b: 0x33 };
    const result = wcagAdjusted(authored, [BLACK, WHITE], true, 4.5);

    expect(result.met).toBe(true);
    expect(result.rgb).not.toEqual(authored);
    expect(minContrast(result.rgb, [BLACK, WHITE])).toBeGreaterThanOrEqual(4.5);
  });

  it("prefers the direction it was given, and falls back when that one dies", () => {
    // A surface the same mid grey leaves lightness as the only escape, so the
    // preference picks the side: up reads 3:1 as #e1e1e1, down as #373737.
    const up = wcagAdjusted(MID_GRAY, [MID_GRAY], true, 3);
    const down = wcagAdjusted(MID_GRAY, [MID_GRAY], false, 3);

    expect(up.met).toBe(true);
    expect(down.met).toBe(true);
    expect(rgbLuminance(up.rgb)).toBeGreaterThan(rgbLuminance(MID_GRAY));
    expect(rgbLuminance(down.rgb)).toBeLessThan(rgbLuminance(MID_GRAY));

    // A light grey on white cannot go up at all, so the fallback darkens it.
    // The preference is a preference, not the only direction tried.
    const light = { r: 0xe0, g: 0xe0, b: 0xe0 };
    const rescued = wcagAdjusted(light, [WHITE], true, 4.5);

    expect(rescued.met).toBe(true);
    expect(rgbLuminance(rescued.rgb)).toBeLessThan(rgbLuminance(light));

    // The plateau either side of a mid grey over black and white sits below it,
    // so both preferences land there — a preference cannot invent a color.
    for (const towardWhite of [true, false]) {
      const result = wcagAdjusted(MID_GRAY, [BLACK, WHITE], towardWhite, 4.5);

      expect(result.met).toBe(true);
      expect(minContrast(result.rgb, [BLACK, WHITE])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("reports an unreachable pairing when the plateau holds no 8-bit color", () => {
    // The workable luminance band is about [0.183195, 0.183333] — narrower than
    // one step of the red ramp, so no representable red lands in it: the best
    // this sweep finds, #ef0000, reads 4.4966, short of 4.5. The sweep covers
    // only the dark half of the ramp, {r,0,0}; the light half, {255,g,g}, is
    // covered by the oracle enumeration at the end of this describe.
    let best = 0;
    for (let r = 0; r <= 255; r += 1) {
      best = Math.max(best, minContrast({ r, g: 0, b: 0 }, [NEAR_BLACK, WHITE]));
    }
    expect(best).toBeLessThan(4.5);

    const red = { r: 255, g: 0, b: 0 };
    const result = wcagAdjusted(red, [NEAR_BLACK, WHITE], true, 4.5);

    expect(result.met).toBe(false);
    expect(result.rgb).toEqual(red);
  });

  it("reports unreachable when the best color the ramp emits only just misses", () => {
    // The best color the oracle enumerates on #e68019's ramp reaches 4.4997 on
    // this pair — 0.0003 short. A search that sampled lightness, or rounded its
    // acceptance loosely, would call that a rescue.
    const authored = { r: 0xe6, g: 0x80, b: 0x19 };
    const { h, s } = new TinyColor(authored).toHsl();
    const best = rampOf(h, s).reduce(
      (top, color) => Math.max(top, minContrast(color, [NEAR_BLACK, WHITE])),
      0,
    );
    expect(best).toBeLessThan(4.5);

    const result = wcagAdjusted(authored, [NEAR_BLACK, WHITE], true, 4.5);

    expect(result.met).toBe(false);
    expect(result.rgb).toEqual(authored);
  });

  it("reaches a color the plateau holds on a very short lightness span", () => {
    // A near-black beside a pure white leaves a band a few thousandths of
    // relative luminance wide, and #855147's ramp crosses it on a span shorter
    // than a scan over lightness would step. Sampling reports this unreachable;
    // bisecting the monotone luminance lands on #a66659, which reads 4.51.
    const authored = { r: 0x85, g: 0x51, b: 0x47 };
    const result = wcagAdjusted(authored, [NEAR_BLACK, WHITE], true, 4.5);

    expect(result.met).toBe(true);
    expect(result.rgb).not.toEqual(authored);
    expect(minContrast(result.rgb, [NEAR_BLACK, WHITE])).toBeGreaterThanOrEqual(4.5);
  });

  it("agrees with the ramp at the contrast one of its own colors reaches", () => {
    // #a66659 is the color #855147's ramp crosses this pair with, reading 4.51.
    // Taking its own contrast as the target puts the target exactly on a rung
    // of the ramp, and the doubles either side of it bracket what the ramp can
    // reach. Both directions have to agree with the ramp, and `met` stays a
    // promise about the color it comes with.
    const authored = { r: 0x85, g: 0x51, b: 0x47 };
    const candidate = { r: 0xa6, g: 0x66, b: 0x59 };
    const surfaces = [NEAR_BLACK, WHITE];
    const { h, s } = new TinyColor(authored).toHsl();
    const ramp = rampOf(h, s);
    const target = minContrast(candidate, surfaces);
    const edges = [adjacentDouble(target, -1), target, adjacentDouble(target, 1)];
    const oracle = (t: number) => ramp.some((c) => minContrast(c, surfaces) >= t);

    // The candidate has to be one the oracle enumerates, or the target is not
    // the rung this test claims it is.
    expect(ramp.some((c) => sameRgb(c, candidate))).toBe(true);
    expect(edges[0]).toBeLessThan(edges[1]);
    expect(edges[1]).toBeLessThan(edges[2]);

    for (const towards of [true, false]) {
      const seen = edges.map((t) => {
        const { met, rgb } = wcagAdjusted(authored, surfaces, towards, t);
        return {
          met,
          clears: !met || minContrast(rgb, surfaces) >= t,
          kept: met || sameRgb(rgb, authored),
        };
      });

      expect(seen.map(({ met }) => met)).toEqual(edges.map(oracle));
      expect(seen.map(({ clears }) => clears)).toEqual([true, true, true]);
      expect(seen.map(({ kept }) => kept)).toEqual([true, true, true]);
    }
  });

  it("holds its promise at the top of the ramp and one step past it", () => {
    // The highest contrast this ramp reaches is the edge of what it can clear:
    // a target exactly there is met, while one representable double above it is
    // cleared by no color the ramp emits. The answer is checked against the
    // ramp itself, and both directions have to agree — the fallback means
    // reachability never depends on the preference.
    const authored = { r: 0x85, g: 0x51, b: 0x47 };
    const surfaces = [NEAR_BLACK, WHITE];
    const { h, s } = new TinyColor(authored).toHsl();
    const top = Math.max(...rampOf(h, s).map((c) => minContrast(c, surfaces)));
    const past = adjacentDouble(top, 1);

    expect(past).toBeGreaterThan(top);
    for (const towards of [true, false]) {
      const hit = wcagAdjusted(authored, surfaces, towards, top);
      const missed = wcagAdjusted(authored, surfaces, towards, past);

      expect([towards, hit.met]).toEqual([towards, true]);
      expect(minContrast(hit.rgb, surfaces)).toBeGreaterThanOrEqual(top);
      expect([towards, missed.met]).toEqual([towards, false]);
      expect(missed.rgb).toEqual(authored);
    }
  });

  it("never pairs met with a color short of the target", () => {
    const sets = [
      [NEAR_BLACK, WHITE],
      [BLACK, WHITE],
      [MID_DARK, WHITE],
      [BLACK, NEAR_BLACK, WHITE, MID_DARK, MID],
    ];
    let met = 0;
    for (let h = 0; h < 360; h += 45) {
      for (const s of [0, 0.5, 1]) {
        for (const l of [0.3, 0.6]) {
          const rgb = new TinyColor({ h, s, l }).toRgb();
          for (const target of [4.5, 3]) {
            for (const backgrounds of sets) {
              const result = wcagAdjusted(rgb, backgrounds, true, target);
              if (!result.met) continue;
              met += 1;
              expect(minContrast(result.rgb, backgrounds)).toBeGreaterThanOrEqual(target);
            }
          }
        }
      }
    }
    // Both the lift and the plateau walk have to be exercised, or this is vacuous.
    expect(met).toBeGreaterThan(20);
  });

  it("agrees with an independent enumeration of the ramp", () => {
    const observed = FIXTURES.map(([label, color, backgrounds, target]) => {
      const { h, s } = new TinyColor(color).toHsl();
      const result = wcagAdjusted(color, backgrounds, true, target);
      return {
        label,
        result,
        reachable: rampOf(h, s).some((c) => minContrast(c, backgrounds) >= target),
        clears: minContrast(result.rgb, backgrounds) >= target,
      };
    });
    for (const { label, result, reachable } of observed) {
      expect([label, result.met]).toEqual([label, reachable]);
    }
    for (const { label, result, clears } of observed) {
      if (!result.met) continue;
      // `met` is a promise: the color that comes with it clears.
      expect([label, clears]).toEqual([label, true]);
    }
    // Both answers must appear, or agreeing on one of them proves nothing.
    const met = observed.filter(({ result }) => result.met).length;
    expect(met).toBeGreaterThan(0);
    expect(met).toBeLessThan(observed.length);
  });
});
