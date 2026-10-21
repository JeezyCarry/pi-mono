---
"pi-permission-ai-guard": minor
---

**A model verdict can no longer hard-deny.** Every deny the reviewer model emits is now soft, whatever `riskLevel` it reports: `default` asks you, `strict` and `auto` deny. A misread command therefore reaches a human instead of becoming an unoverridable block. `riskLevel` stays on the audit record and the notice wording, where it never affected the decision.

**A deterministic screen now owns hard denial.** A closed list of literal, unambiguous shapes (`rm -rf /`, raw device writes, `mkfs`, setuid chmod, force-push to a protected branch, reverse shells, `curl | sh`) is denied in every mode before any model call, with its own `screen` gate in the audit log. Anything with a variable, a substitution, or unparseable text is never screened.

**Leaned defers route by mode.** Under `auto` a benign or neutral doubt passes, while a danger-leaned doubt blocks (no ask path); `strict` denies every non-allow. `default` still asks on every flag short of a screen deny.
