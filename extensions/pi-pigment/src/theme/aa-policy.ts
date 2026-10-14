/**
 * The generation-time AA policy: which pi surface each foreground is painted
 * on, and the contrast that pairing must clear. AA is a property of the
 * pairing, not of a color alone — so a token is measured only against the
 * slots it actually lands on, never against a surface it never paints.
 *
 * The surface groups mirror pi's own binding table (`theme/system-theme.js`
 * `RULES`), which is the authority: pi generates its built-in themes from it.
 *
 * Three tiers, by the role the token plays:
 *
 * - `body` — body text, which pi gates at 4.5 itself; stopping short would only mean a second
 *   adjustment at render time.
 * - `secondary` — a dimming label. It clears the 3:1 readability floor; one already above the floor
 *   keeps the author's emphasis step, reported as readable but not AA, since lifting a dim label to
 *   4.5 erases the distinction the dimming expresses. Below the floor is a defect, not a style.
 * - `indicator` — a structural border or rule, held at 3:1 (WCAG 1.4.11, non-text contrast).
 */

import type { RgbColor } from "@earendil-works/pi-tui";

import { contrastRatio, minContrast, rgbToHex, wcagAdjusted } from "#src/core/color.ts";

/** WCAG AA for normal text. */
export const AA_TEXT = 4.5;

/** The readability floor: a secondary label below it is a defect. */
export const AA_FLOOR = 3;

/** A pi theme background slot a foreground can be painted on. */
export type SurfaceName =
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg"
  | "userMessageBg"
  | "customMessageBg"
  | "selectedBg"
  | "searchMatchBg";

/** The RGB resolved for each surface this conversion paints on. */
export type SurfaceColors = Readonly<Record<SurfaceName, RgbColor>>;

/** What a token's pairings must clear. See the module doc for the roles. */
export type AaTier = "body" | "secondary" | "indicator";

/** A token's rule: the surfaces it is painted on, and its contrast tier. */
export interface AaRule {
  readonly surfaces: readonly SurfaceName[];
  readonly tier: AaTier;
}

/**
 * The two ratios a tier enforces. `target` is what the pairing should reach;
 * `floor` is what a lift aims for, and doubles as the ratio a conflict is
 * reported against. The style zone is exactly the band between them, so it
 * exists only where they differ.
 */
const TIERS: Readonly<Record<AaTier, { readonly target: number; readonly floor: number }>> = {
  body: { target: AA_TEXT, floor: AA_TEXT },
  secondary: { target: AA_TEXT, floor: AA_FLOOR },
  indicator: { target: AA_FLOOR, floor: AA_FLOOR },
};

/** The canvas alone: `toolPendingBg` IS the theme's `editor.background`. */
const CANVAS_ONLY = ["toolPendingBg"] as const;
const TOOL_PANELS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const;
const MESSAGE_PANELS = ["toolPendingBg", "userMessageBg", "customMessageBg"] as const;
const SELECTED_ROW = ["toolPendingBg", "selectedBg"] as const;
const STATE_LABELS = [...SELECTED_ROW, "toolSuccessBg", "toolErrorBg"] as const;
const LADDER = [...STATE_LABELS, "customMessageBg"] as const;
const CODE_BLOCKS = [...MESSAGE_PANELS, "toolSuccessBg", "toolErrorBg"] as const;
const TEXT_CARRIERS = [...LADDER, "userMessageBg"] as const;
const SEARCH_SURFACE = ["searchMatchBg"] as const;

/**
 * Every AA-enforced token, its surfaces and its tier — the whole policy. A
 * token absent here is not measured, and the table's keys ARE the type the
 * converter may pass, so a slot adjusted without a row is a compile error
 * rather than a silent skip.
 *
 * `text`, `userMessageText`, `customMessageText`, `toolTitle`, `toolOutput`
 * and `mdCodeBlock` share ONE value, so `text` carries the union of their
 * separate bindings. `accent` and `muted` also carry the markdown slots,
 * whose user-message panel is a 3% canvas tint — bracketed by the canvas and
 * the 5% custom-message panel `LADDER` already covers, so it is implied.
 */
export const AA_RULES = {
  text: { surfaces: TEXT_CARRIERS, tier: "body" },
  muted: { surfaces: LADDER, tier: "secondary" },
  dim: { surfaces: LADDER, tier: "secondary" },
  thinkingText: { surfaces: CANVAS_ONLY, tier: "secondary" },
  border: { surfaces: CANVAS_ONLY, tier: "indicator" },
  accent: { surfaces: LADDER, tier: "secondary" },
  success: { surfaces: STATE_LABELS, tier: "secondary" },
  error: { surfaces: STATE_LABELS, tier: "secondary" },
  warning: { surfaces: STATE_LABELS, tier: "secondary" },
  searchMatchText: { surfaces: SEARCH_SURFACE, tier: "secondary" },
  mdQuoteBorder: { surfaces: CODE_BLOCKS, tier: "indicator" },
  syntaxComment: { surfaces: CODE_BLOCKS, tier: "secondary" },
  syntaxKeyword: { surfaces: CODE_BLOCKS, tier: "secondary" },
  syntaxFunction: { surfaces: CODE_BLOCKS, tier: "secondary" },
  syntaxVariable: { surfaces: CODE_BLOCKS, tier: "secondary" },
  syntaxString: { surfaces: CODE_BLOCKS, tier: "secondary" },
  syntaxNumber: { surfaces: CODE_BLOCKS, tier: "secondary" },
  syntaxType: { surfaces: CODE_BLOCKS, tier: "secondary" },
  syntaxOperator: { surfaces: CODE_BLOCKS, tier: "secondary" },
  syntaxPunctuation: { surfaces: CODE_BLOCKS, tier: "secondary" },
  toolDiffAdded: { surfaces: TOOL_PANELS, tier: "secondary" },
  toolDiffRemoved: { surfaces: TOOL_PANELS, tier: "secondary" },
  toolDiffContext: { surfaces: TOOL_PANELS, tier: "secondary" },
} satisfies Readonly<Record<string, AaRule>>;

