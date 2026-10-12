---
"pi-permission-ai-guard": minor
---

**Breaking changes.** The classifier reviewer no longer accepts the direct System One provider object (`{ "type": "typesafe", "baseUrl": …, "apiKey": … }`), and the `@typesafe-ai/sdk` dependency is gone. Run the classifier lane through Pi instead: register the endpoint (Pi ships a TypeSafe provider; a System One-compatible endpoint can be a custom Pi classifier provider), then set `"modelType": "classifier"` on its string provider id.

A config still carrying the object provider fails the load with a named migration hint, for the primary and for each `fallbacks` entry. Endpoint URLs and keys now live in Pi, so nothing points the reviewer at an endpoint from the extension's own config, and the `TYPESAFE_BASE_URL` / `TYPESAFE_API_KEY` fallbacks are gone with the SDK. The lane's request and answer shapes, its failure classes, and its audit `rawReply` are Pi's now; behavior is otherwise unchanged.
