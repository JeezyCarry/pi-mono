# pi-permission-ai-guard

A Pi extension that reviews permission asks with a light model. The doctrine for writing the safety-rules prompt lives in [docs/prompt-principles.md](./docs/prompt-principles.md).

## Language

### The ask

**Ask**:
A permission request submitted to the authorizer chain: a shell command, a tool call, or a skill invocation.
_Avoid_: request, prompt (reserved for model prompts)

**Surface**:
The tool type an ask targets (`bash`, `mcp`, `skill`, or a namespaced tool name). The first eligibility gate.
_Avoid_: tool, command (a surface is the type, not the specific invocation)

**Review target**:
The value being authorized (the command string, tool name, path).

**Ask eligibility**:
Whether an ask qualifies for AI review — the surface matches the configured list and a review target can be extracted.

### Verdicts

**Policy gate**:
The upstream deterministic engine queried before the model. When the policy already says `allow` or `deny`, the link defers; it only adds value on an undecided policy.
_Avoid_: calling it the screen — the two deny for different reasons

**Screen**:
This extension's own deterministic rule set, evaluated before the model. Its denies are the only ones no mode can lift.

**Verdict**:
The link's ruling: `allow`, `deny`, or `defer`.

**Defer**:
A verdict that hands the decision to the next link in the authorizer chain, optionally carrying a lean.
_Avoid_: defining defer as failure-only

**Lean**:
The directional inclination on a defer (`allow`, `deny`, or omitted). A routing signal only — it never surfaces to the human.
_Avoid_: treating the lean as the verdict

**Mode**:
The leniency ladder for non-allow verdicts, strictest first: `strict`, `default`, `auto`.

**Hard deny / Soft deny**:
The deny split by authority. A screen deny is hard — no mode lifts it. A model deny is soft — it maps against the ladder like any other doubt. The model's self-reported risk level is audit evidence and never picks the tier.

### The question set

**Effect**:
The heaviest action the command's text describes: read, modify, delete, send out, run a program, or unresolved.

**Target**:
The kind of thing the action touches — ordinary files, credential material, version history, a system or service, nothing, or unresolved. Kind only: where it sits belongs to path scope.

**Intent**:
The model's reading of whether the trusted request named this action and whether the command stayed inside what it named.
_Avoid_: auth (the retired axis name), authorization (intent is a relation to the request, not permission)

**Ban**:
Whether an in-force prohibition appears in the trusted record.

**Path scope**:
Whether the command's literal paths sit inside the workspace, outside it, in scratch space, or nowhere the text can settle. Settled by code, never by the model.

**Trusted intent**:
The user-message portion fed to the model — the only authorization source it honors.
_Avoid_: conflating it with intent — this is the source the model reads, intent is the model's reading of it

**Impact record**:
The blind, per-case statement of what actually happens if the command runs: the action, its reversibility, its blast radius, whether private content leaves, and whether the request named it. Expectations derive from it and from nothing else.

**Impact class**:
The expectation bucket a case lands in by its impact record alone: `harmless`, `likely_fine`, `unclear`, `needs_human`, `screen_only`.

**Consequence**:
The scoring headline: how many cases end a run with the same user-visible result their impact record requires, counted across all three modes.
