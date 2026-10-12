---
"pi-permission-ai-guard": patch
---

**A loaded skill's instructions no longer authorize the agent's next action.** Pi delivers a skill invocation as a single user message: the skill's `SKILL.md` text, then whatever the human typed after it. The reviewer read every user message as the human speaking for themselves, so a skill body became the newest request it could see and pushed the real one out of the five-message window it keeps, leaving the human's benign read with no visible authorization to defer against.

The reviewer now parses that message and keeps only the human's text, tagged with the skill's own name — a review of `extract report.pdf` from the `pdf-tools` skill records `[skill: pdf-tools] extract report.pdf`. A skill message that carries no human text contributes nothing, so the previous request stays the one in view. Skill instructions still reach the model as context; they simply stop counting as the human speaking.
