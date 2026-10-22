---
"pi-permission-ai-guard": minor
---

**A model verdict can no longer hard-deny.** Every deny the reviewer model emits is soft, whatever `riskLevel` it reports: `default` asks, `strict` and `auto` deny. A misread command reaches a human instead of becoming an unoverridable block; `riskLevel` survives only on the audit record and the notice wording.

**A deterministic screen owns hard denial.** A closed list of literal shapes the screen can prove is denied in every mode before any model call, as its own `screen` gate in the audit log: recursive deletion of a system root or a Windows drive root, raw device writes and wipes (`dd of=`, `mkfs`, `shred`, `blkdiscard`, `nvme format`, `cp`/`tee` onto a block device), destructive partition and volume commands, setuid chmod, force-push to a protected branch, reverse shells, a download piped into an interpreter or evaluated as a program, a function or alias call that backgrounds a pipeline of itself, `find … -delete` from a system root, and `kill … -1`.

Where the shape sits does not narrow it: a destructive call is denied inside a substitution, at a definition's call site, or behind a wrapper like `sudo`/`env`/`timeout` just as much as at the top level. What the screen cannot read it does not deny — text that only defines something, an interpreter's own program, anything carrying a variable or a substitution, `find -exec`, PowerShell, an option it does not model — and those reach the model like any other request.

**Leaned defers route by mode.** Under `auto` a benign or neutral doubt passes, while a danger-leaned doubt blocks; `strict` denies every non-allow; `default` asks on every flag short of a screen deny.

**The chat engine reads deterministic command facts.** Its prompt now carries the deterministic readings of the command — shape, path scope, network use, effects — labelled as observations rather than safety conclusions.
