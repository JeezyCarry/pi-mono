/**
 * Pure color math: the RGB/hex/ANSI-color conversions and the WCAG measures
 * and AA lightness lift that the scheme, the syntax themes and the theme
 * converter derive from. No SGR escape literals live here (escapes.ts owns
 * those) — everything in this module maps colors to colors or numbers. Backed
 * by @ctrl/tinycolor (WCAG contrast is bit-identical to the spec; see ADR 0001
 * for why colord was rejected).
 */

import { readability, TinyColor } from "@ctrl/tinycolor";
import type { RgbColor } from "@earendil-works/pi-tui";

import { SEQ_ESC } from "./escapes.ts";

/** The 6×6×6 color-cube channel values of the XTerm 256-color palette. */
const CUBE_CHANNELS = [0, 95, 135, 175, 215, 255] as const;

/**
 * Decode an XTerm 256-color index (16-231 cube, 232-255 grayscale) into RGB.
 * Indices 0-15 (system colors) have no portable RGB mapping — null.
 *
 * @param index - The 256-color palette index.
 * @returns The decoded RGB, or null for system colors.
 */
function decodeAnsi256(index: number): RgbColor | null {
  if (index < 16 || index > 255) return null;
  if (index >= 232) {
    const gray = 8 + 10 * (index - 232);
    return { r: gray, g: gray, b: gray };
  }
  const i = index - 16;
  return {
    r: CUBE_CHANNELS[Math.floor(i / 36)],
    g: CUBE_CHANNELS[Math.floor(i / 6) % 6],
    b: CUBE_CHANNELS[i % 6],
  };
}

/**
 * Parse an ANSI color sequence into RGB: truecolor (`38;2;r;g;b` /
 * `48;2;r;g;b`) directly, 256-color (`38;5;n` / `48;5;n`) through the XTerm
 * cube/grayscale tables. Returns null for anything else (16-color codes,
 * named, or malformed input) — no color library provides this direction,
 * and pi themes hand us escapes (truecolor or 256-color, per terminal
 * capability).
 *
 * @param ansi - An SGR escape sequence.
 * @returns The parsed RGB, or null.
 */
