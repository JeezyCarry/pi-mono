---
"pi-pigment": patch
---

Show a pending-call heartbeat on tool headers. Every call header now trails a muted braille spinner cell in the settled `· ✓` status slot while the execution is live, so a quiet pending period (a slow read, a bash command with no output yet) reads as "working", not "frozen". The cell trails so the `$` keeps column 0 and the body's left edge never moves, and the re-armed placeholder reuses the last committed width so the middle-cut never shifts between frames.

The frame is a pure function of the wall clock (one glyph per 250ms bucket), never a per-render counter: a counter would change the header key every frame, and the preview task's own commit re-runs `renderCall` — a self-driving repaint loop disguised as the feature. A ~4Hz interval re-invalidates the row while pending (quiet periods raise no tool events), swept on every final frame; a resumed row never arms one.

It proves the render loop is alive, never that the model streams: a provider stall with an idling TUI keeps spinning (see the heartbeat exception in ADR 0005).
