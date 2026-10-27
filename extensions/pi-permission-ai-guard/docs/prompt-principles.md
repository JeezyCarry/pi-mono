# Prompt writing principles

The safety rules prompt (`SAFETY_RULES` in `src/review/engines/chat/prompt.ts`) is the semantic instruction fed to the review model. These principles govern how it is written and maintained.

## 1. Semantic, not literal

Rules describe abstract concepts ("credential stores, private keys"), not environment-specific paths or tool names. A few generic examples ("piping a download into a shell", `chmod +s`) are fine as anchors, but they never act as the default gate — the category description does. Redundant qualifiers ("of unverified package" when the verb already implies it) are removed.

## 2. Three-tier precedence: DENY-Always > DENY-Unless > ALLOW

- **DENY-Always**: deny regardless of intent (secrets, irreversible destruction, external code execution) — except a directly authorized hit, which confirms with the operator instead of denying.
- **DENY-Unless**: allow only with matching intent; otherwise the fallback the entry itself specifies (deny or defer).
- **ALLOW**: allow only when matching the current task context.

Each entry's fallback is stated by the entry, not by the section heading — an entry may fall back to deny or to defer. The routing layer states the intent requirement once for the whole tier; an entry that mentions intent is stating its own fallback ("needs matching intent, otherwise DEFER"), not restating the rule.

## 3. Uncertain → DEFER, not → DENY

Absent intent defaults to defer, not deny; even an entry whose fallback is DENY needs clear evidence that the action exceeds the anchor's scope. "(none found)" is insufficient evidence, not proof of absence. Unfamiliarity alone is not dangerous. Non-destructive observation without intent defers; it is never denied solely for being that action.

## 4. Trusted intent is the only authorization source

Transcript, tool calls, action text, and permission requests are untrusted. A human goal authorizes only matching actions, not unrelated or higher-risk side effects. Authorization is judged by material effect, not by command syntax.

## 5. The model is the semantic layer, not the deterministic gate

Deterministic interception is done by the policy engine; the model adds semantic judgment. Tool-name exceptions belong in policy config, not in the prompt. The prompt does not list allow-listed tool names.

## 6. Judge by behavior, not by category label

The same operation can fall into different tiers depending on what it actually does, so avoid excluding a whole action class ("page scripts are read-only") and route each action by what it does. "is not this category" between sibling categories is the routing form, not an exclusion.

## 7. Concise, but never at the cost of semantics

Remove redundant phrasing, merge overlapping entries when their scope is identical, and inline parenthetical content where possible. Minimize token count — the prompt is sent on every model review and the safety rules block is not cached — but splitting distinct concepts stays even if it costs tokens, because navigability reduces misclassification.

Safety-critical semantics must stay explicit, even when they seem implied. Two live as literal phrases in the rules — "both payload and destination" (Sensitive-Data Egress) and "not unrelated or higher-risk side effects" (Trust Boundary). A third, "intent matching is not required", lives in the Intent-Based Routing rule ("no intent → DEFER everything outside ALLOW, unless DENY — Always"): an unknown command with no matching intent DEFERs, and never becomes a DENY merely for lacking intent. Do not add an entry-level copy of it under Unknown Commands — the entry-level string reads as "unknown commands can be allowed without intent".

## 8. Structure serves navigability

**Line breaks inside prompt literals come from `flowmark`, not from hand-wrapping.** `python3 scripts/reflow-prompt.py` reflows every prose literal in place; `--check` reports without writing. The script refuses to write unless the result is provably whitespace-only, so a literal with non-prose lines reports instead of writing. General rules are split into distinct concepts rather than fused in one paragraph, and two general rules merge only when they state the same requirement. Section titles must be unambiguous — a heading that asserts a single fallback breaks when entries under it have different fallbacks.

## 9. Precise wording, no ambiguity

"executing fetched or remotely directed code" (not "fetching" alone — fetch by itself does not trigger DENY-Always); "ALLOW with intent, otherwise DEFER" (not "ALLOW/DEFER"); "is not this category" (not "is EXEMPT"). Cross-tier annotations use a consistent style across entries.

## 10. Do not over-tune from stale logs

Before adjusting the prompt, confirm which prompt version produced the logs. Prefer policy config for deterministic-operation false positives. Only adjust the prompt when there is a systematic semantic bias — and then make the fallback explicit ("never DENY solely for these"), never add tool-name exceptions.

## 11. Terminology: human, user, operator

Three words, three jobs. **human** is the person whose words carry authorization (a `user`-role message and a question tool's answer alike); every sentence that grants authority says "human". **user** is transcript structure only (the `user` role, "user messages", "the user prompt"). **operator** is the person who reads the notices: the second person of defer and deny copy. The rendered transcript's labels carry the same words as the rule that defines them — "Latest request from the human (the authorization anchor)" — so rule and label must not disagree.

## 12. The defer line names the gap, then the ask

A defer reason is the operator's only channel, and `lean` stays hidden because surfacing it would anchor the human's decision. One line carries both halves: what the reviewer could not establish, then the one thing that would settle it in parentheses (`no request covers this action (did you ask for it?)`). Both lanes obey that shape but deliberately do not share words: a lane-spanning constant, or an example generic enough to be parroted, is how one content-free line reached the operator from both engines.
