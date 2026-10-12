---
"pi-pigment": patch
---

The write details channel no longer stashes a second copy of a write's content and display path at `tool_call`; it reads both from the paired `tool_result` event's arguments. That event carries the validated args the tool actually received, so an extension that mutates them in place (pi documents `tool_call` `event.input` as mutable) now renders the true old→new diff — previously the stale snapshot made the self-check drop the preview. The self-check is otherwise unchanged: a sibling write or an aborted call still yields no diff rather than a wrong one.
