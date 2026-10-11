---
"pi-pigment": patch
---

Fix rendering falling back to pi's plain output in sessions that spawn an in-process subagent (e.g. `@gotgenes/pi-subagents`). The SDK caches the extension factory per working directory, so a child session reuses the parent's module instance and fires `session_start`/`session_shutdown` again; the render kit lived in module state, so the child overwrote or cleared the parent's. The parent, which never re-fires `session_start`, then decorated with the child's `cwd`/config (the write channel's self-check dropped every diff) or stopped decorating at all: no syntax colors, no diff preview, no header ellipsis. The kit and the write stashes now live in the extension instance's closure.
