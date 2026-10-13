/**
 * The shiki → pi theme converter (ADR 0006): ONE pure function turning a
 * materialized shiki theme into a pi theme JSON document. This is where a
 * selected theme's identity crosses into pi's own vocabulary — the canvas,
 * the state colors, the diff roots, and the nine syntax colors are all
 * decided HERE, at generation time (never at render time).
 *
 * Two AA surfaces, never confused (the converter owns only the first):
 *
 * - Converter AA: each foreground is enforced against the surfaces pi actually paints that token on
 *   (pi's own binding table, `theme/system-theme.js` RULES). Both conversion channels run it — the
 *   bundled ships and the user `themes/` directory read alike.
 * - Runtime AA: token colors are enforced at render time by enforceThemeColors against the scheme's
 *   blend backgrounds (the tint ladders). The nine syntax colors in the FILE serve pi's own
 *   markdown code rendering — same source, different precision than the full tokenColors the diff
 *   pipeline loads.
 *
 * Output shape: the 53 required + 3 optional pi tokens (themes.md), all
 * flat hex (no vars indirection — the generator has no authors), plus the
 * optional `export` section derived from the canvas. The token lists are
 * pinned to pi's own public types at compile time by the guard below —
 * upstream additions/removals/renames break the build with the offending
 * token named in the error, so the lists are maintained, not hand-synced
 * from docs.
 */

import type { RgbColor } from "@earendil-works/pi-tui";

import {
  compositeHexOver,
  contrastRatio,
  isLightRgb,
  mixRgb,
  parseOpaqueHex,
  parseRootColor,
  rgbToHex,
  tintCanvas,
} from "#src/core/color.ts";
import type { Issue } from "#src/core/issue.ts";

import {
  AA_FLOOR,
  aaAdjust,
  type AaOptions,
  type AaToken,
  type SurfaceColors,
} from "./aa-policy.ts";
import type { DiffRoots } from "./scheme.ts";
import {
  scopeSemanticKey,
  SEMANTIC_TO_PI,
  type MaterializedTheme,
  type SemanticColors,
  type SemanticKey,
} from "./syntax-theme.ts";

/** The pi theme colors document the converter emits (mirrors themes.md). */
export interface PiThemeColors {
  [token: string]: string;
}

/** The pi theme JSON document the converter emits. */
export interface PiThemeJson {
  $schema: string;
  name: string;
  /** The background the theme is designed for (pi detects it when omitted). */
  appearance?: "dark" | "light";
  colors: PiThemeColors;
  export?: PiThemeExport;
}

/** The optional HTML-export section (page/card/info surfaces). */
export interface PiThemeExport {
  pageBg: string;
  cardBg: string;
  infoBg: string;
}

/** The 53 required pi color tokens, in themes.md order. */
export const PI_REQUIRED_TOKENS = [
  // Core UI (13)
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "scrollbarTrack",
  "scrollbarThumb",
  // Backgrounds & content (11)
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  // Markdown (10)
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  // Tool diffs (3)
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  // Syntax (9)
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  // Thinking levels (6)
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  // Bash mode (1)
  "bashMode",
] as const;

/** The 3 optional pi color tokens (with documented fallbacks). */
export const PI_OPTIONAL_TOKENS = ["thinkingMax", "searchMatchBg", "searchMatchText"] as const;

/** Pi's published theme schema (editor validation for hand-edited copies). */
const PI_THEME_SCHEMA = "https://pi.dev/schemas/theme.schema.json";

/**
 * The hue-anchored state colors per polarity: green/red/amber references
 * that the WCAG sweep nudges toward the canvas until readable. These are
 * the polarity's canonical hues, not theme-derived — the theme's own
 * greens/reds belong to the DIFF roots (semantic), not the state colors
 * (functional: success is green, error is red, by convention).
 */
const STATE_HUES = {
  light: { success: "#1a7f37", error: "#c62828", warning: "#9a6700" },
  dark: { success: "#3fb950", error: "#f85149", warning: "#d29922" },
} as const;

/**
 * Parse an optional slot value into an opaque RGB: undefined for absent
 * or malformed input — the silent-fallback precedent (optional slots
 * degrade to their computed ladder versions, never fail conversion).
 *
 * @param value - The raw slot value.
 * @returns The RGB, or null/undefined.
 */
