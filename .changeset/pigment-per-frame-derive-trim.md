---
"pi-pigment": patch
---

Trim per-frame work the renderers repeated on every frame for a stable result: read memoizes the masked text's line split alongside the masked text (one split per result instead of one per frame), drops the per-frame `entries` filter nobody read (`outputTaskKey` only needs output length + hash), and keys the read memo on path:offset:limit since the limit shapes the notice lift. Grep folds its empty-output verdict into the shared derivation instead of allocating a trimmed copy per frame, and find moves its glob-anchor/emphasis computation into the styled closure so it runs only on frames that actually re-render.
