---
"pi-permission-ai-guard": minor
---

**Breaking changes.** The classifier reviewer no longer accepts the direct System One provider object (`{ "type": "typesafe", "baseUrl": …, "apiKey": … }`), and the `@typesafe-ai/sdk` dependency is gone. Run the classifier lane through Pi instead: register the endpoint (Pi ships a TypeSafe provider; a System One-compatible endpoint can be a custom Pi classifier provider), then set `"modelType": "classifier"` on its string provider id.

A config still carrying the object provider fails the load with a named migration hint, for the primary and for each `fallbacks` entry. Endpoint URLs and keys now live in Pi, so nothing points the reviewer at an endpoint from the extension's own config, and the `TYPESAFE_BASE_URL` / `TYPESAFE_API_KEY` fallbacks are gone with the SDK. The lane's request and answer shapes, its failure classes, and its audit `rawReply` are Pi's now; behavior is otherwise unchanged.

**The retired config spellings are gone as well**, and each now fails the load with a named migration rather than an unknown-key notice:

- `typesafe` (the block's name before 0.14.0 renamed it to `classifier`) — move its thresholds to `classifier`. The key was deprecated on arrival in 0.14.0, so a config written for 0.13 or earlier has never seen a deprecation notice. The failure names the replacement because the schema alone would strip the unknown key silently and leave the reviewer on the defaults.
- `classifier.timeoutMs` — the reviewer timeout is the top-level `timeoutMs` on both lanes, and the nested key has had no effect since 0.14.0. It used to parse and be ignored; a silently ignored timeout is worse than a rejection.

Additive: the top-level `temperature` now also reaches the classifier lane (backends without a sampling knob, TypeSafe included, ignore it), and a classifier answer's token usage and catalog-priced cost land in the decision record's `usage` field instead of living only inside `rawReply`.