export function parseAnsiRgb(ansi: string): RgbColor | null {
  const truecolor = ansi.match(new RegExp(`${SEQ_ESC}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
  if (truecolor) {
    return { r: Number(truecolor[1]), g: Number(truecolor[2]), b: Number(truecolor[3]) };
  }
  const indexed = ansi.match(new RegExp(`${SEQ_ESC}\\[(?:38|48);5;(\\d+)m`));
  if (indexed) return decodeAnsi256(Number(indexed[1]));
  return null;
}

/** A parsed hex form: the channels plus the form TinyColor recognized. */
export interface ParsedHex {
  /** The color's RGB channels. */
  rgb: RgbColor;
  /** Alpha in [0, 1] — 1 for the #rgb/#rrggbb (no-alpha) forms. */
  alpha: number;
  /** Whether the input carried an alpha channel (#rgba / #rrggbbaa). */
  isAlphaForm: boolean;
}

/**
 * Strict hex-shape guard — TinyColor is lenient where our surfaces are
 * not: it accepts unprefixed hex ("fff") and surrounding whitespace; the
 * config/theme intakes require a leading `#` and no padding.
 *
 * @param input - The candidate string.
 * @returns Whether the shape is exactly `#` + hexadecimal digits.
 */
function isTightHex(input: string): boolean {
  return input.startsWith("#") && input === input.trim();
}

/**
 * Parse any `#`-prefixed hex form — `#rgb`/`#rrggbb` (opaque) and
 * `#rgba`/`#rrggbbaa` (alpha-carrying — TinyColor expands the shorthands
 * and converts) — into its channels. Everything else (names, rgb()/hsl()
 * strings, unprefixed hex, whitespace padding, malformed input) returns
 * null.
 *
 * @param input - The candidate hex string.
 * @returns The parsed channels, or null.
 */
export function parseHexForm(input: string): ParsedHex | null {
  if (!isTightHex(input)) return null;
  const color = new TinyColor(input);
  if (!color.isValid || (color.format !== "hex" && color.format !== "hex8")) return null;
  const { r, g, b, a } = color.toRgb();
  return { rgb: { r, g, b }, alpha: a, isAlphaForm: color.format === "hex8" };
}

/**
 * Parse a `#rrggbb` hex color into RGB (the config surface's color
 * format). TinyColor-backed; returns null for anything else (3/4/8-digit
 * forms, names, malformed input).
 *
 * @param hex - The hex string.
 * @returns The parsed RGB, or null.
 */
export function parseHexColor(hex: string): RgbColor | null {
  const parsed = parseHexForm(hex);
  return parsed && !parsed.isAlphaForm && hex.length === 7 ? parsed.rgb : null;
}

/**
 * Is the string exactly an opaque `#rrggbb` color (the semantic-slot and
 * global-background format; a 3-digit shorthand is NOT exact — surfaces
 * that accept it use {@link parseOpaqueHex}).
 *
 * @param hex - The candidate string.
 * @returns Whether it is the exact 6-digit opaque form.
 */
export function isOpaqueHex6(hex: string): boolean {
  return parseHexColor(hex) !== null;
}

/**
 * Is the string exactly an alpha-carrying `#rrggbbaa` color (the bundled
 * theme token flattening requires the 8-digit form; the `#rgba` shorthand
 * is NOT exact — surfaces that accept it use {@link parseHexForm}).
 *
 * @param hex - The candidate string.
 * @returns Whether it is the exact 8-digit alpha form.
 */
export function isAlphaHex8(hex: string): boolean {
  const parsed = parseHexForm(hex);
  return parsed !== null && parsed.isAlphaForm && hex.length === 9;
}

/**
 * Parse an opaque hex accepting 3-digit shorthand too (bundled themes
 * ship a few — github-light's `#fff`, vitesse-black's `#000`): the
 * shorthand expands to its 6-digit form.
 *
 * @param hex - The `#rgb` or `#rrggbb` string.
 * @returns The RGB triple, or null when unparseable.
 */
export function parseOpaqueHex(hex: string): RgbColor | null {
  const parsed = parseHexForm(hex);
  return parsed && !parsed.isAlphaForm ? parsed.rgb : null;
}

/**
 * Render an RGB triple as a lowercase `#rrggbb` hex string.
 *
 * @param rgb - The RGB channels.
 * @returns The `#rrggbb` string (TinyColor-backed).
 */
export function rgbToHex(rgb: RgbColor): string {
  return new TinyColor(rgb).toHexString();
}

/**
 * Composite one hex color (6- or 8-digit) over a base — the 8-digit form
 * carries an alpha channel (VS Code theme token colors use it for
 * translucent punctuation etc.). Delegates to TinyColor's `onBackground`
 * (bit-identical alpha blending, validated against the manual math).
 *
 * @param hex - The color (`#rrggbb` or `#rrggbbaa`; others return null).
 * @param base - The opaque base to composite over.
 * @returns The composited RGB, or null for unparseable input.
 */
export function compositeHexOver(hex: string, base: RgbColor): RgbColor | null {
  const top = new TinyColor(hex);
  if (!top.isValid) return null;
  const over = top.onBackground(new TinyColor(base)).toRgb();
  return { r: over.r, g: over.g, b: over.b };
}

/**
 * A diff-root color: an RGB hue plus an optional alpha channel — the parsed
 * hex form without its `isAlphaForm` marker (1 = opaque 6-digit, < 1 =
 * 8-digit `#rrggbbaa`).
 */
export type RootColor = Omit<ParsedHex, "isAlphaForm">;

/**
 * Parse a diff-root color: `#rrggbb` (opaque base) or `#rrggbbaa`
 * (translucent tint — VS Code's diffEditor value format), with the CSS
 * shorthands `#rgb` / `#rgba` (TinyColor expands them). Everything else
 * returns null.
 *
 * @param hex - The hex string.
 * @returns The parsed root color, or null.
 */
export function parseRootColor(hex: string): RootColor | null {
  const parsed = parseHexForm(hex);
  return parsed ? { rgb: parsed.rgb, alpha: parsed.alpha } : null;
}

/**
 * Blend two colors linearly in RGB space (TinyColor's `mix`).
 *
 * @param base - The color to blend into.
 * @param accent - The color being blended in.
 * @param intensity - Blend factor in [0, 1] (0 = base, 1 = accent).
 * @returns The blended RGB.
 */
export function mixRgb(base: RgbColor, accent: RgbColor, intensity: number): RgbColor {
  const blended = new TinyColor(base).mix(new TinyColor(accent), intensity * 100).toRgb();
  return { r: blended.r, g: blended.g, b: blended.b };
}

/**
 * Tint the CANVAS with a little of a color (the background slots' mix:
 * canvas stays the body, the color is the hint). Named for its direction
 * on purpose — a bg slot taking the fade-into-canvas direction renders
 * 97% foreground as a background (gray-on-gray text).
 *
 * @param color - The tint color (the fg, usually).
 * @param canvas - The canvas (the body).
 * @param amount - The tint amount (0 = pure canvas, 1 = pure color).
 * @returns The tinted canvas.
 */
export function tintCanvas(color: RgbColor, canvas: RgbColor, amount: number): RgbColor {
  return mixRgb(canvas, color, amount);
}

/**
 * WCAG relative luminance (pi's own terminal-background detection uses the
 * same formula). >= 0.5 reads as a light surface.
 *
 * @param rgb - The color to measure.
 * @returns Relative luminance in [0, 1].
 */
export function rgbLuminance(rgb: RgbColor): number {
  return new TinyColor(rgb).getLuminance();
}

/**
 * Whether the RGB reads as a light surface. WCAG luminance >= 0.5 — pi's own
 * threshold — NOT TinyColor's `isLight()` (that one is perceived brightness
 * (299r+587g+114b)/1000 >= 128, which classifies mid-gray as light; the
 * palettes need the WCAG reading).
 *
 * @param rgb - The color to classify.
 * @returns True when the surface reads as light.
 */
export function isLightRgb(rgb: RgbColor): boolean {
  return rgbLuminance(rgb) >= 0.5;
}

/**
 * The WCAG contrast ratio between two colors (TinyColor's `readability`,
 * bit-identical to the spec formulas; ADR 0001 records the library choice).
 *
 * @param a - One color.
 * @param b - The other color.
 * @returns The contrast ratio (>= 1).
 */
export function contrastRatio(a: RgbColor, b: RgbColor): number {
  return readability(new TinyColor(a), new TinyColor(b));
}

/**
 * The WCAG contrast ratio between two relative luminances.
 *
 * Spelled the way TinyColor's `readability` spells it — the same expression,
 * the same operands — so that a luminance compared here and a color measured
 * through `contrastRatio` reach the same verdict bit for bit. `interiorPassing`
 * leans on that: it bisects its band edges out of this, and its candidates are
 * still accepted by the measurement.
 *
 * @param a - One relative luminance.
 * @param b - The other relative luminance.
 * @returns The contrast ratio (>= 1).
 */
function contrastOfLuminance(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** WCAG AA contrast ratio for normal-size text — the default target. */
const WCAG_AA = 4.5;

/**
 * The minimum contrast a color achieves over a background set.
 *
 * @param color - The color to measure.
 * @param backgrounds - The backgrounds to measure against.
 * @returns The smallest contrast ratio.
 */
export function minContrast(color: RgbColor, backgrounds: readonly RgbColor[]): number {
  return Math.min(...backgrounds.map((bg) => contrastRatio(color, bg)));
}

/** A WCAG adjustment: the color to emit and whether the target was met. */
export interface WcagAdjustment {
  /** The color to emit (the original when the search finds no other). */
  rgb: RgbColor;
  /** False when the search found no color that clears the target. */
  met: boolean;
}

/**
 * What a search walks and what it has to clear: the hue and saturation held
 * fixed, the surfaces the color reads on, and the contrast ratio to clear.
 */
interface ContrastSearch {
  readonly h: number;
  readonly s: number;
  readonly backgrounds: readonly RgbColor[];
  readonly target: number;
}

/**
 * Nudge a color's HSL lightness until it clears WCAG `target` over every
 * background, preserving hue and saturation: take the first direction whose
 * segment reaches the target, bisect for a passing lightness, and contrast the
 * emitted 8-bit RGB directly. A color that already complies is returned
 * unchanged, and so is one the search finds no passing lightness for — the
 * caller reports that case, it is never papered over with a distorted color.
 * `met` is a promise about the color returned with it: every value that comes
 * back alongside a true has been measured clear on every background, and a
 * false leaves the authored color untouched.
 *
 * @param color - The color to adjust.
 * @param backgrounds - The backgrounds the color must read on.
 * @param towardWhite - The preferred direction (dark palettes adjust up).
 * @param target - The contrast ratio to clear (WCAG AA by default).
 * @returns The adjustment: the color to emit, and whether the target was met.
 */
export function wcagAdjusted(
  color: RgbColor,
  backgrounds: readonly RgbColor[],
  towardWhite: boolean,
  target: number = WCAG_AA,
): WcagAdjustment {
  if (minContrast(color, backgrounds) >= target) return { rgb: color, met: true };
  // TinyColor's HSL: h in degrees, s/l in [0, 1]. The preferred direction
  // first: a background on the far side can leave that unreachable while the
  // other works (black text on a mid grey), so it is a fallback, not a failure.
  const { h, s, l: start } = new TinyColor(color).toHsl();
  const search: ContrastSearch = { h, s, backgrounds, target };
  const clears = (l: number) => minContrast(rgbOfHsl(h, s, l), backgrounds) >= target;
  for (const extreme of [towardWhite ? 1 : 0, towardWhite ? 0 : 1]) {
    // An endpoint that clears the target is the classic case: bisect toward it
    // and land on the lightness nearest the authored color. A background on the
    // far side can instead put the target on a plateau in the middle — a mid
    // grey clears both black and white while neither endpoint clears both — so
    // an endpoint missing the target does not prove the direction is dead.
    const pass = clears(extreme) ? extreme : interiorPassing(search, start, extreme);
    if (pass === undefined) continue;
    return { rgb: rgbOfHsl(h, s, crossing(start, pass, clears)), met: true };
  }
  return { rgb: color, met: false };
}

/**
 * A lightness that clears `target`, on the segment between `from` and `to`, or
 * undefined when the segment holds none — the seed the bisection above needs
 * when the endpoint it aims at misses the target.
 *
 * Every background clears two rays of relative luminance, and a color has to
 * clear every background, so what a color can use is the intersection of those
 * rays. Intersecting rather than subtracting the forbidden bands keeps the
 * endpoints: where one band ends exactly where the next begins, the single
 * luminance between them still clears both and stays in the list. The edges
 * come from bisecting the contrast itself, so they are decided by the same
 * arithmetic that decides whether a color clears.
 *
 * Luminance rises with lightness but jumps rather than ramps, because the
 * emitted color is 8-bit, so each plateau is entered by bisecting that monotone
 * step against the edge the authored color is on, resolved to adjacent doubles,
 * rather than by stepping a fixed ladder of lightnesses across it — a ladder
 * skips a plateau the ramp crosses between two rungs. A plateau whose first
 * representable lightness does not clear there is passed over, and the walk
 * moves to the next one; an undefined answer means the search found no color
 * that clears. The plateaus are walked from the authored end, so the first hit
 * is the one the bisection above settles on anyway.
 *
 * @param search - The ramp to walk and the ratio it has to clear.
 * @param from - The segment's start lightness (the authored color).
 * @param to - The segment's end lightness (the direction's extreme).
 * @returns A clearing lightness on the segment, or undefined when there is none.
 */
function interiorPassing(search: ContrastSearch, from: number, to: number): number | undefined {
  const { h, s, backgrounds, target } = search;
  const luminanceAt = (l: number) => rgbLuminance(rgbOfHsl(h, s, l));
  const authored = luminanceAt(from);
  const opposite = luminanceAt(to);
  // Relative luminance rises with lightness, so the segment is one luminance
  // interval and each forbidden band is a plain interval on it.
  const upward = authored <= opposite;
  const lo = upward ? authored : opposite;
  const hi = upward ? opposite : authored;
  // Each background leaves two rays of luminance that clear it, and a color has
  // to clear every background, so the plateaus are their intersection.
  let plateaus: Array<[number, number]> = [[lo, hi]];
  for (const bg of backgrounds) {
    const [bandLow, bandHigh] = forbiddenLuminances(bg, target);
    plateaus = plateaus.flatMap(([a, b]) => {
      const pieces: Array<[number, number]> = [];
      if (a <= bandLow) pieces.push([a, Math.min(b, bandLow)]);
      if (b >= bandHigh) pieces.push([Math.max(a, bandHigh), b]);
      return pieces;
    });
  }
  for (const [low, high] of upward ? plateaus : plateaus.toReversed()) {
    const edge = upward ? low : high;
    const reached = crossing(from, to, (l) =>
      upward ? luminanceAt(l) >= edge : luminanceAt(l) <= edge,
    );
    if (minContrast(rgbOfHsl(h, s, reached), backgrounds) >= target) return reached;
  }
  return undefined;
}

/**
 * The lightness where a monotone predicate that fails at `from` and holds at
 * `to` first holds, resolved to the last bit a double carries. Either end may be
 * the higher one; the halving walks from `from` toward `to`.
 *
 * Halving stops when the interval has collapsed onto adjacent doubles, so the
 * answer is the first lightness the domain can represent where the predicate
 * holds rather than an approximation to some chosen precision.
 *
 * @param from - The lightness the predicate fails at.
 * @param to - The lightness the predicate holds at.
 * @param holds - The monotone predicate, on a lightness.
 * @returns The first lightness where it holds.
 */
function crossing(from: number, to: number, holds: (l: number) => boolean): number {
  let fail = from;
  let pass = to;
  for (;;) {
    const mid = fail + (pass - fail) / 2;
    if (mid === fail || mid === pass) return pass;
    if (holds(mid)) pass = mid;
    else fail = mid;
  }
}

/**
 * The two relative luminances between which one background forbids a color: it
 * clears at or below the first and at or above the second, and either is
 * infinite where that side never clears.
 *
 * Each edge is bisected out of `contrastOfLuminance` rather than solved for, so
 * it lands on the exact luminance where the measurement turns over. An edge off
 * by a rounding step would put a color the measurement accepts outside the
 * bands the search looks in.
 *
 * @param bg - The background.
 * @param target - The contrast ratio to clear.
 * @returns The lower and the upper edge of the band it forbids.
 */
function forbiddenLuminances(bg: RgbColor, target: number): [number, number] {
  const base = rgbLuminance(bg);
  const clears = (l: number) => contrastOfLuminance(l, base) >= target;
  // A color at the background's own luminance reads 1:1, so nothing is
  // forbidden unless the target itself is that low.
  if (clears(base)) return [base, base];
  let lower = Number.NEGATIVE_INFINITY;
  if (clears(0)) {
    // Contrast falls as luminance rises toward the background.
    lower = crossing(base, 0, clears);
  }
  let upper = Number.POSITIVE_INFINITY;
  if (clears(1)) {
    // Contrast rises again as luminance climbs away from the background.
    upper = crossing(base, 1, clears);
  }
  return [lower, upper];
}

/**
 * Build an RGB from TinyColor's HSL scale (h in degrees, s/l in [0, 1]).
 *
 * @param h - Hue in degrees [0, 360).
 * @param s - Saturation in [0, 1].
 * @param l - Lightness in [0, 1].
 * @returns The RGB color.
 */
function rgbOfHsl(h: number, s: number, l: number): RgbColor {
  const rgb = new TinyColor({ h, s, l }).toRgb();
  return { r: rgb.r, g: rgb.g, b: rgb.b };
}