function optionalOpaqueHex(value: string | undefined): RgbColor | null | undefined {
  return typeof value === "string" ? parseOpaqueHex(value) : undefined;
}

/**
 * STATE_HUES literals are opaque hex by construction — the parse is
 * total; a miss is an internal inconsistency, never a theme problem.
 *
 * @param hex - The state hue hex.
 * @returns The RGB.
 */
function stateHueRgb(hex: string): RgbColor {
  const rgb = parseOpaqueHex(hex);
  if (!rgb) throw new Error(`unreachable hue: ${hex}`);
  return rgb;
}

/**
 * Extract the theme's nine syntax colors by scope classification. The
 * BROADEST declared scope wins each key (the author's category intent —
 * narrow per-language exceptions must not hijack the category's
 * representative color; TextMate's longest-match answers "what color is
 * THIS token", not "what is the comment class's color"). Equal-length
 * tied scopes keep the first rule in file order. Every scope of a rule
 * competes individually (an array rule's shortest element is the rule's
 * bid for that key).
 *
 * @param theme - The materialized theme.
 * @returns The found semantic colors (partial — missing keys fall back).
 */
function extractSyntaxColors(theme: MaterializedTheme): Partial<SemanticColors> {
  const found = new Map<SemanticKey, string>();
  const breadth = new Map<SemanticKey, number>();
  for (const rule of theme.tokenColors ?? []) {
    const rgb = optionalOpaqueHex(rule.settings?.foreground);
    if (!rgb) continue;
    const scopes = typeof rule.scope === "string" ? rule.scope.split(",") : (rule.scope ?? []);
    for (const entry of scopes) {
      const scope = entry.trim();
      if (!scope) continue;
      const key = scopeSemanticKey(scope);
      if (!key) continue;
      const current = breadth.get(key);
      if (current === undefined || scope.length < current) {
        found.set(key, rgbToHex(rgb));
        breadth.set(key, scope.length);
      }
    }
  }
  return Object.fromEntries(found);
}

/**
 * The theme's accent: its declared link color when it has one (the
 * semantic UI foreground pi's accent stands for), else the most
 * saturated token with a mid-lightness guard.
 *
 * @param theme - The materialized theme.
 * @param fallback - The polarity default when nothing qualifies.
 * @returns The accent RGB.
 */
function pickAccent(theme: MaterializedTheme, fallback: RgbColor): RgbColor {
  const declaredLink = optionalOpaqueHex(theme.colors?.["textLink.foreground"]);
  if (declaredLink) return declaredLink;
  let best: { rgb: RgbColor; saturation: number } | undefined;
  for (const rule of theme.tokenColors ?? []) {
    const rgb = optionalOpaqueHex(rule.settings?.foreground);
    if (!rgb) continue;
    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    // Mid-lightness guard: near-black and near-white tokens (punctuation,
    // plain fg) never become accents however saturated numerically.
    const lightness = (max + min) / 510;
    if (lightness < 0.15 || lightness > 0.9) continue;
    if (!best || saturation > best.saturation) best = { rgb, saturation };
  }
  return best?.rgb ?? fallback;
}

/**
 * Diff-root greens/reds from the theme's tokens: the declared
 * `markup.inserted`/`markup.deleted` marker first, then the RGB hue guess.
 *
 * @param theme - The materialized theme.
 * @param isLight - The canvas polarity.
 * @param canvas - The canvas the chosen color is painted on.
 * @returns The added/removed hex candidates (with polarity fallbacks).
 */