/** A token the policy measures: the table's own keys, so the lookup is total. */
export type AaToken = keyof typeof AA_RULES;

/** One deduplicable issue message. */
export interface AaNote {
  /** Identifies the pairing, so repeats across a conversion collapse. */
  readonly key: string;
  readonly message: string;
}

/** An AA decision: the color to emit, and a note per pairing that fell short. */
export interface AaVerdict {
  readonly rgb: RgbColor;
  readonly notes: readonly AaNote[];
}

/** What one adjustment pass needs to know about the theme being converted. */
export interface AaOptions {
  /** The theme name, as the issue messages address it. */
  readonly themeName: string;
  /** The theme's own resolved surfaces. */
  readonly colors: SurfaceColors;
  /** False keeps authored colors untouched — the test-only escape hatch. */
  readonly enforceAa: boolean;
  /** The preferred lightness direction: dark palettes adjust upward. */
  readonly towardWhite: boolean;
}

/**
 * One token's adjustment and the conversion it belongs to: enough for a note to
 * look the rule up again and name the theme it belongs to.
 */
interface AaSlot {
  readonly token: AaToken;
  readonly options: AaOptions;
}

/**
 * The AA verdict for one token: its color after enforcement, plus a note for
 * every surface the pairing does not clear.
 *
 * A color that already complies is returned as authored and earns no note;
 * one no lightness can rescue is returned as authored and reported.
 *
 * @param token - The pi theme color slot being enforced.
 * @param rgb - The authored color.
 * @param options - The conversion's name, surfaces, escape hatch, and polarity.
 * @returns The color to emit and the notes it earned.
 */
export function aaAdjust(token: AaToken, rgb: RgbColor, options: AaOptions): AaVerdict {
  if (!options.enforceAa) return { rgb, notes: [] };
  const spec = AA_RULES[token];
  const { target, floor } = TIERS[spec.tier];
  const backgrounds = spec.surfaces.map((name) => options.colors[name]);
  const reach = minContrast(rgb, backgrounds);
  if (reach >= target) return { rgb, notes: [] };

  const slot: AaSlot = { token, options };
  // The style zone keeps the author's color (see the module doc); only the
  // floor is enforced. `reach` is the minimum, so clearing the floor here
  // means every surface did.
  if (floor < target && reach >= floor) {
    return { rgb, notes: shortfalls(slot, rgb, "style-zone") };
  }
  const { rgb: adjusted, met } = wcagAdjusted(rgb, backgrounds, options.towardWhite, floor);
  return met
    ? { rgb: adjusted, notes: [] }
    : { rgb: adjusted, notes: shortfalls(slot, rgb, "conflict") };
}

/**
 * Build one note per surface the authored color does not clear.
 *
 * @param slot - The token and the conversion it belongs to.
 * @param color - The authored color the message quotes.
 * @param kind - Which shortfall this is; it picks the message, the key, and the
 *   ratio to report against.
 * @returns The notes, in the rule's surface order.
 */
function shortfalls(slot: AaSlot, color: RgbColor, kind: "conflict" | "style-zone"): AaNote[] {
  const { token, options } = slot;
  const spec = AA_RULES[token];
  const { target, floor } = TIERS[spec.tier];
  // A conflict reports the ratio the lift aimed for; the style zone fell short
  // of AA without being lifted, so it reports against the target.
  const limit = kind === "conflict" ? floor : target;
  const notes: AaNote[] = [];
  const hex = rgbToHex(color);
  spec.surfaces.forEach((name) => {
    const ratio = contrastRatio(color, options.colors[name]);
    if (ratio >= limit) return;
    const shown = `(${ratio.toFixed(2)}:1)`;
    notes.push(
      kind === "conflict"
        ? {
            key: `${token}|${name}|${limit}`,
            message: `theme "${options.themeName}": ${token} ${hex} cannot reach ${limit}:1 on ${name} ${shown} — kept unchanged.`,
          }
        : {
            key: `${token}|${name}|style`,
            message: `theme "${options.themeName}": ${token} ${hex} is below AA on ${name} ${shown} — kept as authored (readable, not AA).`,
          },
    );
  });
  return notes;
}
