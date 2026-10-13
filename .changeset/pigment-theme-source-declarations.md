---
"pi-pigment": patch
---

**Generated themes prefer the author's own declarations over derived guesses, across every color family they touch.** Where a theme declares them, conversion now takes `editorError.foreground` / `editorWarning.foreground` (48 and 47 ignored declarations across the bundled themes) with the polarity hue as the fallback and the error box tint following the chosen color — Dracula's warning is cyan by its own declaration, faithful to the source rather than a bug. A declared `editor.selectionBackground` / `editor.findMatchBackground` is used even when it carries alpha, its RGB composited onto the canvas rather than dropped for a computed tint (41 selection and 31 find declarations were ignored before).

Bundled themes go through the same diff-roots path user theme files already did, so a declared `diffEditor.insertedTextBackground` / `removedTextBackground` reaches the registered `toolDiff*` slots; failing that, a `markup.inserted` / `markup.deleted` foreground is the diff root — the author's diff-content color instead of a hue guess over every token. A declared `textLink.foreground` is the accent, with the most-saturated-token scan as the fallback: nord, One Dark and GitHub Light previously took their red. The diff tint is the one projection that drops alpha rather than compositing it, keeping its RGB, and it applies only where the theme declares no explicit diff text.

`success` is the one slot with no declaration to prefer: a theme's `editorInfo.foreground` is an info hue, not a success green.