function extractDiffColors(
  theme: MaterializedTheme,
  isLight: boolean,
  canvas: RgbColor,
): { added?: string; removed?: string } {
  const candidates = { added: [] as RgbColor[], removed: [] as RgbColor[] };
  for (const rule of theme.tokenColors ?? []) {
    const rgb = optionalOpaqueHex(rule.settings?.foreground);
    if (!rgb) continue;
    const { r, g, b } = rgb;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) continue; // gray: neither
    const saturation = (max - min) / max;
    if (saturation < 0.25) continue; // too gray to read as a hue
    if (g === max && g - r > 20 && g - b > 20) {
      candidates.added.push(rgb);
    } else if (r === max && r - g > 20 && r - b > 20) {
      candidates.removed.push(rgb);
    }
  }
  const state = isLight ? STATE_HUES.light : STATE_HUES.dark;
  return {
    added:
      extractDiffMarker(theme, "inserted") ??
      mostSaturatedHex(candidates.added, canvas) ??
      state.success,
    removed:
      extractDiffMarker(theme, "deleted") ??
      mostSaturatedHex(candidates.removed, canvas) ??
      state.error,
  };
}

/**
 * The diff-marker foreground a theme declares: the color of its
 * `markup.inserted`/`markup.deleted` scope (or a dotted refinement). The
 * author's own diff-content color — it beats the RGB hue guess. The
 * broadest declared scope wins (the syntax-nine rule: a per-language
 * refinement must not hijack the marker); equal-length ties keep file order.
 *
 * @param theme - The materialized theme.
 * @param marker - The side's scope stem (inserted/deleted).
 * @returns The marker hex, or undefined when undeclared.
 */
function extractDiffMarker(
  theme: MaterializedTheme,
  marker: "inserted" | "deleted",
): string | undefined {
  const stem = `markup.${marker}`;
  let best: { hex: string; breadth: number } | undefined;
  for (const rule of theme.tokenColors ?? []) {
    const rgb = optionalOpaqueHex(rule.settings?.foreground);
    if (!rgb) continue;
    const scopes = typeof rule.scope === "string" ? rule.scope.split(",") : (rule.scope ?? []);
    for (const entry of scopes) {
      const scope = entry.trim();
      if (scope !== stem && !scope.startsWith(`${stem}.`)) continue;
      if (!best || scope.length < best.breadth)
        best = { hex: rgbToHex(rgb), breadth: scope.length };
    }
  }
  return best?.hex;
}

/**
 * Mix a color toward the canvas by ratio (the fg ladder's building block).
 *
 * @param color - The source color.
 * @param canvas - The canvas to fade into.
 * @param ratio - The fade ratio (0 = color, 1 = canvas).
 * @returns The mixed color.
 */
function towardCanvas(color: RgbColor, canvas: RgbColor, ratio: number): RgbColor {
  return mixRgb(canvas, color, 1 - ratio);
}

/**
 * The most saturated color in a list (the theme's canonical hue for a
 * diff-root side), restricted to candidates that clear the readability floor
 * on the canvas. A hue guess is only worth taking if it can be read where it
 * lands; an unreadable one is no better than the polarity hue, and forcing
 * AA onto it would move the color far further than falling back.
 *
 * @param list - The candidate RGBs.
 * @param canvas - The canvas the chosen color is painted on.
 * @returns The most saturated readable hex, or undefined when none qualifies.
 */
function mostSaturatedHex(list: RgbColor[], canvas: RgbColor): string | undefined {
  const readable = list.filter((rgb) => contrastRatio(rgb, canvas) >= AA_FLOOR);
  if (readable.length === 0) return undefined;
  let best = readable[0];
  let bestSat = -1;
  for (const rgb of readable) {
    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat > bestSat) {
      bestSat = sat;
      best = rgb;
    }
  }
  return rgbToHex(best);
}

/**
 * Resolve a theme-declared color over the canvas: an opaque value lands as-is,
 * a translucent one composites onto the canvas. An absent or unusable
 * declaration yields undefined so the caller picks its own fallback.
 *
 * @param value - The raw declaration.
 * @param canvas - The theme's canvas.
 * @returns The resolved RGB, or undefined.
 */
function resolveDeclaredColor(value: string | undefined, canvas: RgbColor): RgbColor | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = parseRootColor(value);
  if (!parsed) return undefined;
  return parsed.alpha < 1 ? (compositeHexOver(value, canvas) ?? parsed.rgb) : parsed.rgb;
}

/**
 * A declared background resolved over the canvas, or the computed tint.
 *
 * @param value - The raw declaration.
 * @param canvas - The theme's canvas.
 * @param fallback - The computed tint.
 * @returns The resolved background RGB.
 */
