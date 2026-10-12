---
"pi-permission-ai-guard": minor
---

**Breaking changes.** The peer floors move to `pi-permission-system >= 40.0.0 < 41.0.0` and `pi >= 1.0.0`, and the compatibility code for hosts below them is gone. Upgrade both together.

A registry that violates the peer contract now fails safe at session start instead of running a degraded configuration. A registry without `streamSimple` already stopped registration; now a registry missing `classify`/`findOfType` stops it too, with an upgrade notice naming the first missing method, because pool assembly reads the required registry surface unconditionally rather than probing for each method. The old `needs pi with classifier support` rejection path is gone; a catalog miss is the only registry rejection left, and it still throws on a primary and drops a fallback.
