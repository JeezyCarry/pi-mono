# ADR 0006: The theme-provider architecture

## Status

Accepted

## Context

pi-pigment began as a tool-output renderer whose `syntaxTheme` config selected the rendering theme — a second theme authority beside pi's own `theme` setting. Two knobs, two palettes: the diff box adopted the selected Shiki theme's `editor.background` at render time (canvas adoption, ADR 0003 revision), while everything else (chrome, boxes, state colors) followed the pi theme. The seam showed: selecting solarized recolored the diffs but left the surrounding pi chrome untouched, and the "full look" required the user to hold two settings in agreement.

Investigating pi's extension surface for theme work found a complete official contract:

- **Packages may ship themes**: a `themes/` directory (or `pi.themes` manifest entry) is discovered and registered natively — themes appear in `/settings` → Theme, persist in pi's settings, hot-reload, and honor pi's `"light/dark"` pairing syntax for terminal-following.
- **`resources_discover`** accepts `themePaths` from extensions (files or directories) — the runtime registration channel.
- **`ctx.ui.theme`** is a live proxy: every render sees the current theme instance, so followers track mid-session switches with no event plumbing.

The alternative considered was an imperative takeover: construct a `Theme` instance from the converted Shiki theme and `setTheme()` it at session_start. It works on the startup path (verified against pi's boot order) but is clobbered on `/reload` (`applyFromSettings` replays the settings theme afterwards), stays in-memory only, and fights pi's lifecycle instead of joining it.

## Decision

pi-pigment becomes a **theme provider** with a two-layer model:

1. **The base layer is the pi theme.** pi-pigment ships the whole Shiki bundle (65 themes) converted to pi theme JSON — pre-generated at build time into the package `themes/` directory, committed as package assets. Picking `pigment-solarized-light` in `/settings` → Theme hands the entire pi to the theme: chrome, boxes, backgrounds, all of it, through pi's own native machinery (persistence, reload, light/dark pairing). User-authored theme files in the config `themes/` directory convert through the same converter on demand — the `/pigment convert` command (TUI selector or explicit stem) writes each `pigment-<name>.json` next to its source; `resources_discover` lists the outputs (individual files — the directory also holds TextMate theme sources pi must not load). Conversion is manual by design: the outputs are user-visible artifacts (inspectable, self-sufficient), and startup pays zero conversion. A converted source KEEPS working in the token-override channel (the pair grammar revision: conversion registers a pi theme for /theme, it does not retire the source stem — referencing the product by name gets an issue pointing at the right channel).

2. **The override layer is `syntaxTheme`.** It selects token colors ONLY. `auto` (the default) follows the base layer through the detection chain: a `pigment-*` theme name maps back to its Shiki source for full-`tokenColors` precision; any other theme derives from its nine `syntax*` colors. An explicit value overrides the tokens while the chrome/canvas/diff roots stay the pi theme's.

Consequences for the existing machinery:

- **Canvas adoption dissolves at runtime.** The converter puts the theme's `editor.background` into the theme file's background slots (pending = success = the exact canvas — zero state-shift jump); the diff box renders on the pi theme's `toolSuccessBg` like every other surface. The runtime adoption family (`adoptedFileBackground`, `canvasHexOf`, family/variant canvas extraction, `setToolHeaderBg`'s canvas role) is deleted.
- **Channel diff roots move to generation time.** A Shiki file's `diff` key and `diffEditor.*TextBackground` passthroughs feed the converter (the registered theme's `toolDiff*` slots); the palette reads the slots. The `diff` roots in pi-pigment's config remain the user's only runtime override.
- **Polarity gating narrows to the override layer.** A generated theme's polarity is the pi theme's polarity by construction — they cannot disagree. The gate survives only where disagreement is possible: an explicit light `syntaxTheme` on a dark pi theme still falls back to auto.
- **AA is a pairing property, enforced at generation time.** The surface lists mirror pi's own binding table (`theme/system-theme.js` `RULES`): `text` carries the canvas plus a selected row, `accent`/`success`/`error`/`warning` add the tool-state boxes, the `muted`/`dim` ladder adds the custom-message panel, `syntax*`/`mdCodeBlock`/`mdQuoteBorder` carry every panel a code block lands on, `toolDiff*` carries the canvas and the tool boxes only, and `searchMatchText` carries `searchMatchBg` alone. Slots that share one value (`text`, `userMessageText`, `customMessageText`, `toolTitle`, `toolOutput`, `mdCodeBlock`) carry the union of their separate bindings, because one value cannot be enforced per-token. Every foreground is lifted by the least hue/saturation-preserving lightness move that clears its target, and the target depends on the role: body text (`text` plus the slots that carry its value) clears 4.5 outright, because pi gates those at 4.5 itself and a converter that stopped short would only be adjusted again at render time. A secondary label — `muted`, `dim`, the thinking steps, markdown rules, the state labels — is lifted only to the 3:1 readability floor; a slot already above it keeps the author's emphasis step and is reported as readable but not AA, since raising a dim label to 4.5 erases the distinction the dimming expresses. Below the floor is a defect rather than a style. Structural borders hold 3:1 (`border` and `mdQuoteBorder`); `borderMuted`, `scrollbar*` and `mdHr` are decorative and exempt. A slot that already clears its target lands byte-identical. A declared color that carries alpha is composited onto the canvas rather than discarded, state colors included. Both conversion entries run the policy (bundled and the user `themes/` channel); `enforceAa: false` is a test-only escape hatch that preserves authored colors but not their byte form, since extraction normalizes hex on the way in. The runtime continues enforcing token colors against the diff blend backgrounds.

## Consequences

The user story collapses to one gesture: pick a theme in `/settings`, and the whole of pi — chrome and diffs alike — follows. `syntaxTheme` survives as a power tool (GitHub tokens over a Catppuccin chrome), and the zero-config default is richer: any pi theme gets matching syntax, and pi-pigment themes get the precise pipeline.

The costs: a build-time generation step (the committed `themes/` assets must be regenerated when the converter changes — `pnpm generate:themes`, CI checks freshness), and one breaking change accepted at pre-release: `syntaxTheme`'s semantics shift from full selection to token override. The config `themes/` directory keeps its name (user-facing vocabulary wins; the package's own `themes/` lives inside the installed package, invisible to users — the same-word collision is conceptual only, resolved by context in the docs).

Readability costs some emphasis hierarchy: when a source theme's whole foreground ramp sits under the AA floor, `muted` and `dim` land at the floor too, so they read like `text`. That is reported rather than hidden. A shared foreground that cannot clear every surface it paints on is reported as a conflict, not silently resolved by picking a background.