function resolveBackground(
  value: string | undefined,
  canvas: RgbColor,
  fallback: RgbColor,
): RgbColor {
  return resolveDeclaredColor(value, canvas) ?? fallback;
}

/**
 * Drop a tint's alpha: the 8-digit value's RGB as the opaque pi diff root.
 *
 * @param tint - The 8-digit tint hex, or undefined.
 * @returns The opaque RGB, or undefined when no tint.
 */
function tintHue(tint: string | undefined): string | undefined {
  if (!tint) return undefined;
  const rgb = parseRootColor(tint);
  return rgb ? rgbToHex(rgb.rgb) : undefined;
}

/** The conversion options: author-declared diff roots and the AA switch. */
export interface ConvertOptions {
  /** Author-declared diff roots (author intent beats token extraction). */
  diff?: DiffRoots;
  /**
   * Test-only escape hatch: `false` skips the AA sweep. Colors are preserved as
   * authored, but not byte-for-byte — token extraction normalizes syntax hex to
   * 6-digit lowercase. An author-declared `diff` root keeps its own byte form.
   */
  enforceAa?: boolean;
}

/**
 * A conversion product: the pi theme document (`undefined` when the theme was rejected) and what
 * stopped it.
 */
export interface PiThemeConversion {
  /** The pi theme JSON document (`undefined` when the theme was rejected). */
  doc: PiThemeJson | undefined;
  /** What went wrong (empty when the conversion succeeded). */
  issues: Issue[];
}

/**
 * Convert a materialized shiki theme into a pi theme JSON document.
 * Themes missing `editor.background` or `type` are rejected (an issue is
 * returned) — a pi theme without a canvas is not a theme.
 *
 * @param theme - The materialized shiki theme (verbatim, flattened).
 * @param name - The pi theme name (the registered, prefixed identity).
 * @param options - The conversion options.
 * @returns The document and issues; `doc` is undefined when unconvertible.
 */
