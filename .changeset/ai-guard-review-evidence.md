---
"pi-permission-ai-guard": patch
---

**Reviewer evidence and deny copy.** The classifier lane emits its per-question answers on `ai_guard.model_answers` for every verdict (allow and deny included), so the offline policy replay can re-score a run without another paid pass — the audit record keeps a sentinel for non-defer verdicts. The content-deny instruction the agent sees is shorter: the prohibited bypass shapes are named as retry and work-around, and the unlocking move stays the user requesting it explicitly.
