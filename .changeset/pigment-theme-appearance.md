---
"pi-pigment": patch
---

Generated pigment themes now declare their `appearance` (`"light"` or `"dark"`), taken verbatim from the Shiki source theme's own polarity instead of leaving pi to infer it from the colors. The light/dark half of a `"light/dark"` theme setting now resolves against a declared background, and every downstream consumer of `theme.appearance` (the light/dark pair, `system` matching, exports) stops guessing.

The generated files also point `$schema` at pi's canonical published schema, `https://pi.dev/schemas/theme.schema.json` — the old `raw.githubusercontent.com` path 404s, so hand-edited copies had no editor validation or completion.

Note: pi's `/settings` theme picker is upstream and still lists every theme flat; it cannot be filtered by polarity from an extension. The `appearance` field is the data that a future upstream grouping would need.