export function convertToPiTheme(
  theme: MaterializedTheme,
  name: string,
  options?: ConvertOptions,
): PiThemeConversion {
  const enforceAa = options?.enforceAa ?? true;
  const diffOverrides = options?.diff;
  const issues: Issue[] = [];
  // The canvas is the theme's own editor.background — never a root
  // (ADR 0006): the generated theme's canvas IS its editor background.
  const canvas = optionalOpaqueHex(theme.colors?.["editor.background"]);
  if (!canvas) {
    return {
      doc: undefined,
      issues: [{ message: `theme "${theme.name}" has no usable editor.background — skipped.` }],
    };
  }
  if (theme.type !== "light" && theme.type !== "dark") {
    return {
      doc: undefined,
      issues: [{ message: `theme "${theme.name}" has no type — skipped.` }],
    };
  }
  const isLight = isLightRgb(canvas);
  const state = isLight ? STATE_HUES.light : STATE_HUES.dark;

  // Foreground: editor.foreground, else the polarity's neutral gray.
  const neutralFg = isLight ? { r: 0x33, g: 0x33, b: 0x33 } : { r: 0xcc, g: 0xcc, b: 0xcc };
  const fg = resolveDeclaredColor(theme.colors?.["editor.foreground"], canvas) ?? neutralFg;
  const successRgb = stateHueRgb(state.success);
  // The theme's own state declarations win (fidelity); the polarity hue is
  // the fallback. Success has no source declaration to prefer — a theme's
  // `editorInfo.foreground` is an info hue, not a success green.
  const errorRgb =
    resolveDeclaredColor(theme.colors?.["editorError.foreground"], canvas) ??
    stateHueRgb(state.error);
  const warningRgb =
    resolveDeclaredColor(theme.colors?.["editorWarning.foreground"], canvas) ??
    stateHueRgb(state.warning);

  // The surfaces pi paints on. The terminal's own background is not a pi
  // token (an empty slot compiles to SGR 49), so the theme's
  // `editor.background` — the canvas — stands in for it.
  const surfaces: SurfaceColors = {
    toolPendingBg: canvas,
    toolSuccessBg: mixRgb(canvas, successRgb, isLight ? 0.25 : 0.1),
    toolErrorBg: mixRgb(canvas, errorRgb, isLight ? 0.25 : 0.1),
    userMessageBg: tintCanvas(fg, canvas, 0.03),
    customMessageBg: tintCanvas(fg, canvas, 0.05),
    selectedBg: resolveBackground(
      theme.colors?.["editor.selectionBackground"],
      canvas,
      tintCanvas(fg, canvas, 0.12),
    ),
    searchMatchBg: resolveBackground(
      theme.colors?.["editor.findMatchBackground"],
      canvas,
      tintCanvas(fg, canvas, 0.2),
    ),
  };

  // AA is a pairing property, so `aa-policy.ts` owns which surfaces each
  // token carries and the contrast it must clear. Here we only hand it the
  // surfaces this theme resolved, and report what it flagged.
  const aaOptions: AaOptions = {
    themeName: theme.name,
    colors: surfaces,
    enforceAa,
    towardWhite: !isLight,
  };
  const reported = new Set<string>();
  const adjust = (token: AaToken, rgb: RgbColor): RgbColor => {
    const verdict = aaAdjust(token, rgb, aaOptions);
    for (const note of verdict.notes) {
      if (reported.has(note.key)) continue;
      reported.add(note.key);
      issues.push({ message: note.message });
    }
    return verdict.rgb;
  };
  const emit = (token: AaToken, rgb: RgbColor): string => rgbToHex(adjust(token, rgb));
  const emitHex = (token: AaToken, hex: string): string => {
    // Under the escape hatch a raw hex (an author-declared diff root) keeps its
    // own byte form rather than being normalized on the way out.
    if (!enforceAa) return hex;
    const rgb = parseOpaqueHex(hex);
    return rgb ? emit(token, rgb) : hex;
  };

  // The fg ladder. Each level is a text role; its surfaces and tier live in
  // the policy table. `borderMuted` is a decorative separator, unmeasured.
  const fgText = adjust("text", fg);
  const muted = adjust("muted", towardCanvas(fg, canvas, 0.3));
  const dim = adjust("dim", towardCanvas(fg, canvas, 0.55));
  const thinkingText = adjust("thinkingText", towardCanvas(fg, canvas, 0.4));
  const border = adjust("border", towardCanvas(fg, canvas, 0.7));
  const borderMuted = towardCanvas(fg, canvas, 0.85);

  // Accent: the declared link color, else the most saturated token.
  const accentFallback = isLight ? { r: 0x09, g: 0x69, b: 0xda } : { r: 0x58, g: 0xa6, b: 0xff };
  const accentRgb = pickAccent(theme, accentFallback);
  const accent = emit("accent", accentRgb);

  // State colors: the declared state foreground, else the polarity hue.
  const success = emit("success", successRgb);
  const error = emit("error", errorRgb);
  const warning = emit("warning", warningRgb);

  // Syntax nine: extraction with fg-ladder fallbacks.
  const extracted = extractSyntaxColors(theme);
  const syntax: PiThemeColors = {};
  const syntaxDefaults: Record<SemanticKey, RgbColor> = {
    comment: muted,
    keyword: accentRgb,
    function: accentRgb,
    variable: fg,
    string: fg,
    number: accentRgb,
    type: accentRgb,
    operator: fg,
    punctuation: fg,
  };
  for (const key of Object.keys(SEMANTIC_TO_PI) as SemanticKey[]) {
    syntax[SEMANTIC_TO_PI[key]] = emitHex(
      SEMANTIC_TO_PI[key],
      extracted[key] ?? rgbToHex(syntaxDefaults[key]),
    );
  }

  // Diff roots: the explicit diff text beats the declared tint hue, which
  // beats the theme's own diff-marker scope and token greens/reds, which
  // beat the polarity-hue fallbacks. The extraction prefers a token that is
  // readable on the canvas; an unreadable one falls back to the polarity hue.
  const extractedDiff = extractDiffColors(theme, isLight, canvas);
  const diffAdded = emitHex(
    "toolDiffAdded",
    diffOverrides?.added?.text ??
      tintHue(diffOverrides?.added?.tint) ??
      extractedDiff.added ??
      state.success,
  );
  const diffRemoved = emitHex(
    "toolDiffRemoved",
    diffOverrides?.removed?.text ??
      tintHue(diffOverrides?.removed?.tint) ??
      extractedDiff.removed ??
      state.error,
  );
  const diffContext = emit("toolDiffContext", muted);

  // Thinking ladder: dim → fg, seven steps + max.
  const thinkingSteps = [
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "thinkingMax",
  ];
  const thinking: Record<string, string> = {};
  thinkingSteps.forEach((token, i) => {
    const t = i / (thinkingSteps.length - 1); // 0 = dim, 1 = fg
    thinking[token] = rgbToHex(mixRgb(dim, fgText, t));
  });

  // The search hit is the one pairing that is not a panel: its own
  // `searchMatchBg`.
  const searchMatchText = emit(
    "searchMatchText",
    resolveDeclaredColor(theme.colors?.["editor.findMatchForeground"], canvas) ?? fg,
  );
  const colors: PiThemeColors = {
    // Core UI
    accent,
    border: rgbToHex(border),
    borderAccent: accent,
    borderMuted: rgbToHex(borderMuted),
    success,
    error,
    warning,
    muted: rgbToHex(muted),
    dim: rgbToHex(dim),
    text: rgbToHex(fgText),
    thinkingText: rgbToHex(thinkingText),
    scrollbarTrack: rgbToHex(towardCanvas(fg, canvas, 0.75)),
    scrollbarThumb: rgbToHex(towardCanvas(fg, canvas, 0.5)),
    // Backgrounds & content: status-colored tool boxes — pending = the
    // exact canvas, zero shift (no status hint while a call streams);
    // success and error take the polarity's state hues at the same
    // polarity-gated ratio (visible on light canvases, subtle on dark).
    selectedBg: rgbToHex(surfaces.selectedBg),
    searchMatchBg: rgbToHex(surfaces.searchMatchBg),
    searchMatchText,
    userMessageBg: rgbToHex(surfaces.userMessageBg),
    userMessageText: rgbToHex(fgText),
    customMessageBg: rgbToHex(surfaces.customMessageBg),
    customMessageText: rgbToHex(fgText),
    customMessageLabel: accent,
    toolPendingBg: rgbToHex(canvas),
    toolSuccessBg: rgbToHex(surfaces.toolSuccessBg),
    // The error tint's alpha is polarity-gated: 10% reads on dark
    // canvases, but on light canvases 10% of the error red over
    // near-white is imperceptible — the aborted-tool frame looked plain
    // white (the "create ✓ cancel = white bg" report). Light canvases
    // take a stronger tint so the error surface stays visible in
    // truecolor terminals, where the 256-color quantization no longer
    // rescues the subtle blend.
    toolErrorBg: rgbToHex(surfaces.toolErrorBg),
    toolTitle: rgbToHex(fgText),
    toolOutput: rgbToHex(fgText),
    // Markdown
    mdHeading: accent,
    mdLink: accent,
    mdLinkUrl: rgbToHex(muted),
    mdCode: accent,
    mdCodeBlock: rgbToHex(fgText),
    mdCodeBlockBorder: rgbToHex(muted),
    mdQuote: rgbToHex(muted),
    mdQuoteBorder: rgbToHex(adjust("mdQuoteBorder", border)),
    mdHr: rgbToHex(borderMuted),
    mdListBullet: accent,
    // Tool diffs
    toolDiffAdded: diffAdded,
    toolDiffRemoved: diffRemoved,
    toolDiffContext: diffContext,
    // Syntax
    ...syntax,
    // Thinking
    ...thinking,
    // Bash mode
    bashMode: warning,
  };

  return {
    doc: {
      $schema: PI_THEME_SCHEMA,
      name,
      // The Shiki theme's declared polarity (the guard above narrows it to
      // the two literals) — pi then never guesses it from the colors.
      appearance: theme.type,
      colors,
      export: {
        pageBg: rgbToHex(canvas),
        cardBg: rgbToHex(tintCanvas(fg, canvas, 0.04)),
        infoBg: rgbToHex(mixRgb(canvas, warningRgb, 0.08)),
      },
    },
    issues,
  };
}
