/**
 * The converter's contract (ADR 0006): token-set completeness (pinned to
 * the documented 53+3), the structural invariants (canvas slots equal,
 * all-flat-hex), AA on the colors WE choose (semantic slots — the theme's
 * own fg stays verbatim, pi's own built-ins ship sub-AA texts too), and
 * golden values for solarized-light (the hand-verified reference theme).
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { themeNames } from "@shikijs/themes";
import { describe, expect, expectTypeOf, it } from "vitest";

import { loadBundledTheme } from "#src/theme/bundled-intake.ts";
import {
  convertToPiTheme,
  PI_OPTIONAL_TOKENS,
  PI_REQUIRED_TOKENS,
  type PiThemeJson,
} from "#src/theme/pi-theme-converter.ts";
import type { MaterializedTheme } from "#src/theme/syntax-theme.ts";
import { loadBundledThemeByName } from "#src/theme/theme-file.ts";

function channelLum(c: number): number {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexLum(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

function contrast(a: string, b: string): number {
  const la = hexLum(a);
  const lb = hexLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The conversion issues that are actually problems. A style-zone note says the
 * slot reads but is not AA, and the policy keeps those colors as authored —
 * informational, not a defect.
 *
 * @param issues - The conversion issues.
 * @returns The subset that is not a style-zone note.
 */
function problems(issues: ReadonlyArray<{ message: string }>): ReadonlyArray<{ message: string }> {
  return issues.filter((issue) => !issue.message.includes("readable, not AA"));
}

describe("convertToPiTheme: solarized-light golden values", () => {
  it("paints tool frames by status: pending transparent, success green-tinted", async () => {
    const theme = (await loadBundledTheme("solarized-light"))!;
    const { doc, issues } = convertToPiTheme(theme, "pigment-solarized-light");
    expect(problems(issues)).toEqual([]);
    expect(doc).toBeDefined();
    // editor.background #FDF6E3 → the canvas; pending stays pure canvas
    // (transparent — no status hint while a call streams); success takes
    // the polarity's green at the error tint's ratio (25% light).
    expect(doc!.colors.toolPendingBg).toBe("#fdf6e3");
    expect(doc!.colors.toolSuccessBg).toBe("#c4d8b8");
    // solarized-light's declared fg (#657b83) is sub-AA on its canvas, so
    // the sweep darkens it — hue and saturation kept — until it reads.
    expect(doc!.colors.text).toBe("#4a5a5f");
  });

  it("background slots tint the canvas (not the foreground — the gray-on-gray guard)", async () => {
    const theme = (await loadBundledTheme("solarized-light"))!;
    const { doc } = convertToPiTheme(theme, "pigment-solarized-light");
    const { colors } = doc!;
    // userMessageBg = canvas + 3% fg: #fdf6e3 + 3% #657b83 → #f8f2e0 —
    // a hair off the canvas, NOT near the fg (the inverted-mix bug this
    // pins: a 97%-fg background rendered gray-on-gray text).
    expect(colors.userMessageBg).toBe("#f8f2e0");
    // The theme declares its own editor.selectionBackground — adopted
    // verbatim over the computed tint (the mapping, not the 12% formula;
    // the fallback formula is pinned by the plain-fixture test below).
    expect(colors.selectedBg).toBe("#eee8d5"); // solarized's declared selection
    // The fg ladder is enforced level by level: muted starts at 70% fg +
    // 30% canvas, and the policy lifts it only to the readability floor —
    // solarized's muted sits above it and keeps its own step.
    expect(colors.muted).toBe("#677575");
  });

  it("tints the error box by polarity — visible on light canvases, subtle on dark", async () => {
    const light = (await loadBundledTheme("solarized-light"))!;
    const dark = (await loadBundledTheme("solarized-dark"))!;
    const lightDoc = convertToPiTheme(light, "pigment-solarized-light").doc!;
    const darkDoc = convertToPiTheme(dark, "pigment-solarized-dark").doc!;
    // Golden blend: light canvas #fdf6e3 + 25% error #c62828. The light
    // polarity takes the STRONGER tint — 10% of the error red over a
    // near-white canvas reads as plain white in truecolor terminals (the
    // aborted-create frame looked white), so only light canvases raise
    // the ratio.
    expect(lightDoc.colors.toolErrorBg).toBe("#efc3b4");
    // The dark polarity keeps the original subtle 10% tint (#002b36 +
    // 10% #f8564e) — untouched by the polarity gate.
    expect(darkDoc.colors.toolErrorBg).toBe("#192f38");
  });

  it("keeps every semantic slot AA on the canvas", async () => {
    const theme = (await loadBundledTheme("solarized-light"))!;
    const { doc } = convertToPiTheme(theme, "pigment-solarized-light");
    const { colors } = doc!;
    for (const slot of [
      "success",
      "error",
      "warning",
      "accent",
      "toolDiffAdded",
      "toolDiffRemoved",
      "toolDiffContext",
    ]) {
      expect(contrast(colors[slot], colors.toolPendingBg)).toBeGreaterThanOrEqual(3);
    }
  });

  it("rejects themes without a usable canvas", () => {
    const { doc, issues } = convertToPiTheme(
      { name: "no-bg", type: "dark", tokenColors: [] },
      "pigment-no-bg",
    );
    expect(doc).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("editor.background");
  });

  it("enforceAa: false returns the chosen colors unenforced (test escape hatch)", () => {
    const theme = {
      name: "flat",
      type: "dark" as const,
      colors: { "editor.background": "#282c34" },
      // Nearly invisible on its own canvas — exactly the color the sweep
      // would nudge readable on the bundled ship path.
      tokenColors: [{ scope: "comment", settings: { foreground: "#2a2a2a" } }],
    };
    const off = convertToPiTheme(theme, "pigment-flat", { enforceAa: false }).doc!;
    expect(off.colors.syntaxComment).toBe("#2a2a2a");
    // The default keeps the sweep (the bundled ship path).
    const on = convertToPiTheme(theme, "pigment-flat").doc!;
    expect(on.colors.syntaxComment).not.toBe("#2a2a2a");
  });
});

