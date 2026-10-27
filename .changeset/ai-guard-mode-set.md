---
"pi-permission-ai-guard": major
---

**The mode set is now `strict` / `default` / `auto`.** `permissive` was renamed to `auto` with identical behaviour: it is the ask-free rung, so `auto` is the mode that never prompts and still blocks every deny and every danger-leaned doubt. It is not a yolo mode.

**`lenient` was removed.** Its one distinguishing trait — passing benign-leaned doubts without asking — is what `auto` already does, and `lenient` still asked on neutral doubts and soft denies, which made the ladder's middle rung hard to explain. Configurations that name `lenient` now run `default` and report a migration issue saying so.

**Existing configuration keeps working.** The loader rewrites a retired `mode` value before validation: `mode: "permissive"` becomes `mode: "auto"` with no behaviour change and a notice naming the rename; `mode: "lenient"` falls back to `default` with a notice. Session overrides carrying either old value are dropped as unknown, so a resumed session starts from the configured mode instead of erroring.

**Wording no longer collides with the new name.** Approval notices and the fail-open notice say "allowed without asking" / "this mode allows the request without asking" instead of "auto-approved", so "auto mode" and "automatic approval" cannot be read as the same thing.

**`mode: "custom"` runs your own ladder row.** The `customMode` block holds two cut lines (`allowThrough`, `denyFrom`, named on the suspicion order) plus the reviewer-failure lane (`onReviewFailure: "deny" | "defer"`, never allow). A mode is two boundaries, so a custom row is contiguous by construction — there are no per-rung cells to misconfigure, and an accept line at or above the reject line simply never asks. `custom` is only selectable while the block is present: the picker and the `ctrl+alt+g` cycle hide it otherwise (it joins the cycle last when configured), and `mode: "custom"` with no block runs `default` and reports a config issue. A custom that never asks renders in warning red like the built-in ask-free rung; a pair redrawing a built-in rung is reported as redundant, with the rung to use instead.
