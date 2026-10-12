---
"pi-permission-ai-guard": patch
---

**Review wording is now positive inclusion on both lanes.** Every always-deny category says what it is — never what it is not, and never what stays in a sibling category. The chat lane's Authorized Danger row and the classifier's criteria were rewritten to that standard, and a shared test pattern pins it: a reflow-split exclusion trips the guard the same as an inline one.

The classifier's `destructive_vcs` again covers rewriting history while standing on a shared, protected, or default branch (an earlier pruning had narrowed it to force-push and delete). An amend on a feature branch with intent allows; an amend on main confirms or denies, since the push state is not visible to the reviewer.