describe("convertToPiTheme: the AA policy", () => {
  it("lifts a sub-AA declared fg, and the ladder with it, over its own painted surfaces", () => {
    const theme = {
      name: "dim",
      type: "dark" as const,
      colors: { "editor.background": "#101010", "editor.foreground": "#3a3a3a" },
      tokenColors: [],
    };
    const { doc } = convertToPiTheme(theme, "pigment-dim");
    const { colors } = doc!;
    // The body roles paint over the selection row too.
    const bodySurfaces = [
      "toolPendingBg",
      "userMessageBg",
      "customMessageBg",
      "toolSuccessBg",
      "toolErrorBg",
      "selectedBg",
    ].map((token) => colors[token]!);
    // `text` and the slots that carry its value are body text, which pi gates
    // at 4.5 itself; `muted`/`dim` are secondary labels, held to the floor.
    for (const slot of [
      "text",
      "toolTitle",
      "toolOutput",
      "mdCodeBlock",
      "userMessageText",
      "customMessageText",
    ]) {
      for (const bg of bodySurfaces) {
        expect(contrast(colors[slot]!, bg), `${slot} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const slot of ["muted", "dim"]) {
      for (const bg of bodySurfaces) {
        expect(contrast(colors[slot]!, bg), `${slot} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
    // `thinkingText` paints on the canvas alone (the thinking body), and is
    // measured against it alone.
    expect(contrast(colors.thinkingText!, colors.toolPendingBg!)).toBeGreaterThanOrEqual(3);
  });

  it("keeps a code color off the selection row — code is not painted there", () => {
    const theme = {
      name: "mid-selection",
      type: "dark" as const,
      colors: {
        "editor.background": "#101010",
        "editor.foreground": "#e6e6e6",
        // A mid-grey selection row: the body text cannot clear it in either
        // direction, and it must not drag the code colors along.
        "editor.selectionBackground": "#808080",
      },
      tokenColors: [{ scope: "comment", settings: { foreground: "#7f9f6f" } }],
    };
    const { doc, issues } = convertToPiTheme(theme, "pigment-mid-selection");
    // Code never paints on the selection row, so it keeps its color and is
    // never reported against it...
    expect(doc!.colors.syntaxComment).toBe("#7f9f6f");
    expect(issues.some((issue) => issue.message.includes("syntaxComment"))).toBe(false);
    // ...while the body text, which does paint there, is the one conflicted.
    expect(
      issues.some(
        (issue) => issue.message.includes(" text ") && issue.message.includes("selectedBg"),
      ),
    ).toBe(true);
  });

  it("leaves an already-passing fg byte-identical", () => {
    const theme = {
      name: "bright",
      type: "dark" as const,
      colors: { "editor.background": "#101010", "editor.foreground": "#e6e6e6" },
      tokenColors: [],
    };
    const { doc } = convertToPiTheme(theme, "pigment-bright");
    expect(doc!.colors.text).toBe("#e6e6e6");
  });

  it("returns the original color, and reports the failing pairing, when no lightness can clear the target", () => {
    // Mixed-polarity surfaces: the canvas needs light text, the selection row
    // needs dark text, so no single color clears both. A single background is
    // always satisfiable by one of the two extremes.
    const theme = {
      name: "mixed",
      type: "dark" as const,
      colors: {
        "editor.background": "#707070",
        "editor.foreground": "#909090",
        "editor.selectionBackground": "#808080",
      },
      tokenColors: [],
    };
    const { doc, issues } = convertToPiTheme(theme, "pigment-mixed");
    // The source color is kept — never forced to an unreadable extreme.
    expect(doc!.colors.text).toBe("#909090");
    const conflict = issues.find(
      (issue) => issue.message.includes(" text ") && issue.message.includes("toolPendingBg"),
    );
    expect(conflict?.message).toContain("cannot reach 4.5:1");
    expect(conflict?.message).toContain(":1) — kept unchanged.");
  });

  it("reaches the opposite polarity when the preferred direction cannot clear", () => {
    // A mid-grey canvas: the dark-theme default (lighter) cannot clear it
    // while black can — the fallback direction is the honest answer.
    const theme = {
      name: "opposite",
      type: "dark" as const,
      colors: { "editor.background": "#9a9a9a", "editor.foreground": "#f0f0f0" },
      tokenColors: [],
    };
    const { doc } = convertToPiTheme(theme, "pigment-opposite");
    expect(contrast(doc!.colors.text, "#9a9a9a")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("convertToPiTheme: syntax fallback ladder", () => {
  it("a theme without string tokens falls back to the neutral fg (no functional-green leak)", () => {
    const theme = {
      name: "no-string",
      type: "dark" as const,
      colors: { "editor.background": "#282c34", "editor.foreground": "#abb2bf" },
      tokenColors: [],
    };
    const { doc } = convertToPiTheme(theme, "pigment-no-string", { enforceAa: false });
    // The string slot is a SYNTAX slot — its fallback belongs to the fg
    // ladder, not to the functional success hue (green is a status color).
    expect(doc!.colors.syntaxString).toBe("#abb2bf");
  });
});

describe("convertToPiTheme: theme-declared selection/find colors", () => {
  const themed = {
    name: "mapped",
    type: "dark" as const,
    colors: {
      "editor.background": "#282c34",
      "editor.foreground": "#abb2bf",
      "editor.selectionBackground": "#3e4451",
      "editor.findMatchBackground": "#515c6a",
      "editor.findMatchForeground": "#e06c75",
    },
    tokenColors: [],
  };

  it("keeps the declared backgrounds, and enforces the text painted over them", () => {
    // A background is not a foreground: the declared selection/find
    // surfaces land verbatim. The text on the search surface is held to the
    // readability floor, so the author's #e06c75 is lifted until it reads.
    const { doc } = convertToPiTheme(themed, "pigment-mapped");
    expect(doc!.colors.selectedBg).toBe("#3e4451");
    expect(doc!.colors.searchMatchBg).toBe("#515c6a");
    expect(doc!.colors.searchMatchText).toBe("#e9969c");
  });

  it("falls back to the computed tints when the keys are absent or malformed", () => {
    const absent = convertToPiTheme(
      {
        name: "plain",
        type: "dark" as const,
        colors: { "editor.background": "#282c34", "editor.foreground": "#abb2bf" },
        tokenColors: [],
      },
      "pigment-plain",
    ).doc!;
    // canvas + 12% fg, canvas + 20% fg, fg — the ladder fallbacks.
    expect(absent.colors.selectedBg).toBe("#383c45");
    expect(absent.colors.searchMatchBg).toBe("#424750");
    expect(absent.colors.searchMatchText).toBe("#abb2bf");

    const malformed = convertToPiTheme(
      {
        ...themed,
        colors: {
          ...themed.colors,
          "editor.selectionBackground": "not-a-color",
          "editor.findMatchBackground": "",
        },
      },
      "pigment-malformed",
    ).doc!;
    // Malformed values fall back silently (the fg ?? neutralFg precedent).
    expect(malformed.colors.selectedBg).toBe("#383c45");
    expect(malformed.colors.searchMatchBg).toBe("#424750");
    // The valid foreground survives alongside — lifted over the fallback
    // search surface it now paints on.
    expect(malformed.colors.searchMatchText).toBe("#e16f78");
  });
});

describe("convertToPiTheme: syntax extraction is broadest-scope", () => {
  it("the broadest declared scope wins its category, regardless of rule order", () => {
    const theme = {
      name: "broadest",
      type: "dark" as const,
      colors: { "editor.background": "#282c34", "editor.foreground": "#abb2bf" },
      tokenColors: [
        // A narrow doc-comment exception FIRST — under first-wins it would
        // hijack the comment category; broadest-wins takes the later
        // broad `comment` (the author's category intent).
        { scope: "comment.block.documentation", settings: { foreground: "#569cd6" } },
        { scope: "comment", settings: { foreground: "#6a9955" } },
        // A narrow string exception AFTER the broad one — the broad
        // `string` stays (specifics deliberately defer).
        { scope: "string", settings: { foreground: "#ce9178" } },
        { scope: "string.quoted.single", settings: { foreground: "#d4d4d4" } },
      ],
    };
    const { doc } = convertToPiTheme(theme, "pigment-broadest", { enforceAa: false });
    expect(doc!.colors.syntaxComment).toBe("#6a9955");
    expect(doc!.colors.syntaxString).toBe("#ce9178");
  });

  it("equal-length tied scopes keep the first rule in file order", () => {
    const theme = {
      name: "tie",
      type: "dark" as const,
      colors: { "editor.background": "#282c34", "editor.foreground": "#abb2bf" },
      tokenColors: [
        { scope: "string.quoted", settings: { foreground: "#aaaaaa" } },
        { scope: "string.regexp", settings: { foreground: "#bbbbbb" } },
      ],
    };
    const { doc } = convertToPiTheme(theme, "pigment-tie", { enforceAa: false });
    expect(doc!.colors.syntaxString).toBe("#aaaaaa");
  });
});

describe("convertToPiTheme: token set and structure", () => {
  it("mirrors every token pi's floor types define (compile-time pin)", () => {
    // The floor's own vocabulary: its exported ThemeColor union plus the
    // bg slots extracted from the Theme class (the SDK's root does not
    // re-export ThemeBg). Every floor token must be mirrored by our
    // lists — the reverse (ours ⊋ floor) is allowed by design: the
    // converter emits a forward-compatible superset (scrollbarTrack
    // exists only in newer pi; older pi ignores the extra keys). When pi
    // adds/renames a token on the floor, this assertion fails with the
    // token named in the error.
    type PiTokenList = (typeof PI_REQUIRED_TOKENS)[number] | (typeof PI_OPTIONAL_TOKENS)[number];
    // Floor ⊆ ours: every token the floor's types define must be one of
    // ours (the reverse direction is deliberately unconstrained).
    expectTypeOf<ThemeColor | Parameters<Theme["bg"]>[0]>().toExtend<PiTokenList>();
  });

  it("emits exactly the documented 53 required + 3 optional tokens", async () => {
    const theme = (await loadBundledTheme("vitesse-dark"))!;
    const { doc } = convertToPiTheme(theme, "pigment-vitesse-dark");
    const emitted = Object.keys(doc!.colors).toSorted();
    const expected = [...PI_REQUIRED_TOKENS, ...PI_OPTIONAL_TOKENS].toSorted();
    expect(emitted).toEqual(expected);
  });

  it("produces flat 6-digit lowercase hex throughout (no vars, no 256, no defaults)", async () => {
    const theme = (await loadBundledTheme("github-dark"))!;
    const { doc } = convertToPiTheme(theme, "pigment-github-dark");
    for (const value of Object.values(doc!.colors)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
    // And the export section.
    for (const value of Object.values(doc!.export!)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("carries the pi schema URL, the registered name, and the declared appearance", async () => {
    const theme = (await loadBundledTheme("nord"))!;
    const { doc } = convertToPiTheme(theme, "pigment-nord");
    expect(doc!.$schema).toBe("https://pi.dev/schemas/theme.schema.json");
    expect(doc!.name).toBe("pigment-nord");
    expect(doc!.appearance).toBe(theme.type);
  });
});

describe("the generated themes/ directory (golden assets)", () => {
  it("holds one document per bundled theme, structurally valid", async () => {
    const files = (await readdir(join(import.meta.dirname, "..", "..", "themes"))).filter((f) =>
      f.endsWith(".json"),
    );
    expect(files).toHaveLength(themeNames.length);
    for (const file of files) {
      const doc: PiThemeJson = JSON.parse(
        await readFile(join(import.meta.dirname, "..", "..", "themes", file), "utf-8"),
      );
      expect(doc.name).toBe(file.replace(/\.json$/, ""));
      expect(doc.appearance).toMatch(/^(light|dark)$/);
      expect(Object.keys(doc.colors).toSorted()).toEqual(
        [...PI_REQUIRED_TOKENS, ...PI_OPTIONAL_TOKENS].toSorted(),
      );
      expect(doc.colors.toolPendingBg).toBe(doc.export!.pageBg);
    }
  });

  it("is reproducible: in-test regeneration matches the committed bytes", async () => {
    const names = [...themeNames].toSorted();
    for (const name of names) {
      // The generator's own input: the bundled-theme file (diff roots
      // included) through the shared projection — not a bare theme.
      const bundled = await loadBundledThemeByName(name);
      expect(bundled).toBeDefined();
      const { doc } = convertToPiTheme(bundled!.theme, `pigment-${name}`, {
        diff: bundled!.diffRoots,
      });
      const file = join(import.meta.dirname, "..", "..", "themes", `pigment-${name}.json`);
      // Byte-level: the RAW file text must equal the generator's exact
      // form (2-space indent + trailing newline) — re-stringifying both
      // sides compares deep-equal only and never catches an indent or
      // trailing-newline drift (the generator's tab form drifted past
      // this test once already).
      expect(await readFile(file, "utf-8")).toBe(`${JSON.stringify(doc, null, "  ")}\n`);
    }
  });
});

/**
 * A minimal theme for the source-precedence tests.
 *
 * @param overrides - The slots to override.
 * @returns The fixture theme.
 */
function fixtureTheme(overrides: {
  type?: "light" | "dark";
  colors?: Record<string, string>;
  tokenColors?: MaterializedTheme["tokenColors"];
}): MaterializedTheme {
  return {
    name: "fixture",
    type: overrides.type ?? "dark",
    colors: {
      "editor.background": "#101010",
      "editor.foreground": "#d0d0d0",
      ...overrides.colors,
    },
    tokenColors: overrides.tokenColors ?? [],
  };
}

/**
 * A fixture declaring both a tint and a marker scope on each side.
 *
 * @returns The fixture theme.
 */
function tintedFixture(): MaterializedTheme {
  return fixtureTheme({
    colors: {
      "diffEditor.insertedTextBackground": "#0000ff80",
      "diffEditor.removedTextBackground": "#00ffff80",
    },
    tokenColors: [
      { scope: "markup.inserted", settings: { foreground: "#00ff00" } },
      { scope: "markup.deleted", settings: { foreground: "#ff0000" } },
    ],
  });
}

describe("convertToPiTheme: diff-root source precedence", () => {
  it("prefers the explicit diff text over a declared tint and a marker scope", () => {
    const { doc } = convertToPiTheme(tintedFixture(), "pigment-fixture", {
      enforceAa: false,
      diff: {
        added: { text: "#123456", tint: "#0000ff80" },
        removed: { text: "#654321", tint: "#00ffff80" },
      },
    });
    expect(doc!.colors.toolDiffAdded).toBe("#123456");
    expect(doc!.colors.toolDiffRemoved).toBe("#654321");
  });

  it("projects a declared tint's RGB (alpha dropped) over the marker", () => {
    const { doc } = convertToPiTheme(tintedFixture(), "pigment-fixture", {
      enforceAa: false,
      diff: { added: { tint: "#0000ff80" }, removed: { tint: "#00ffff80" } },
    });
    expect(doc!.colors.toolDiffAdded).toBe("#0000ff");
    expect(doc!.colors.toolDiffRemoved).toBe("#00ffff");
  });

  it("uses the marker scope with no tint declared, over the token hue guess", () => {
    const theme = fixtureTheme({
      tokenColors: [
        { scope: "keyword", settings: { foreground: "#00cc44" } },
        { scope: "string", settings: { foreground: "#ff2222" } },
        { scope: "markup.inserted", settings: { foreground: "#33ff33" } },
        { scope: "markup.deleted", settings: { foreground: "#ff3333" } },
      ],
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.toolDiffAdded).toBe("#33ff33");
    expect(doc!.colors.toolDiffRemoved).toBe("#ff3333");
  });

  it("keeps a marker's broad scope (a dotted refinement must not hijack the side)", () => {
    const theme = fixtureTheme({
      tokenColors: [
        { scope: "markup.inserted.diff", settings: { foreground: "#111111" } },
        { scope: "markup.inserted", settings: { foreground: "#33ff33" } },
      ],
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.toolDiffAdded).toBe("#33ff33");
  });

  it("keeps the first rule on a same-width marker tie", () => {
    const theme = fixtureTheme({
      tokenColors: [
        { scope: "markup.inserted", settings: { foreground: "#111111" } },
        { scope: "markup.inserted", settings: { foreground: "#33ff33" } },
      ],
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.toolDiffAdded).toBe("#111111");
  });

  it("falls back to the token hue guess with neither tint nor marker", () => {
    const theme = fixtureTheme({
      tokenColors: [
        { scope: "keyword", settings: { foreground: "#00cc44" } },
        { scope: "string", settings: { foreground: "#ff2222" } },
      ],
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.toolDiffAdded).toBe("#00cc44");
    expect(doc!.colors.toolDiffRemoved).toBe("#ff2222");
  });

  it("fills the missing side from the other source when only one tint is declared", () => {
    const theme = fixtureTheme({
      tokenColors: [{ scope: "markup.deleted", settings: { foreground: "#ff0000" } }],
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", {
      enforceAa: false,
      diff: { added: { tint: "#00ff0080" } },
    });
    expect(doc!.colors.toolDiffAdded).toBe("#00ff00");
    expect(doc!.colors.toolDiffRemoved).toBe("#ff0000");
  });

  it("falls back to the polarity state hue with no diff color anywhere", () => {
    const theme = fixtureTheme({
      tokenColors: [{ scope: "keyword", settings: { foreground: "#d0d0e0" } }],
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.toolDiffAdded).toBe("#3fb950");
    expect(doc!.colors.toolDiffRemoved).toBe("#f85149");
  });

  it("picks the light state hue on a light canvas", () => {
    const theme = fixtureTheme({
      type: "light",
      colors: { "editor.background": "#fafafa" },
      tokenColors: [{ scope: "keyword", settings: { foreground: "#333333" } }],
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.toolDiffAdded).toBe("#1a7f37");
    expect(doc!.colors.toolDiffRemoved).toBe("#c62828");
  });
});

describe("convertToPiTheme: accent source", () => {
  it("takes the declared link color, ignoring a vivid invalid token", () => {
    const theme = fixtureTheme({
      colors: { "textLink.foreground": "#3f7fd0" },
      tokenColors: [{ scope: "invalid.illegal", settings: { foreground: "#ff00ff" } }],
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.accent).toBe("#3f7fd0");
  });

  it("falls back to the most saturated token with no link color", () => {
    const theme = fixtureTheme({
      tokenColors: [
        { scope: "keyword", settings: { foreground: "#d0d0e0" } },
        { scope: "string", settings: { foreground: "#ff3040" } },
      ],
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.accent).toBe("#ff3040");
  });

  it("ignores an unparseable link value and keeps the heuristic", () => {
    const theme = fixtureTheme({
      colors: { "textLink.foreground": "" },
      tokenColors: [{ scope: "string", settings: { foreground: "#ff3040" } }],
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.accent).toBe("#ff3040");
  });
});

describe("convertToPiTheme: state colors prefer the theme's own declaration", () => {
  it("takes a declared editorError/editorWarning over the polarity hue", () => {
    const theme = fixtureTheme({
      colors: { "editorError.foreground": "#ff5555", "editorWarning.foreground": "#8be9fd" },
    });
    const { doc } = convertToPiTheme(theme, "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.error).toBe("#ff5555");
    expect(doc!.colors.warning).toBe("#8be9fd");
    // The warning-derived chrome follows the chosen root, not the constant.
    expect(doc!.colors.bashMode).toBe("#8be9fd");
  });

  it("keeps the polarity hue when the theme declares none", () => {
    const { doc } = convertToPiTheme(fixtureTheme({}), "pigment-fixture", { enforceAa: false });
    expect(doc!.colors.error).toBe("#f85149");
    expect(doc!.colors.warning).toBe("#d29922");
  });
});

/**
 * The selectedBg a fixture declaring the given selection color produces.
 *
 * @param value - The `editor.selectionBackground` declaration.
 * @returns The generated selectedBg.
 */
function fixtureSelectedBg(value: string): string {
  return convertToPiTheme(
    fixtureTheme({ colors: { "editor.selectionBackground": value } }),
    "pigment-fixture",
    { enforceAa: false },
  ).doc!.colors.selectedBg;
}

describe("convertToPiTheme: declared backgrounds composite over the canvas", () => {
  it("honours the alpha: opaque as-is, alpha 0 the canvas, mid between", () => {
    expect(fixtureSelectedBg("#ffffff")).toBe("#ffffff");
    expect(fixtureSelectedBg("#ffffff00")).toBe("#101010");
    expect(fixtureSelectedBg("#ffffff80")).toBe("#888888");
  });

  it("falls back to the computed tint for an unusable declaration", () => {
    const none = convertToPiTheme(fixtureTheme({}), "pigment-fixture", { enforceAa: false }).doc!
      .colors.selectedBg;
    expect(fixtureSelectedBg("not-a-color")).toBe(none);
  });
});
