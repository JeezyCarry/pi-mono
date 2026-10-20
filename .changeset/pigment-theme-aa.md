---
"pi-pigment": patch
---

**Generated themes enforce AA by pairing, in three tiers, and never fake it.** Contrast is measured against the surfaces pi actually paints each token on — pi's own binding table, mirrored by name — so a selected row no longer drags code colors that never touch it, and `toolDiff*` no longer answers to the message panels.

The tiers matter: a 4.5 bar applied to every slot rewrites a theme rather than fitting it. Body text (`text` and the slots carrying its value) clears 4.5 outright — pi gates those at 4.5 itself, so stopping short would only mean a second adjustment at render time. Secondary labels (`muted`, `dim`, the thinking steps, markdown rules) are lifted only to the 3:1 readability floor, and a slot already above it keeps the author's emphasis step, reported as readable but not AA: raising a dim label to 4.5 erases the distinction the dimming was there to express. Below the floor is a defect rather than a style, so it is lifted. Structural borders hold 3:1; `borderMuted`, `scrollbar*` and `mdHr` stay decorative.

Where no color a terminal can show clears a surface, the source color is kept and the pairing is reported with its ratio — a generated theme is never repainted white or black just to pass a check. Which color does clear is settled along the whole ramp, not only at its two ends: contrast depends on relative luminance alone, so the search works in luminance — it takes the bands the surfaces leave workable and bisects the ramp's monotone luminance to reach a color in one. That is what lifts `github-dark-high-contrast`'s `accent`, `muted`, `success` and `warning`, and `github-light-high-contrast`'s `accent`, `dim` and `muted`, to a color that clears their floor instead of being kept as conflicts. The body text on those two themes' selection rows is what stays reported, because on each theme that row sits at the far end of the range from the canvas.

One guessing defect went with it: the diff-root hue scan now ignores candidates that cannot be read on the canvas. An unreadable guess is no better than the polarity hue, and forcing AA onto it moved the color far further than falling back.

Converted themes from the config `themes/` directory run the same sweep as the bundled ships; `enforceAa: false` stays a test-only escape hatch.
