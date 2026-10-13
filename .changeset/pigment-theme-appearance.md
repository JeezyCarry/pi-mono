---
"pi-pigment": patch
---

**Generated pigment themes declare their `appearance`** (`"light"` or `"dark"`), taken verbatim from the Shiki source theme's polarity instead of leaving pi to infer it from the colors. `isLightTheme` (HTML-export CSS) and the terminal-default color guesses now read a declared fact rather than `detectAppearance`'s luminance guess, which can come out backwards on low-contrast palettes. The `light/dark` half of a pair is still selected by terminal appearance, not by the candidate theme.

Generated files point `$schema` at pi's canonical published schema, `https://pi.dev/schemas/theme.schema.json`; the old `raw.githubusercontent.com` path 404s, so hand-edited copies had no editor validation or completion.

Note: pi's `/settings` theme picker is upstream and lists every theme flat; an extension cannot filter it by polarity. `appearance` is the data a future upstream grouping would need.
